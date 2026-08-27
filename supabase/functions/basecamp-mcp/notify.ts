// supabase/functions/basecamp-mcp/notify.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentIdentity } from "./auth.ts";
import * as db from "./db.ts";
import {
  sendCommentCreatedEmail,
  sendCommentUpdatedEmail,
  sendThreadCreatedEmail,
  sendThreadUpdatedEmail,
  sendProjectCreatedEmail,
  sendProjectUpdatedEmail,
} from "../../../lib/mailer.ts";

export type NotifyEvent =
  | { type: "comment_created"; projectId: string; threadId: string; threadTitle: string; commentId: string; bodyMarkdown: string }
  | { type: "comment_updated"; threadId: string; commentId: string; bodyMarkdown: string }
  | { type: "thread_created"; projectId: string; threadId: string; threadTitle: string; bodyMarkdown: string }
  | { type: "thread_updated"; projectId: string; threadId: string; threadTitle: string; bodyMarkdown: string }
  | { type: "project_created"; projectId: string }
  | { type: "project_updated"; projectId: string };

export function notifyBestEffort(
  supabase: SupabaseClient,
  agent: AgentIdentity,
  event: NotifyEvent
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _Deno = typeof globalThis !== "undefined" ? (globalThis as any).Deno : undefined;
  const appUrl = (_Deno ? _Deno.env.get("APP_URL") : process.env.APP_URL) ?? "";

  const task = (async () => {
    try {
      // For comment_updated, resolve thread (and project_id) once; all others have projectId directly
      const threadP =
        event.type === "comment_updated"
          ? db.getThreadForNotification(supabase, event.threadId)
          : Promise.resolve(null);

      const projectIdP: Promise<string | null> =
        "projectId" in event
          ? Promise.resolve(event.projectId)
          : threadP.then((t) => t?.project_id ?? null);

      const profileP = db.getProfile(supabase, agent.client_id);

      const [resolvedProjectId, profile] = await Promise.all([projectIdP, profileP]);
      if (!resolvedProjectId) return;

      const recipients = await db.listProjectMemberRecipients(supabase, resolvedProjectId, null);

      if (recipients.length === 0) {
        console.info("mcp_notification_skipped", { type: event.type, reason: "no_recipients" });
        return;
      }

      const project = await db.getProjectForNotification(supabase, resolvedProjectId);
      if (!project) return;

      const actor = { name: profile?.name ?? "AI", email: "" };

      switch (event.type) {
        case "comment_created": {
          await sendCommentCreatedEmail({
            recipients,
            actor,
            project,
            thread: { id: event.threadId, title: event.threadTitle, bodyMarkdown: "" },
            threadUrl: `${appUrl}/${resolvedProjectId}/${event.threadId}`,
            comment: { id: event.commentId, bodyMarkdown: event.bodyMarkdown },
          });
          break;
        }
        case "comment_updated": {
          const thread = await threadP;
          if (!thread) return;
          await sendCommentUpdatedEmail({
            recipients,
            actor,
            project,
            thread: { id: thread.id, title: thread.title, bodyMarkdown: "" },
            threadUrl: `${appUrl}/${resolvedProjectId}/${thread.id}`,
            comment: { id: event.commentId, bodyMarkdown: event.bodyMarkdown },
          });
          break;
        }
        case "thread_created": {
          await sendThreadCreatedEmail({
            recipients,
            actor,
            project,
            thread: { id: event.threadId, title: event.threadTitle, bodyMarkdown: event.bodyMarkdown },
            threadUrl: `${appUrl}/${resolvedProjectId}/${event.threadId}`,
          });
          break;
        }
        case "thread_updated": {
          await sendThreadUpdatedEmail({
            recipients,
            actor,
            project,
            thread: { id: event.threadId, title: event.threadTitle, bodyMarkdown: event.bodyMarkdown },
            threadUrl: `${appUrl}/${resolvedProjectId}/${event.threadId}`,
          });
          break;
        }
        case "project_created": {
          await sendProjectCreatedEmail({
            recipients,
            actor,
            project,
            projectUrl: `${appUrl}/${resolvedProjectId}`,
          });
          break;
        }
        case "project_updated": {
          await sendProjectUpdatedEmail({
            recipients,
            actor,
            project,
            projectUrl: `${appUrl}/${resolvedProjectId}`,
          });
          break;
        }
      }

      console.info("mcp_notification_sent", { type: event.type, recipientCount: recipients.length });
    } catch (e) {
      console.error("mcp_notification_failed", { type: event.type, error: String(e), stack: e instanceof Error ? e.stack : undefined });
    }
  })();

  // Supabase Edge Runtime kills the isolate as soon as the tool response is
  // sent, so a floating promise never reaches Mailgun. waitUntil keeps the
  // isolate alive until the send finishes. No-op outside the edge runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime;
  if (typeof edgeRuntime?.waitUntil === "function") edgeRuntime.waitUntil(task);
}
