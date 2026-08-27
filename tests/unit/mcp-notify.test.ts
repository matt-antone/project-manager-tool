// tests/unit/mcp-notify.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as db from "../../supabase/functions/basecamp-mcp/db.ts";
import * as mailer from "../../lib/mailer.ts";

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

const mockSupabase = {} as any;
const agent = { client_id: "agent-1", role: "agent" };

const project = { id: "p-1", name: "Acme Site", project_code: "0001", client_code: "AC" };
const recipients = [{ email: "team@example.com", name: "Team" }];

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.WORKSPACE_DOMAIN = "example.com";
  process.env.APP_URL = "https://pm.example.com";
  vi.spyOn(db, "getProjectForNotification").mockResolvedValue(project);
  vi.spyOn(db, "listNotificationRecipients").mockResolvedValue(recipients);
  vi.spyOn(db, "listProjectMemberRecipients").mockResolvedValue(recipients);
  vi.spyOn(db, "getProfile").mockResolvedValue({ client_id: "agent-1", name: "HAL 9000" } as any);
  vi.spyOn(db, "getThreadForNotification").mockResolvedValue({ id: "t-1", title: "Kickoff", project_id: "p-1" });
});

describe("notifyBestEffort — event routing", () => {
  it("comment_created calls sendCommentCreatedEmail", async () => {
    const spy = vi.spyOn(mailer, "sendCommentCreatedEmail").mockResolvedValue({ skipped: false, recipientCount: 1 });
    const { notifyBestEffort } = await import("../../supabase/functions/basecamp-mcp/notify.ts");
    notifyBestEffort(mockSupabase, agent, {
      type: "comment_created",
      projectId: "p-1",
      threadId: "t-1",
      threadTitle: "Kickoff",
      commentId: "c-1",
      bodyMarkdown: "Hello",
    });
    await flush();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toMatchObject({
      actor: { name: "HAL 9000", email: "" },
      thread: { id: "t-1", title: "Kickoff" },
      comment: { id: "c-1", bodyMarkdown: "Hello" },
    });
  });

  it("comment_updated calls sendCommentUpdatedEmail and resolves thread via getThreadForNotification", async () => {
    const spy = vi.spyOn(mailer, "sendCommentUpdatedEmail").mockResolvedValue({ skipped: false, recipientCount: 1 });
    const { notifyBestEffort } = await import("../../supabase/functions/basecamp-mcp/notify.ts");
    notifyBestEffort(mockSupabase, agent, {
      type: "comment_updated",
      threadId: "t-1",
      commentId: "c-1",
      bodyMarkdown: "Updated content",
    });
    await flush();
    expect(db.getThreadForNotification).toHaveBeenCalledWith(mockSupabase, "t-1");
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toMatchObject({
      thread: { id: "t-1", title: "Kickoff" },
      comment: { id: "c-1", bodyMarkdown: "Updated content" },
    });
  });

  it("thread_created calls sendThreadCreatedEmail", async () => {
    const spy = vi.spyOn(mailer, "sendThreadCreatedEmail").mockResolvedValue({ skipped: false, recipientCount: 1 });
    const { notifyBestEffort } = await import("../../supabase/functions/basecamp-mcp/notify.ts");
    notifyBestEffort(mockSupabase, agent, {
      type: "thread_created",
      projectId: "p-1",
      threadId: "t-1",
      threadTitle: "Kickoff",
      bodyMarkdown: "",
    });
    await flush();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toMatchObject({
      thread: { id: "t-1", title: "Kickoff" },
    });
  });

  it("thread_updated calls sendThreadUpdatedEmail", async () => {
    const spy = vi.spyOn(mailer, "sendThreadUpdatedEmail").mockResolvedValue({ skipped: false, recipientCount: 1 });
    const { notifyBestEffort } = await import("../../supabase/functions/basecamp-mcp/notify.ts");
    notifyBestEffort(mockSupabase, agent, {
      type: "thread_updated",
      projectId: "p-1",
      threadId: "t-1",
      threadTitle: "Kickoff Updated",
      bodyMarkdown: "",
    });
    await flush();
    expect(spy).toHaveBeenCalledOnce();
  });

  it("project_created calls sendProjectCreatedEmail", async () => {
    const spy = vi.spyOn(mailer, "sendProjectCreatedEmail").mockResolvedValue({ skipped: false, recipientCount: 1 });
    const { notifyBestEffort } = await import("../../supabase/functions/basecamp-mcp/notify.ts");
    notifyBestEffort(mockSupabase, agent, { type: "project_created", projectId: "p-1" });
    await flush();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toMatchObject({
      projectUrl: "https://pm.example.com/p-1",
    });
  });

  it("project_updated calls sendProjectUpdatedEmail", async () => {
    const spy = vi.spyOn(mailer, "sendProjectUpdatedEmail").mockResolvedValue({ skipped: false, recipientCount: 1 });
    const { notifyBestEffort } = await import("../../supabase/functions/basecamp-mcp/notify.ts");
    notifyBestEffort(mockSupabase, agent, { type: "project_updated", projectId: "p-1" });
    await flush();
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe("notifyBestEffort — edge cases", () => {
  it("skips send and does not throw when recipient list is empty", async () => {
    vi.spyOn(db, "listProjectMemberRecipients").mockResolvedValue([]);
    const spy = vi.spyOn(mailer, "sendThreadCreatedEmail");
    const { notifyBestEffort } = await import("../../supabase/functions/basecamp-mcp/notify.ts");
    notifyBestEffort(mockSupabase, agent, {
      type: "thread_created",
      projectId: "p-1",
      threadId: "t-1",
      threadTitle: "Empty",
    });
    await flush();
    expect(spy).not.toHaveBeenCalled();
  });

  it("falls back to actor name 'AI' when getProfile returns null", async () => {
    vi.spyOn(db, "getProfile").mockResolvedValue(null);
    const spy = vi.spyOn(mailer, "sendProjectCreatedEmail").mockResolvedValue({ skipped: false, recipientCount: 1 });
    const { notifyBestEffort } = await import("../../supabase/functions/basecamp-mcp/notify.ts");
    notifyBestEffort(mockSupabase, agent, { type: "project_created", projectId: "p-1" });
    await flush();
    expect(spy.mock.calls[0][0].actor.name).toBe("AI");
  });

  it("catches and does not rethrow mailer errors", async () => {
    vi.spyOn(mailer, "sendProjectCreatedEmail").mockRejectedValue(new Error("Mailgun down"));
    const { notifyBestEffort } = await import("../../supabase/functions/basecamp-mcp/notify.ts");
    notifyBestEffort(mockSupabase, agent, { type: "project_created", projectId: "p-1" });
    await flush();
    // If we got here without throwing, the test passes
  });
});

describe("notifyBestEffort — edge runtime", () => {
  it("hands the send to EdgeRuntime.waitUntil so the isolate outlives the response", async () => {
    const waitUntil = vi.fn();
    (globalThis as any).EdgeRuntime = { waitUntil };
    try {
      vi.spyOn(mailer, "sendThreadCreatedEmail").mockResolvedValue({ skipped: false, recipientCount: 1 });
      const { notifyBestEffort } = await import("../../supabase/functions/basecamp-mcp/notify.ts");
      notifyBestEffort(mockSupabase, agent, {
        type: "thread_created",
        projectId: "p-1",
        threadId: "t-1",
        threadTitle: "Kickoff",
        bodyMarkdown: "Hello",
      });
      expect(waitUntil).toHaveBeenCalledOnce();
      await waitUntil.mock.calls[0][0];
      expect(mailer.sendThreadCreatedEmail).toHaveBeenCalledOnce();
    } finally {
      delete (globalThis as any).EdgeRuntime;
    }
  });
});
