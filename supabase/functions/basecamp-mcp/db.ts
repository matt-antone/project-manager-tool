// supabase/functions/basecamp-mcp/db.ts
import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Read ────────────────────────────────────────────────────────────────────

export async function listProjects(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, slug, description, deadline, status, tags, requestor, pm_note, created_at, clients(name)")
    .eq("archived", false)
    .neq("status", "billing")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data.map((p: any) => ({ ...p, client_name: p.clients?.name ?? null, clients: undefined }));
}

export type ListArchivedProjectsPage = {
  projects: Array<Record<string, unknown>>;
  limit: number;
  offset: number;
  /** Total rows matching filters (before limit/offset). Null if count unavailable. */
  total_matching: number | null;
};

/**
 * Paged archived projects for manual review/tagging loops. Excludes billing status.
 * Order: created_at descending (newest archived first).
 */
export async function listArchivedProjects(
  supabase: SupabaseClient,
  options?: { untagged_only?: boolean; limit?: number; offset?: number }
): Promise<ListArchivedProjectsPage> {
  const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);
  const offset = Math.max(options?.offset ?? 0, 0);

  let q = supabase
    .from("projects")
    .select("id, name, slug, description, deadline, status, tags, requestor, pm_note, created_at, archived, clients(name)", {
      count: "exact",
    })
    .eq("archived", true)
    .neq("status", "billing")
    .order("created_at", { ascending: false });

  if (options?.untagged_only) {
    // Empty text[] in Postgres; PostgREST encodes as JSON [].
    q = q.eq("tags", [] as string[]);
  }

  const end = offset + limit - 1;
  const { data, error, count } = await q.range(offset, end);
  if (error) throw error;

  const projects = (data ?? []).map((p: any) => ({
    ...p,
    client_name: p.clients?.name ?? null,
    clients: undefined,
  }));

  return {
    projects,
    limit,
    offset,
    total_matching: count ?? null,
  };
}

export async function getProject(supabase: SupabaseClient, projectId: string) {
  const { data: project, error } = await supabase
    .from("projects")
    .select("id, name, slug, description, deadline, status, archived, tags, requestor, pm_note, created_at, clients(id, name)")
    .eq("id", projectId)
    .single();
  if (error || !project) return null;

  const { data: threads } = await supabase
    .from("discussion_threads")
    .select("id, title, created_at, discussion_comments(count)")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(10);

  const { count: fileCount } = await supabase
    .from("project_files")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);

  return {
    project: { ...project, client: project.clients, clients: undefined },
    threads: (threads ?? []).map((t: any) => ({
      id: t.id,
      title: t.title,
      comment_count: t.discussion_comments?.[0]?.count ?? 0,
      created_at: t.created_at,
    })),
    file_count: fileCount ?? 0,
  };
}

export async function getThread(supabase: SupabaseClient, threadId: string) {
  const { data: thread, error } = await supabase
    .from("discussion_threads")
    .select("id, project_id, title, body_markdown, author_user_id, created_at, updated_at")
    .eq("id", threadId)
    .single();
  if (error || !thread) return null;

  const { data: comments } = await supabase
    .from("discussion_comments")
    .select("id, body_markdown, author_user_id, edited_at, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });

  const { data: threadFiles } = await supabase
    .from("project_files")
    .select("id, filename, mime_type, size_bytes, dropbox_file_id, comment_id, created_at")
    .eq("thread_id", threadId)
    .is("comment_id", null);

  const { data: commentFiles } = await supabase
    .from("project_files")
    .select("id, filename, mime_type, size_bytes, dropbox_file_id, comment_id, created_at")
    .eq("thread_id", threadId)
    .not("comment_id", "is", null);

  const filesByComment = new Map<string, any[]>();
  for (const f of commentFiles ?? []) {
    const arr = filesByComment.get(f.comment_id) ?? [];
    arr.push(f);
    filesByComment.set(f.comment_id, arr);
  }

  return {
    thread,
    comments: (comments ?? []).map((c: any) => ({
      ...c,
      files: filesByComment.get(c.id) ?? [],
    })),
    files: threadFiles ?? [],
  };
}

export async function listFiles(supabase: SupabaseClient, projectId: string, threadId?: string) {
  let query = supabase
    .from("project_files")
    .select("id, filename, mime_type, size_bytes, dropbox_file_id, thread_id, comment_id, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (threadId) query = query.eq("thread_id", threadId);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function getFile(supabase: SupabaseClient, fileId: string) {
  const { data, error } = await supabase
    .from("project_files")
    .select("id, project_id, filename, mime_type, size_bytes, dropbox_file_id, dropbox_path, checksum, thread_id, comment_id, uploader_user_id, created_at")
    .eq("id", fileId)
    .single();
  if (error || !data) return null;
  return data;
}

export async function searchContent(
  supabase: SupabaseClient,
  query: string,
  projectId?: string,
  limit = 20
) {
  const { data, error } = await supabase.rpc("mcp_search_content", {
    p_query: query,
    p_project_id: projectId ?? null,
    p_limit: Math.min(limit, 100),
  });
  if (error) throw error;
  return data;
}

// ─── Clients ─────────────────────────────────────────────────────────────────

export async function listClients(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, code, github_repos, domains, archived_at")
    .order("name", { ascending: true });
  if (error) throw error;
  return data;
}

export async function getClient(supabase: SupabaseClient, clientId: string) {
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, code, github_repos, domains, archived_at")
    .eq("id", clientId)
    .single();
  if (error || !data) return null;
  return data;
}

// ─── Write ───────────────────────────────────────────────────────────────────

export async function createProject(
  supabase: SupabaseClient,
  params: { name: string; description?: string | null; deadline?: string | null; business_client_id: string; tags?: string[] | null; requestor?: string | null; pm_note?: string | null },
  agentId: string
) {
  // Delegates to mcp_create_project (0034) so the project gets the same
  // project_code / seq / slug / storage identity as the app's create path.
  const projectsRoot = Deno.env.get("DROPBOX_PROJECTS_ROOT_FOLDER")?.trim();
  const { data, error } = await supabase.rpc("mcp_create_project", {
    p_name: params.name,
    p_created_by: agentId,
    p_client_id: params.business_client_id,
    p_description: params.description ?? null,
    p_deadline: params.deadline ?? null,
    p_tags: params.tags ?? [],
    p_requestor: params.requestor ?? null,
    p_pm_note: params.pm_note ?? null,
    ...(projectsRoot ? { p_projects_root: projectsRoot } : {}),
  });
  if (error) throw error;
  return data;
}

export async function updateProject(
  supabase: SupabaseClient,
  projectId: string,
  params: { name?: string | null; description?: string | null; deadline?: string | null; status?: string | null; archived?: boolean | null; tags?: string[] | null; requestor?: string | null; pm_note?: string | null }
) {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (params.name !== undefined) patch.name = params.name;
  if (params.description !== undefined) patch.description = params.description;
  if (params.deadline !== undefined) patch.deadline = params.deadline;
  if (params.status !== undefined) patch.status = params.status;
  if (params.archived !== undefined) patch.archived = params.archived;
  if (params.tags !== undefined) patch.tags = params.tags ?? []; // projects.tags is NOT NULL
  if (params.requestor !== undefined) patch.requestor = params.requestor;
  if (params.pm_note !== undefined) patch.pm_note = params.pm_note;

  const { data, error } = await supabase
    .from("projects")
    .update(patch)
    .eq("id", projectId)
    .select()
    .single();
  if (error || !data) return null;
  return data;
}

export async function createThread(
  supabase: SupabaseClient,
  params: { project_id: string; title: string; body_markdown: string; body_html: string },
  agentId: string
) {
  const { data, error } = await supabase
    .from("discussion_threads")
    .insert({
      project_id: params.project_id,
      title: params.title,
      body_markdown: params.body_markdown,
      body_html: params.body_html,
      author_user_id: agentId,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateThread(
  supabase: SupabaseClient,
  threadId: string,
  params: { title?: string; body_markdown?: string; body_html?: string }
) {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (params.title !== undefined) patch.title = params.title;
  if (params.body_markdown !== undefined) patch.body_markdown = params.body_markdown;
  if (params.body_html !== undefined) patch.body_html = params.body_html;

  const { data, error } = await supabase
    .from("discussion_threads")
    .update(patch)
    .eq("id", threadId)
    .select()
    .single();
  if (error || !data) return null;
  return data;
}

export async function createComment(
  supabase: SupabaseClient,
  params: { thread_id: string; body_markdown: string; body_html: string; project_id: string },
  agentId: string
) {
  const { data, error } = await supabase
    .from("discussion_comments")
    .insert({
      thread_id: params.thread_id,
      project_id: params.project_id,
      body_markdown: params.body_markdown,
      body_html: params.body_html,
      author_user_id: agentId,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateComment(
  supabase: SupabaseClient,
  commentId: string,
  params: { body_markdown: string; body_html: string }
) {
  const { data, error } = await supabase
    .from("discussion_comments")
    .update({
      body_markdown: params.body_markdown,
      body_html: params.body_html,
      edited_at: new Date().toISOString(),
    })
    .eq("id", commentId)
    .select()
    .single();
  if (error || !data) return null;
  return data;
}

// ─── Files ───────────────────────────────────────────────────────────────────

/** Dropbox folder a project's files live in. Null when the project has none yet. */
export async function getProjectStorageDir(
  supabase: SupabaseClient,
  projectId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("projects")
    .select("storage_project_dir")
    .eq("id", projectId)
    .single();
  if (error || !data) return null;
  return (data as { storage_project_dir: string | null }).storage_project_dir || null;
}

export async function createFile(
  supabase: SupabaseClient,
  params: {
    project_id: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    dropbox_file_id: string;
    dropbox_path: string;
    checksum: string;
    thread_id?: string;
    comment_id?: string;
  },
  agentId: string
) {
  const { data, error } = await supabase
    .from("project_files")
    .insert({
      project_id: params.project_id,
      filename: params.filename,
      mime_type: params.mime_type,
      size_bytes: params.size_bytes,
      dropbox_file_id: params.dropbox_file_id,
      dropbox_path: params.dropbox_path,
      checksum: params.checksum,
      thread_id: params.thread_id ?? null,
      comment_id: params.comment_id ?? null,
      uploader_user_id: agentId,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ─── Profiles ────────────────────────────────────────────────────────────────

export async function getProfile(supabase: SupabaseClient, clientId: string) {
  const { data, error } = await supabase
    .from("agent_profiles")
    .select("client_id, name, avatar_url, bio, preferences, created_at, updated_at")
    .eq("client_id", clientId)
    .single();
  if (error || !data) return null;
  return data;
}

export async function updateProfile(
  supabase: SupabaseClient,
  clientId: string,
  params: { name?: string; avatar_url?: string; bio?: string; preferences?: Record<string, unknown> }
) {
  // Fetch current preferences for key-merge
  const { data: current } = await supabase
    .from("agent_profiles")
    .select("preferences")
    .eq("client_id", clientId)
    .single();

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (params.name !== undefined) patch.name = params.name;
  if (params.avatar_url !== undefined) patch.avatar_url = params.avatar_url;
  if (params.bio !== undefined) patch.bio = params.bio;
  if (params.preferences !== undefined) {
    patch.preferences = { ...(current?.preferences ?? {}), ...params.preferences };
  }

  const { data, error } = await supabase
    .from("agent_profiles")
    .update(patch)
    .eq("client_id", clientId)
    .select()
    .single();
  if (error || !data) return null;
  return data;
}

// ─── Notification helpers ─────────────────────────────────────────────────────

import type { MailRecipient } from "../../../lib/mailer.ts";

export async function getProjectForNotification(
  supabase: SupabaseClient,
  projectId: string
): Promise<{ id: string; name: string; project_code: string | null; client_code: string | null } | null> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, project_code, clients(code)")
    .eq("id", projectId)
    .single();
  if (error || !data) return null;
  const clients = data.clients as unknown as { code: string } | { code: string }[] | null;
  const client_code = Array.isArray(clients) ? (clients[0]?.code ?? null) : (clients?.code ?? null);
  return {
    id: data.id as string,
    name: data.name as string,
    project_code: data.project_code as string | null,
    client_code,
  };
}

export async function listNotificationRecipients(
  supabase: SupabaseClient
): Promise<MailRecipient[]> {
  const { data, error } = await supabase
    .from("user_profiles")
    .select("email, first_name, last_name")
    .eq("active", true);
  if (error || !data) return [];
  return data.map((u: any) => ({
    email: u.email,
    name: [u.first_name, u.last_name].filter(Boolean).join(" ") || undefined,
  }));
}

export async function listProjectMemberRecipients(
  supabase: SupabaseClient,
  projectId: string,
  excludeUserId: string | null = null
): Promise<MailRecipient[]> {
  // Two queries rather than a `user_profiles!inner(...)` embed: project_members
  // has no foreign key to user_profiles, so PostgREST cannot resolve the join
  // (PGRST200) and every MCP notification silently resolved to zero recipients.
  // The app path (lib/repositories.ts) uses a raw SQL join, which needs no FK.
  const { data: members, error } = await supabase
    .from("project_members")
    .select("user_id")
    .eq("project_id", projectId);
  if (error) {
    console.error("list_project_members_failed", { projectId, error });
    return [];
  }
  const ids = (members ?? [])
    .map((row: { user_id: string }) => row.user_id)
    .filter((id) => id !== excludeUserId);
  if (ids.length === 0) return [];

  // is_legacy = false, not `!== true` — matches the app, which also drops NULL.
  const { data: profiles, error: profileError } = await supabase
    .from("user_profiles")
    .select("email, first_name, last_name")
    .in("id", ids)
    .eq("is_legacy", false)
    .not("email", "is", null);
  if (profileError) {
    console.error("list_member_profiles_failed", { projectId, error: profileError });
    return [];
  }

  return (profiles ?? []).map((profile: any) => ({
    email: profile.email as string,
    name: [profile.first_name, profile.last_name].filter(Boolean).join(" ") || null,
  } as MailRecipient));
}

export async function getThreadForNotification(
  supabase: SupabaseClient,
  threadId: string
): Promise<{ id: string; title: string; project_id: string } | null> {
  const { data, error } = await supabase
    .from("discussion_threads")
    .select("id, title, project_id")
    .eq("id", threadId)
    .single();
  if (error || !data) return null;
  return data as { id: string; title: string; project_id: string };
}

export async function getProjectHours(supabase: SupabaseClient, projectCode: string) {
  // Job codes are unique but not consistently uppercase in the data (e.g. Leve-0004),
  // so match case-insensitively. Wildcards are escaped so ilike stays an exact match.
  const pattern = projectCode.replace(/[%_\\]/g, (char) => `\\${char}`);
  const { data: project, error } = await supabase
    .from("projects")
    .select("id, name, project_code")
    .ilike("project_code", pattern)
    .maybeSingle();
  if (error) throw error;
  if (!project) return null;

  const { data, error: hoursError } = await supabase
    .from("project_user_hours")
    .select("hours, updated_at, user_profiles!inner(id, email, first_name, last_name)")
    .eq("project_id", project.id);
  if (hoursError) throw hoursError;

  const users = (data ?? [])
    .map((row: any) => {
      const profile = Array.isArray(row.user_profiles) ? row.user_profiles[0] : row.user_profiles;
      return {
        user_id: profile.id as string,
        name: [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.email,
        email: profile.email as string,
        hours: Number(row.hours),
        updated_at: row.updated_at as string,
      };
    })
    .sort((a, b) => b.hours - a.hours);

  return {
    project,
    users,
    total_hours: Math.round(users.reduce((sum, u) => sum + u.hours, 0) * 100) / 100,
  };
}
