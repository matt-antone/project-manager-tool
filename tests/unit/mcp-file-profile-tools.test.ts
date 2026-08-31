// tests/unit/mcp-file-profile-tools.test.ts
import { describe, it, expect, vi } from "vitest";
import * as db from "../../supabase/functions/basecamp-mcp/db.ts";
import { registerTools } from "../../supabase/functions/basecamp-mcp/tools.ts";
import * as dropbox from "../../supabase/functions/basecamp-mcp/dropbox.ts";

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

describe("create_file", () => {
  it("registers file metadata with agent as uploader", async () => {
    const spy = vi.spyOn(db, "createFile").mockResolvedValue({ id: "f-1" } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    const params = {
      project_id: "p-1",
      filename: "doc.pdf",
      mime_type: "application/pdf",
      size_bytes: 1024,
      dropbox_file_id: "id:abc",
      dropbox_path: "/test-uploads/p-1/doc.pdf",
      checksum: "sha256:abc",
    };
    await server.call("create_file", params);
    expect(spy).toHaveBeenCalledWith(expect.anything(), params, "mcp-test-client");
  });

  it("accepts optional thread_id and comment_id", async () => {
    const spy = vi.spyOn(db, "createFile").mockResolvedValue({ id: "f-2" } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    await server.call("create_file", {
      project_id: "p-1",
      filename: "img.png",
      mime_type: "image/png",
      size_bytes: 500,
      dropbox_file_id: "id:xyz",
      dropbox_path: "/test-uploads/p-1/img.png",
      checksum: "sha256:xyz",
      thread_id: "t-1",
      comment_id: "c-1",
    });
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ thread_id: "t-1", comment_id: "c-1" }),
      "mcp-test-client"
    );
  });
});

describe("get_my_profile", () => {
  it("returns the calling agent's profile", async () => {
    vi.spyOn(db, "getProfile").mockResolvedValue({
      client_id: "mcp-test-client",
      name: "Claude",
      bio: "AI assistant",
      preferences: {},
    } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    const result = await server.call("get_my_profile", {});
    const data = JSON.parse(result.content[0].text);
    expect(data.client_id).toBe("mcp-test-client");
    expect(data.name).toBe("Claude");
  });

  it("returns error when profile not found", async () => {
    vi.spyOn(db, "getProfile").mockResolvedValue(null);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    const result = await server.call("get_my_profile", {});
    expect(result.isError).toBe(true);
  });
});

describe("update_my_profile", () => {
  it("updates agent profile with provided fields", async () => {
    const spy = vi.spyOn(db, "updateProfile").mockResolvedValue({
      client_id: "mcp-test-client",
      name: "Claude Agent",
    } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    const result = await server.call("update_my_profile", { name: "Claude Agent" });
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      "mcp-test-client",
      expect.objectContaining({ name: "Claude Agent" })
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.name).toBe("Claude Agent");
  });
});

describe("download_file", () => {
  const smallFile = {
    id: "f-1",
    project_id: "p-1",
    filename: "readme.txt",
    mime_type: "text/plain",
    size_bytes: 500,
    dropbox_file_id: "id:abc123",
    dropbox_path: "/projects/ACME/uploads/readme.txt",
    checksum: "sha256:aaa",
    thread_id: null,
    comment_id: null,
    uploader_user_id: "user-1",
    created_at: "2026-01-01",
  };

  const largeFile = {
    ...smallFile,
    id: "f-2",
    filename: "big-video.mp4",
    mime_type: "video/mp4",
    size_bytes: 5_000_000,
    dropbox_file_id: "id:xyz789",
  };

  it("returns base64 content for files <= 1MB", async () => {
    vi.spyOn(db, "getFile").mockResolvedValue(smallFile as any);
    const fileBytes = new TextEncoder().encode("hello world");
    vi.spyOn(dropbox, "downloadFile").mockResolvedValue({
      bytes: fileBytes,
      contentType: "text/plain",
    });
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    const result = await server.call("download_file", { file_id: "f-1" });
    const data = JSON.parse(result.content[0].text);
    expect(data.filename).toBe("readme.txt");
    expect(data.mime_type).toBe("text/plain");
    expect(data.size_bytes).toBe(500);
    expect(data.content_base64).toBeDefined();
    expect(data.download_url).toBeUndefined();
    const decoded = atob(data.content_base64);
    expect(decoded).toBe("hello world");
  });

  it("returns download URL for files > 1MB", async () => {
    vi.spyOn(db, "getFile").mockResolvedValue(largeFile as any);
    vi.spyOn(dropbox, "getTemporaryLink").mockResolvedValue("https://dl.dropbox.com/temp-link");
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    const result = await server.call("download_file", { file_id: "f-2" });
    const data = JSON.parse(result.content[0].text);
    expect(data.filename).toBe("big-video.mp4");
    expect(data.download_url).toBe("https://dl.dropbox.com/temp-link");
    expect(data.expires_in_seconds).toBe(14400);
    expect(data.content_base64).toBeUndefined();
  });

  it("prefers dropbox_file_id over dropbox_path", async () => {
    vi.spyOn(db, "getFile").mockResolvedValue(smallFile as any);
    const dlSpy = vi.spyOn(dropbox, "downloadFile").mockResolvedValue({
      bytes: new Uint8Array(0),
      contentType: "text/plain",
    });
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    await server.call("download_file", { file_id: "f-1" });
    expect(dlSpy).toHaveBeenCalledWith("id:abc123");
  });

  it("falls back to dropbox_path when dropbox_file_id is empty", async () => {
    const fileNoId = { ...smallFile, dropbox_file_id: "" };
    vi.spyOn(db, "getFile").mockResolvedValue(fileNoId as any);
    const dlSpy = vi.spyOn(dropbox, "downloadFile").mockResolvedValue({
      bytes: new Uint8Array(0),
      contentType: "text/plain",
    });
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    await server.call("download_file", { file_id: "f-1" });
    expect(dlSpy).toHaveBeenCalledWith("/projects/ACME/uploads/readme.txt");
  });

  it("returns error when file not found", async () => {
    vi.spyOn(db, "getFile").mockResolvedValue(null);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    const result = await server.call("download_file", { file_id: "bad-id" });
    expect(result.isError).toBe(true);
  });

  it("returns safe error when Dropbox credentials are missing", async () => {
    vi.spyOn(db, "getFile").mockResolvedValue(smallFile as any);
    vi.spyOn(dropbox, "downloadFile").mockRejectedValue(
      new dropbox.DropboxConfigError()
    );
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    const result = await server.call("download_file", { file_id: "f-1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("File download not configured — Dropbox credentials missing");
  });

  it("returns safe error on Dropbox storage errors", async () => {
    vi.spyOn(db, "getFile").mockResolvedValue(smallFile as any);
    vi.spyOn(dropbox, "downloadFile").mockRejectedValue(
      new dropbox.DropboxStorageError("File not found in storage")
    );
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    const result = await server.call("download_file", { file_id: "f-1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("File not found in storage");
  });

  it("does not expose dropbox_path or dropbox_file_id in response", async () => {
    vi.spyOn(db, "getFile").mockResolvedValue(smallFile as any);
    vi.spyOn(dropbox, "downloadFile").mockResolvedValue({
      bytes: new Uint8Array(0),
      contentType: "text/plain",
    });
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    const result = await server.call("download_file", { file_id: "f-1" });
    const text = result.content[0].text;
    expect(text).not.toContain("dropbox_path");
    expect(text).not.toContain("dropbox_file_id");
    expect(text).not.toContain("id:abc123");
    expect(text).not.toContain("/projects/ACME/uploads/readme.txt");
  });
});

describe("upload_file", () => {
  const thread = { thread: { id: "t-1", project_id: "p-1", title: "T" }, comments: [], files: [] };

  function stubStorage() {
    vi.spyOn(db, "getProjectStorageDir").mockResolvedValue("/projects/ACME/ACME-0001-Site");
    return vi.spyOn(dropbox, "uploadFile").mockResolvedValue({
      fileId: "id:new",
      pathDisplay: "/projects/ACME/ACME-0001-Site/uploads/notes.txt",
      size: 11,
      contentHash: "hash-1",
    });
  }

  it("uploads bytes into the project's uploads folder and registers the file on a thread", async () => {
    const upSpy = stubStorage();
    vi.spyOn(db, "getThread").mockResolvedValue(thread as any);
    const createSpy = vi.spyOn(db, "createFile").mockResolvedValue({ id: "f-9" } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);

    const result = await server.call("upload_file", {
      project_id: "p-1",
      filename: "notes.txt",
      content_base64: btoa("hello world"),
      mime_type: "text/plain",
      thread_id: "t-1",
    });

    expect(upSpy).toHaveBeenCalledWith(
      "/projects/ACME/ACME-0001-Site/uploads/notes.txt",
      new TextEncoder().encode("hello world")
    );
    expect(createSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        project_id: "p-1",
        filename: "notes.txt",
        mime_type: "text/plain",
        size_bytes: 11,
        dropbox_file_id: "id:new",
        checksum: "hash-1",
        thread_id: "t-1",
      }),
      "mcp-test-client"
    );
    expect(JSON.parse(result.content[0].text).id).toBe("f-9");
  });

  it("rejects a thread from another project", async () => {
    stubStorage();
    vi.spyOn(db, "getThread").mockResolvedValue({ ...thread, thread: { ...thread.thread, project_id: "p-2" } } as any);
    const createSpy = vi.spyOn(db, "createFile").mockResolvedValue({ id: "f-x" } as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);

    const result = await server.call("upload_file", {
      project_id: "p-1",
      filename: "notes.txt",
      content_base64: btoa("hi"),
      thread_id: "t-1",
    });
    expect(result.isError).toBe(true);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("errors when the project has no storage folder", async () => {
    vi.spyOn(db, "getProjectStorageDir").mockResolvedValue(null);
    const upSpy = vi.spyOn(dropbox, "uploadFile").mockResolvedValue({} as any);
    const server = mockServer();
    registerTools(server as any, {} as any, agent);

    const result = await server.call("upload_file", {
      project_id: "p-1",
      filename: "notes.txt",
      content_base64: btoa("hi"),
    });
    expect(result.isError).toBe(true);
    expect(upSpy).not.toHaveBeenCalled();
  });

  it("rejects comment_id without thread_id", async () => {
    const server = mockServer();
    registerTools(server as any, {} as any, agent);
    const result = await server.call("upload_file", {
      project_id: "p-1",
      filename: "notes.txt",
      content_base64: btoa("hi"),
      comment_id: "c-1",
    });
    expect(result.isError).toBe(true);
  });
});
