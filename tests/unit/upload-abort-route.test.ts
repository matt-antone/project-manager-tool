import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const getProjectMock = vi.fn();
const assertClientNotArchivedForMutationMock = vi.fn();
const getFileByDropboxPathMock = vi.fn();
const getProjectStorageDirMock = vi.fn();
const deleteByPathMock = vi.fn();

vi.mock("@/lib/auth", () => ({ requireUser: requireUserMock }));
vi.mock("@/lib/repositories", () => ({
  getProject: getProjectMock,
  assertClientNotArchivedForMutation: assertClientNotArchivedForMutationMock,
  getFileByDropboxPath: getFileByDropboxPathMock
}));
vi.mock("@/lib/project-storage", () => ({
  getProjectStorageDir: getProjectStorageDirMock
}));
vi.mock("@/lib/storage/dropbox-adapter", () => ({
  DropboxStorageAdapter: class {
    deleteByPath = deleteByPathMock;
  }
}));

const PROJECT = { id: "project-1", client_id: "11111111-1111-1111-8111-111111111111" };
const STORAGE_DIR = "/Projects/ACME/ACME-0001-Brief";
const TARGET_PATH = `${STORAGE_DIR}/uploads/cover.jpg`;

function makeRequest(body: unknown) {
  return new Request("http://localhost/projects/project-1/files/upload-abort", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /projects/[id]/files/upload-abort", () => {
  beforeEach(() => {
    vi.resetModules();
    [requireUserMock, getProjectMock, assertClientNotArchivedForMutationMock, getFileByDropboxPathMock, getProjectStorageDirMock, deleteByPathMock]
      .forEach((m) => m.mockReset());
    getProjectStorageDirMock.mockReturnValue(STORAGE_DIR);
    requireUserMock.mockResolvedValue({ id: "user-1" });
    getProjectMock.mockResolvedValue(PROJECT);
    assertClientNotArchivedForMutationMock.mockResolvedValue(undefined);
  });

  it("deletes the orphaned Dropbox file when no DB row tracks it", async () => {
    getFileByDropboxPathMock.mockResolvedValue(null);
    deleteByPathMock.mockResolvedValue(undefined);

    const { POST } = await import("@/app/projects/[id]/files/upload-abort/route");
    const res = await POST(makeRequest({ targetPath: TARGET_PATH }), { params: Promise.resolve({ id: "project-1" }) });

    expect(res.status).toBe(200);
    expect(deleteByPathMock).toHaveBeenCalledWith(TARGET_PATH);
  });

  it("refuses to delete a path that a project_files row tracks", async () => {
    getFileByDropboxPathMock.mockResolvedValue({ id: "row-1" });

    const { POST } = await import("@/app/projects/[id]/files/upload-abort/route");
    const res = await POST(makeRequest({ targetPath: TARGET_PATH }), { params: Promise.resolve({ id: "project-1" }) });

    expect(res.status).toBe(409);
    expect(deleteByPathMock).not.toHaveBeenCalled();
  });

  it("returns 403 when targetPath is outside the project storage prefix", async () => {
    const { POST } = await import("@/app/projects/[id]/files/upload-abort/route");
    const res = await POST(
      makeRequest({ targetPath: "/Projects/OTHER/uploads/leak.jpg" }),
      { params: Promise.resolve({ id: "project-1" }) }
    );

    expect(res.status).toBe(403);
    expect(getFileByDropboxPathMock).not.toHaveBeenCalled();
    expect(deleteByPathMock).not.toHaveBeenCalled();
  });

  it("returns 409 when the client is archived", async () => {
    assertClientNotArchivedForMutationMock.mockRejectedValue(new Error("Client is archived. Restore it before modifying files."));
    const { POST } = await import("@/app/projects/[id]/files/upload-abort/route");
    const res = await POST(makeRequest({ targetPath: TARGET_PATH }), { params: Promise.resolve({ id: "project-1" }) });
    expect(res.status).toBe(409);
    expect(deleteByPathMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the project does not exist", async () => {
    getProjectMock.mockResolvedValue(null);
    const { POST } = await import("@/app/projects/[id]/files/upload-abort/route");
    const res = await POST(makeRequest({ targetPath: TARGET_PATH }), { params: Promise.resolve({ id: "project-1" }) });
    expect(res.status).toBe(404);
  });

  it("returns 401 when requireUser throws", async () => {
    requireUserMock.mockRejectedValue(new Error("Missing auth token"));
    const { POST } = await import("@/app/projects/[id]/files/upload-abort/route");
    const res = await POST(makeRequest({ targetPath: TARGET_PATH }), { params: Promise.resolve({ id: "project-1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 400 for a missing targetPath", async () => {
    const { POST } = await import("@/app/projects/[id]/files/upload-abort/route");
    const res = await POST(makeRequest({}), { params: Promise.resolve({ id: "project-1" }) });
    expect(res.status).toBe(400);
  });
});
