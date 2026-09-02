// supabase/functions/basecamp-mcp/tools.ts
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentIdentity } from "./auth.ts";
import * as db from "./db.ts";
import * as dropbox from "./dropbox.ts";
import { marked } from "marked";
import { PROJECT_STATUSES_ZOD } from "../../../lib/project-status.ts";
import { notifyBestEffort } from "./notify.ts";

interface ToolServer {
  tool<S extends Record<string, z.ZodTypeAny>>(
    name: string,
    description: string,
    shape: S,
    handler: (args: z.output<z.ZodObject<S>>) => Promise<unknown>
  ): void;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function notFound(id: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: `Not found: ${id}` }] };
}

function toolError(text: string) {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

function dbError(e: unknown) {
  // Surface the Postgres message/code — a bare "Database error" left agents
  // guessing at constraint failures they had no way to see.
  const err = e as { message?: string; code?: string; details?: string; hint?: string } | null;
  const detail = [err?.message, err?.details, err?.hint].filter(Boolean).join(" — ");
  const text = detail
    ? `Database error${err?.code ? ` [${err.code}]` : ""}: ${detail}`
    : "Database error";
  console.error("basecamp-mcp db error", e);
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

function dropboxError(e: unknown) {
  if (e instanceof dropbox.DropboxConfigError) {
    return { isError: true as const, content: [{ type: "text" as const, text: "File download not configured — Dropbox credentials missing" }] };
  }
  if (e instanceof dropbox.DropboxStorageError) {
    return { isError: true as const, content: [{ type: "text" as const, text: e.message }] };
  }
  if (e instanceof dropbox.DropboxAuthError) {
    return { isError: true as const, content: [{ type: "text" as const, text: "Dropbox authentication failed" }] };
  }
  return { isError: true as const, content: [{ type: "text" as const, text: "Storage error" }] };
}

async function toHtml(markdown: string): Promise<string> {
  return await marked(markdown);
}

export function registerTools(
  server: ToolServer,
  supabase: SupabaseClient,
  agent: AgentIdentity
): void {

  function safeNotify(event: import("./notify.ts").NotifyEvent) {
    try { notifyBestEffort(supabase, agent, event); } catch { /* best-effort */ }
  }

  // ─── Read ─────────────────────────────────────────────────────────────────

  server.tool(
    "list_projects",
    "List all non-archived projects with name, slug, description, deadline, status, and client name.",
    {},
    async () => {
      try {
        return ok(await db.listProjects(supabase));
      } catch (e) {
        return dbError(e);
      }
    }
  );

  server.tool(
    "list_archived_projects",
    "Paged list of archived projects (excludes billing), newest first. Default limit 20 — use offset 0, 20, 40, … for batches. Set untagged_only to narrow to empty tags. Response includes total_matching for loop planning; then get_project + get_thread per id for context, update_project for tags.",
    {
      untagged_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).max(500_000).optional(),
    },
    async (opts) => {
      try {
        return ok(await db.listArchivedProjects(supabase, opts));
      } catch (e) {
        return dbError(e);
      }
    }
  );

  server.tool(
    "get_project",
    "Get full project detail: metadata, last 10 threads with comment counts, total file count, and client info.",
    { project_id: z.string().uuid() },
    async ({ project_id }) => {
      try {
        const result = await db.getProject(supabase, project_id);
        if (!result) return notFound(project_id);
        return ok(result);
      } catch (e) {
        return dbError(e);
      }
    }
  );

  server.tool(
    "get_project_hours",
    "Get hours logged per user on a project, looked up by its XXX-NNNN job code (e.g. AATA-0001), plus the project total.",
    { project_code: z.string() },
    async ({ project_code }) => {
      try {
        const result = await db.getProjectHours(supabase, project_code.trim());
        if (!result) return notFound(project_code);
        return ok(result);
      } catch (e) {
        return dbError(e);
      }
    }
  );

  server.tool(
    "get_thread",
    "Get a full thread with title, body, all comments in order, and files attached to the thread or its comments.",
    { thread_id: z.string().uuid() },
    async ({ thread_id }) => {
      try {
        const result = await db.getThread(supabase, thread_id);
        if (!result) return notFound(thread_id);
        return ok(result);
      } catch (e) {
        return dbError(e);
      }
    }
  );

  server.tool(
    "list_files",
    "List files for a project. Pass thread_id to filter to files attached to a specific thread.",
    { project_id: z.string().uuid(), thread_id: z.string().uuid().optional() },
    async ({ project_id, thread_id }) => {
      try {
        return ok(await db.listFiles(supabase, project_id, thread_id));
      } catch (e) {
        return dbError(e);
      }
    }
  );

  server.tool(
    "get_file",
    "Get full metadata for a single file including dropbox_path, checksum, and thread/comment attachment.",
    { file_id: z.string().uuid() },
    async ({ file_id }) => {
      try {
        const result = await db.getFile(supabase, file_id);
        if (!result) return notFound(file_id);
        return ok(result);
      } catch (e) {
        return dbError(e);
      }
    }
  );

  server.tool(
    "search_content",
    "Full-text search across discussion threads and comments. Optionally scope to a project. limit defaults to 20, max 100.",
    {
      query: z.string().min(1),
      project_id: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ query, project_id, limit }) => {
      try {
        return ok(await db.searchContent(supabase, query, project_id, limit));
      } catch (e) {
        return dbError(e);
      }
    }
  );

  // ─── Clients ────────────────────────────────────────────────────────────

  server.tool(
    "list_clients",
    "List all clients with name, code, domains, and archive status.",
    {},
    async () => {
      try {
        return ok(await db.listClients(supabase));
      } catch (e) {
        return dbError(e);
      }
    }
  );

  server.tool(
    "get_client",
    "Get a single client by ID including name, code, domains, github_repos, and archive status.",
    { client_id: z.string().uuid() },
    async ({ client_id }) => {
      try {
        const result = await db.getClient(supabase, client_id);
        if (!result) return notFound(client_id);
        return ok(result);
      } catch (e) {
        return dbError(e);
      }
    }
  );

  // ─── Write ──────────────────────────────────────────────────────────────

  server.tool(
    "create_project",
    "Create a new project. business_client_id is required — it is the UUID of a row in the clients table (list_clients), and the project code/slug are derived from it. There is no way to attach a client afterwards.",
    {
      name: z.string().min(1),
      description: z.string().nullish(),
      deadline: z.string().date().nullish(),
      business_client_id: z.string().uuid(),
      tags: z.array(z.string()).nullish(),
      requestor: z.string().nullish(),
      pm_note: z.string().nullish(),
    },
    async (params) => {
      try {
        const result = await db.createProject(supabase, params, agent.client_id);
        safeNotify({ type: "project_created", projectId: result.id });
        return ok(result);
      } catch (e) {
        return dbError(e);
      }
    }
  );

  server.tool(
    "update_project",
    "Update mutable project fields. Only provided fields are changed. status must be one of: new, in_progress, blocked, complete, billing.",
    {
      project_id: z.string().uuid(),
      name: z.string().min(1).nullish(),
      description: z.string().nullish(),
      deadline: z.string().date().nullish(),
      status: z.enum(PROJECT_STATUSES_ZOD).nullish(),
      archived: z.boolean().nullish(),
      tags: z.array(z.string()).nullish(),
      requestor: z.string().nullish(),
      pm_note: z.string().nullish(),
    },
    async ({ project_id, ...params }) => {
      try {
        const result = await db.updateProject(supabase, project_id, params);
        if (!result) return notFound(project_id);
        safeNotify({ type: "project_updated", projectId: result.id });
        return ok(result);
      } catch (e) {
        return dbError(e);
      }
    }
  );

  server.tool(
    "create_thread",
    "Create a discussion thread in a project. body_markdown is converted to HTML automatically.",
    {
      project_id: z.string().uuid(),
      title: z.string().min(1),
      body_markdown: z.string().min(1),
    },
    async ({ project_id, title, body_markdown }) => {
      try {
        const body_html = await toHtml(body_markdown);
        const result = await db.createThread(supabase, { project_id, title, body_markdown, body_html }, agent.client_id);
        safeNotify({ type: "thread_created", projectId: result.project_id, threadId: result.id, threadTitle: result.title, bodyMarkdown: body_markdown });
        return ok(result);
      } catch (e) {
        return dbError(e);
      }
    }
  );

  server.tool(
    "update_thread",
    "Update a thread's title and/or body. Body markdown is re-converted to HTML.",
    {
      thread_id: z.string().uuid(),
      title: z.string().min(1).optional(),
      body_markdown: z.string().min(1).optional(),
    },
    async ({ thread_id, title, body_markdown }) => {
      try {
        const patch: Record<string, string | undefined> = { title };
        if (body_markdown) {
          patch.body_markdown = body_markdown;
          patch.body_html = await toHtml(body_markdown);
        }
        const result = await db.updateThread(supabase, thread_id, patch);
        if (!result) return notFound(thread_id);
        safeNotify({ type: "thread_updated", projectId: result.project_id, threadId: result.id, threadTitle: result.title ?? title ?? "", bodyMarkdown: body_markdown ?? "" });
        return ok(result);
      } catch (e) {
        return dbError(e);
      }
    }
  );

  server.tool(
    "create_comment",
    "Add a comment to a thread. body_markdown is converted to HTML automatically.",
    {
      thread_id: z.string().uuid(),
      body_markdown: z.string().min(1),
    },
    async ({ thread_id, body_markdown }) => {
      try {
        const thread = await db.getThread(supabase, thread_id);
        if (!thread) return notFound(thread_id);
        const body_html = await toHtml(body_markdown);
        const result = await db.createComment(
          supabase,
          { thread_id, body_markdown, body_html, project_id: thread.thread.project_id },
          agent.client_id
        );
        safeNotify({ type: "comment_created", projectId: thread.thread.project_id, threadId: thread_id, threadTitle: thread.thread.title, commentId: result.id, bodyMarkdown: body_markdown });
        return ok(result);
      } catch (e) {
        return dbError(e);
      }
    }
  );

  server.tool(
    "update_comment",
    "Edit a comment's body. Sets edited_at to current timestamp. body_markdown is re-converted to HTML.",
    {
      comment_id: z.string().uuid(),
      body_markdown: z.string().min(1),
    },
    async ({ comment_id, body_markdown }) => {
      try {
        const body_html = await toHtml(body_markdown);
        const result = await db.updateComment(supabase, comment_id, { body_markdown, body_html });
        if (!result) return notFound(comment_id);
        safeNotify({ type: "comment_updated", threadId: result.thread_id, commentId: result.id, bodyMarkdown: body_markdown });
        return ok(result);
      } catch (e) {
        return dbError(e);
      }
    }
  );

  // ─── Files ──────────────────────────────────────────────────────────────

  server.tool(
    "create_file",
    "Register file metadata after uploading bytes to Dropbox. Optionally attach to a thread or comment.",
    {
      project_id: z.string().uuid(),
      filename: z.string().min(1),
      mime_type: z.string().min(1),
      size_bytes: z.number().int().positive(),
      dropbox_file_id: z.string().min(1),
      dropbox_path: z.string().min(1),
      checksum: z.string().min(1),
      thread_id: z.string().uuid().optional(),
      comment_id: z.string().uuid().optional(),
    },
    async (params) => {
      try {
        return ok(await db.createFile(supabase, params, agent.client_id));
      } catch (e) {
        return dbError(e);
      }
    }
  );

  // Inline base64 costs an agent ~1.4 tokens per byte, so it is only viable for tiny files.
  // Anything real goes through create_upload_link -> POST bytes to Dropbox -> upload_file{target_path},
  // which is the same temporary-upload-link flow the web app uses.
  const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

  function sanitizeUploadName(filename: string): string {
    return (filename.split("/").pop() ?? "")
      .replace(/[\\:*?"<>|]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** `<storage_project_dir>/uploads`, or null when the project has no storage folder. */
  async function uploadsDirFor(project_id: string): Promise<string | null> {
    const dir = await db.getProjectStorageDir(supabase, project_id);
    return dir ? `${dir.replace(/\/+$/, "")}/uploads` : null;
  }

  function storageOrDbError(e: unknown) {
    if (
      e instanceof dropbox.DropboxConfigError ||
      e instanceof dropbox.DropboxStorageError ||
      e instanceof dropbox.DropboxAuthError
    ) {
      return dropboxError(e);
    }
    return dbError(e);
  }

  server.tool(
    "create_upload_link",
    "Step 1 of 2 for uploading a file of any size. Returns a temporary Dropbox upload_url (valid ~4 hours) and the target_path it commits to. POST the file's raw bytes to upload_url with Content-Type: application/octet-stream (e.g. `curl -X POST <upload_url> --data-binary @file.pdf -H 'Content-Type: application/octet-stream'`) — the bytes go straight to storage and never pass through this conversation. Then call upload_file with that exact target_path to register the file and attach it to a thread. Use this for anything but tiny files.",
    {
      project_id: z.string().uuid(),
      filename: z.string().min(1).max(255),
    },
    async ({ project_id, filename }) => {
      const name = sanitizeUploadName(filename);
      if (!name) return toolError("Invalid filename");
      try {
        const uploadsDir = await uploadsDirFor(project_id);
        if (!uploadsDir) return toolError(`Project ${project_id} has no storage folder — upload through the web app instead.`);
        const target_path = await dropbox.resolveAvailableUploadPath(uploadsDir, name);
        const upload_url = await dropbox.getTemporaryUploadLink(target_path);
        return ok({
          upload_url,
          target_path,
          expires_in_seconds: 14400,
          next_step: "POST the raw bytes to upload_url, then call upload_file with this target_path.",
        });
      } catch (e) {
        return storageOrDbError(e);
      }
    }
  );

  server.tool(
    "upload_file",
    "Register a file on a project, and optionally attach it to a thread (thread_id) or comment (comment_id, which requires thread_id). Provide the bytes one of two ways: target_path — the path returned by create_upload_link, after you have POSTed the bytes to its upload_url (use this for any real file, no size limit); or content_base64 — the bytes inline, base64-encoded, capped at 10MB and only sensible for very small files since base64 costs roughly 1.4 tokens per byte. Give exactly one of the two.",
    {
      project_id: z.string().uuid(),
      filename: z.string().min(1).max(255).optional(),
      target_path: z.string().min(1).max(1024).optional(),
      content_base64: z.string().min(1).optional(),
      mime_type: z.string().min(1).optional(),
      thread_id: z.string().uuid().optional(),
      comment_id: z.string().uuid().optional(),
    },
    async ({ project_id, filename, target_path, content_base64, mime_type, thread_id, comment_id }) => {
      if (comment_id && !thread_id) return toolError("comment_id requires thread_id");
      if (!target_path === !content_base64) {
        return toolError("Provide exactly one of target_path (after create_upload_link) or content_base64.");
      }
      if (content_base64 && !filename) return toolError("filename is required with content_base64");

      try {
        if (thread_id) {
          const thread = await db.getThread(supabase, thread_id);
          if (!thread) return notFound(thread_id);
          if (thread.thread.project_id !== project_id) {
            return toolError("thread_id belongs to a different project");
          }
        }

        const uploadsDir = await uploadsDirFor(project_id);
        if (!uploadsDir) return toolError(`Project ${project_id} has no storage folder — upload through the web app instead.`);

        let stored: { fileId: string; pathDisplay: string; size: number; contentHash: string };

        if (target_path) {
          // Path attribution: a caller must not register bytes sitting outside this project's folder.
          if (!target_path.startsWith(`${uploadsDir}/`)) {
            return toolError("target_path is outside this project's uploads folder");
          }
          stored = await dropbox.getFileMetadata(target_path);
          if (!stored.pathDisplay.startsWith(`${uploadsDir}/`)) {
            return toolError("target_path is outside this project's uploads folder");
          }
        } else {
          const name = sanitizeUploadName(filename!);
          if (!name) return toolError("Invalid filename");
          let bytes: Uint8Array;
          try {
            const binary = atob(content_base64!.replace(/\s+/g, ""));
            bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          } catch {
            return toolError("content_base64 is not valid base64");
          }
          if (bytes.length === 0) return toolError("File is empty");
          if (bytes.length > UPLOAD_MAX_BYTES) {
            return toolError(`File is ${bytes.length} bytes; the inline limit is ${UPLOAD_MAX_BYTES}. Use create_upload_link for files of any size.`);
          }
          stored = await dropbox.uploadFile(`${uploadsDir}/${name}`, bytes);
        }

        return ok(
          await db.createFile(
            supabase,
            {
              project_id,
              filename: stored.pathDisplay.split("/").pop() ?? filename ?? "file",
              mime_type: mime_type ?? "application/octet-stream",
              size_bytes: stored.size,
              dropbox_file_id: stored.fileId,
              dropbox_path: stored.pathDisplay,
              checksum: stored.contentHash,
              thread_id,
              comment_id,
            },
            agent.client_id
          )
        );
      } catch (e) {
        return storageOrDbError(e);
      }
    }
  );

  const FILE_SIZE_INLINE_LIMIT = 1_048_576; // 1MB

  server.tool(
    "download_file",
    "Download file content or get a temporary link. Files ≤1MB return base64 content inline. Files >1MB return a temporary download URL valid ~4 hours.",
    { file_id: z.string().uuid() },
    async ({ file_id }) => {
      try {
        const file = await db.getFile(supabase, file_id);
        if (!file) return notFound(file_id);

        const target =
          typeof file.dropbox_file_id === "string" && file.dropbox_file_id.trim().length > 0
            ? file.dropbox_file_id
            : file.dropbox_path;

        if (file.size_bytes <= FILE_SIZE_INLINE_LIMIT) {
          const { bytes } = await dropbox.downloadFile(target);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const content_base64 = btoa(binary);
          return ok({
            filename: file.filename,
            mime_type: file.mime_type,
            size_bytes: file.size_bytes,
            content_base64,
          });
        } else {
          const download_url = await dropbox.getTemporaryLink(target);
          return ok({
            filename: file.filename,
            mime_type: file.mime_type,
            size_bytes: file.size_bytes,
            download_url,
            expires_in_seconds: 14400,
          });
        }
      } catch (e) {
        return dropboxError(e);
      }
    }
  );

  // ─── Profile ────────────────────────────────────────────────────────────

  server.tool(
    "get_my_profile",
    "Get the calling agent's profile: name, bio, avatar_url, preferences.",
    {},
    async () => {
      try {
        const result = await db.getProfile(supabase, agent.client_id);
        if (!result) return notFound(agent.client_id);
        return ok(result);
      } catch (e) {
        return dbError(e);
      }
    }
  );

  server.tool(
    "update_my_profile",
    "Update the agent's profile. preferences keys are merged — existing keys not mentioned are preserved.",
    {
      name: z.string().optional(),
      avatar_url: z.string().url().optional(),
      bio: z.string().optional(),
      preferences: z.record(z.string(), z.unknown()).optional(),
    },
    async (params) => {
      try {
        const result = await db.updateProfile(supabase, agent.client_id, params);
        if (!result) return notFound(agent.client_id);
        return ok(result);
      } catch (e) {
        return dbError(e);
      }
    }
  );
}
