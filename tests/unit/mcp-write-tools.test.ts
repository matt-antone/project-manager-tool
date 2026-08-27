// tests/unit/mcp-write-tools.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as db from "../../supabase/functions/basecamp-mcp/db.ts";
import { registerTools } from "../../supabase/functions/basecamp-mcp/tools.ts";
import * as notify from "../../supabase/functions/basecamp-mcp/notify.ts";

vi.stubGlobal("Deno", { env: { get: () => undefined } });

function mockServer() {
  const handlers = new Map<string, Function>();
  return {
    tool: vi.fn((name: string, _desc: string, _schema: any, handler: Function) => {
      handlers.set(name, handler);
    }),
    call: (name: string, params: any) => handlers.get(name)!(params),
  };
}

const agent = { client_id: "mcp-test-client", role: "agent" };

describe("create_project", () => {
  it("creates a project and stamps author_user_id from agent", async () => {
    const created = { id: "p-1", name: "New Project", created_by: "mcp-test-client" };
    const spy = vi.spyOn(db, "createProject").mockResolvedValue(created as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    const result = await server.call("create_project", { name: "New Project" });
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "New Project" }), "mcp-test-client");
    const data = JSON.parse(result.content[0].text);
    expect(data.name).toBe("New Project");
  });
});

describe("db.createProject", () => {
  // Regression: projects.tags is `not null default '{}'` (migration 0006), so
  // sending an explicit null failed every create with a bare "Database error".
  beforeEach(() => {
    vi.restoreAllMocks(); // earlier describes spy on db.createProject itself
  });

  function rpcSpy() {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "p-1" }, error: null });
    return { rpc, supabase: { rpc } as any };
  }

  it("never sends null tags", async () => {
    const { rpc, supabase } = rpcSpy();
    await db.createProject(supabase, { name: "New Project", business_client_id: "c-1" }, "mcp-test-client");
    expect(rpc).toHaveBeenCalledWith("mcp_create_project", expect.objectContaining({ p_tags: [] }));
  });

  it("passes the client through so the project gets a code", async () => {
    const { rpc, supabase } = rpcSpy();
    await db.createProject(
      supabase,
      { name: "New Project", business_client_id: "c-1", tags: ["cipa"] },
      "mcp-test-client"
    );
    expect(rpc).toHaveBeenCalledWith(
      "mcp_create_project",
      expect.objectContaining({ p_client_id: "c-1", p_tags: ["cipa"], p_created_by: "mcp-test-client" })
    );
  });
});

describe("update_project", () => {
  it("returns updated project", async () => {
    vi.spyOn(db, "updateProject").mockResolvedValue({ id: "p-1", name: "Renamed" } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    const result = await server.call("update_project", { project_id: "p-1", name: "Renamed" });
    const data = JSON.parse(result.content[0].text);
    expect(data.name).toBe("Renamed");
  });

  it("returns error when project not found", async () => {
    vi.spyOn(db, "updateProject").mockResolvedValue(null);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    const result = await server.call("update_project", { project_id: "bad-id" });
    expect(result.isError).toBe(true);
  });
});

describe("create_thread", () => {
  it("converts markdown to HTML before saving", async () => {
    const spy = vi.spyOn(db, "createThread").mockResolvedValue({ id: "t-1" } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    await server.call("create_thread", {
      project_id: "p-1",
      title: "Hello",
      body_markdown: "**bold**",
    });
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body_markdown: "**bold**", body_html: expect.stringContaining("<strong>") }),
      "mcp-test-client"
    );
  });
});

describe("update_thread", () => {
  it("converts updated markdown to HTML", async () => {
    const spy = vi.spyOn(db, "updateThread").mockResolvedValue({ id: "t-1" } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    await server.call("update_thread", { thread_id: "t-1", body_markdown: "_italic_" });
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      "t-1",
      expect.objectContaining({ body_html: expect.stringContaining("<em>") })
    );
  });
});

describe("create_comment", () => {
  it("looks up project_id from thread before inserting", async () => {
    vi.spyOn(db, "getThread").mockResolvedValue({
      thread: { id: "t-1", project_id: "proj-1" },
      comments: [],
      files: [],
    } as any);
    const spy = vi.spyOn(db, "createComment").mockResolvedValue({ id: "c-1" } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    await server.call("create_comment", { thread_id: "t-1", body_markdown: "hi" });
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ project_id: "proj-1" }),
      "mcp-test-client"
    );
  });
});

describe("update_comment", () => {
  it("returns error when comment not found", async () => {
    vi.spyOn(db, "updateComment").mockResolvedValue(null);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    const result = await server.call("update_comment", {
      comment_id: "bad",
      body_markdown: "new content",
    });
    expect(result.isError).toBe(true);
  });
});

describe("notifications: called on successful writes", () => {
  beforeEach(() => {
    vi.spyOn(notify, "notifyBestEffort").mockImplementation(() => {});
  });

  it("create_project calls notifyBestEffort with project_created", async () => {
    vi.spyOn(db, "createProject").mockResolvedValue({ id: "p-new" } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    await server.call("create_project", { name: "New" });
    expect(notify.notifyBestEffort).toHaveBeenCalledWith(
      expect.anything(),
      agent,
      expect.objectContaining({ type: "project_created", projectId: "p-new" })
    );
  });

  it("update_project calls notifyBestEffort with project_updated", async () => {
    vi.spyOn(db, "updateProject").mockResolvedValue({ id: "p-1" } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    await server.call("update_project", { project_id: "p-1", name: "Updated" });
    expect(notify.notifyBestEffort).toHaveBeenCalledWith(
      expect.anything(),
      agent,
      expect.objectContaining({ type: "project_updated", projectId: "p-1" })
    );
  });

  it("create_thread calls notifyBestEffort with thread_created", async () => {
    vi.spyOn(db, "createThread").mockResolvedValue({ id: "t-new", project_id: "p-1", title: "Hello" } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    await server.call("create_thread", { project_id: "p-1", title: "Hello", body_markdown: "body" });
    expect(notify.notifyBestEffort).toHaveBeenCalledWith(
      expect.anything(),
      agent,
      expect.objectContaining({ type: "thread_created", projectId: "p-1", threadId: "t-new", threadTitle: "Hello" })
    );
  });

  it("update_thread calls notifyBestEffort with thread_updated", async () => {
    vi.spyOn(db, "updateThread").mockResolvedValue({ id: "t-1", project_id: "p-1", title: "Updated Title" } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    await server.call("update_thread", { thread_id: "t-1", title: "Updated Title" });
    expect(notify.notifyBestEffort).toHaveBeenCalledWith(
      expect.anything(),
      agent,
      expect.objectContaining({ type: "thread_updated", projectId: "p-1", threadId: "t-1", threadTitle: "Updated Title" })
    );
  });

  it("create_comment calls notifyBestEffort with comment_created", async () => {
    vi.spyOn(db, "getThread").mockResolvedValue({
      thread: { id: "t-1", project_id: "p-1", title: "Kickoff" },
      comments: [],
      files: [],
    } as any);
    vi.spyOn(db, "createComment").mockResolvedValue({ id: "c-new" } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    await server.call("create_comment", { thread_id: "t-1", body_markdown: "Hi there" });
    expect(notify.notifyBestEffort).toHaveBeenCalledWith(
      expect.anything(),
      agent,
      expect.objectContaining({
        type: "comment_created",
        projectId: "p-1",
        threadId: "t-1",
        threadTitle: "Kickoff",
        commentId: "c-new",
        bodyMarkdown: "Hi there",
      })
    );
  });

  it("update_comment calls notifyBestEffort with comment_updated", async () => {
    vi.spyOn(db, "updateComment").mockResolvedValue({ id: "c-1", thread_id: "t-1" } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    await server.call("update_comment", { comment_id: "c-1", body_markdown: "Revised content" });
    expect(notify.notifyBestEffort).toHaveBeenCalledWith(
      expect.anything(),
      agent,
      expect.objectContaining({
        type: "comment_updated",
        threadId: "t-1",
        commentId: "c-1",
        bodyMarkdown: "Revised content",
      })
    );
  });
});

describe("notifications: NOT called when DB write returns null", () => {
  beforeEach(() => {
    vi.spyOn(notify, "notifyBestEffort").mockImplementation(() => {});
  });

  it("update_project does not notify when project not found", async () => {
    vi.spyOn(db, "updateProject").mockResolvedValue(null);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    await server.call("update_project", { project_id: "bad-id" });
    expect(notify.notifyBestEffort).not.toHaveBeenCalled();
  });

  it("update_thread does not notify when thread not found", async () => {
    vi.spyOn(db, "updateThread").mockResolvedValue(null);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    await server.call("update_thread", { thread_id: "bad-id", title: "X" });
    expect(notify.notifyBestEffort).not.toHaveBeenCalled();
  });

  it("update_comment does not notify when comment not found", async () => {
    vi.spyOn(db, "updateComment").mockResolvedValue(null);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    await server.call("update_comment", { comment_id: "bad-id", body_markdown: "X" });
    expect(notify.notifyBestEffort).not.toHaveBeenCalled();
  });
});

describe("notifications: tool succeeds even when notifyBestEffort throws", () => {
  beforeEach(() => {
    vi.spyOn(notify, "notifyBestEffort").mockImplementation(() => {
      throw new Error("notification boom");
    });
  });

  it("create_project returns success even when notifyBestEffort throws", async () => {
    vi.spyOn(db, "createProject").mockResolvedValue({ id: "p-1", name: "X" } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    const result = await server.call("create_project", { name: "X" });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBe("p-1");
  });

  it("create_comment returns success even when notifyBestEffort throws", async () => {
    vi.spyOn(db, "getThread").mockResolvedValue({
      thread: { id: "t-1", project_id: "p-1", title: "T" },
      comments: [],
      files: [],
    } as any);
    vi.spyOn(db, "createComment").mockResolvedValue({ id: "c-1" } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    const result = await server.call("create_comment", { thread_id: "t-1", body_markdown: "hi" });
    expect(result.isError).toBeUndefined();
  });
});
