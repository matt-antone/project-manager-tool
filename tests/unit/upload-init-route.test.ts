import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const getProjectMock = vi.fn();
const assertClientNotArchivedForMutationMock = vi.fn();
const getProjectStorageDirMock = vi.fn();
const getTemporaryUploadLinkMock = vi.fn();
const resolveAvailableUploadPathMock = vi.fn();

vi.mock("@/lib/auth", () => ({ requireUser: requireUserMock }));
vi.mock("@/lib/repositories", () => ({
  getProject: getProjectMock,
  assertClientNotArchivedForMutation: assertClientNotArchivedForMutationMock
}));
vi.mock("@/lib/project-storage", () => ({
  getProjectStorageDir: getProjectStorageDirMock
}));
vi.mock("@/lib/storage/dropbox-adapter", () => ({
  DropboxStorageAdapter: class {
    resolveAvailableUploadPath = resolveAvailableUploadPathMock;
    getTemporaryUploadLink = getTemporaryUploadLinkMock;
  }
}));

const PROJECT = { id: "project-1", client_id: "11111111-1111-1111-8111-111111111111" };
const STORAGE_DIR = "/Projects/ACME/ACME-0001-Brief";

function makeRequest(body: unknown) {
  return new Request("http://localhost/projects/project-1/files/upload-init", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /projects/[id]/files/upload-init", () => {
  beforeEach(() => {
    vi.resetModules();
    [requireUserMock, getProjectMock, assertClientNotArchivedForMutationMock, getProjectStorageDirMock, getTemporaryUploadLinkMock, resolveAvailableUploadPathMock]
      .forEach((m) => m.mockReset());
    getProjectStorageDirMock.mockReturnValue(STORAGE_DIR);
    // Default: filename is free, so resolution returns the unsuffixed path.
    resolveAvailableUploadPathMock.mockImplementation(
      async ({ dir, filename }: { dir: string; filename: string }) => `${dir}/${filename}`
    );
  });

  it("returns 200 with uploadUrl, targetPath, requestId for a valid request", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1" });
    getProjectMock.mockResolvedValue(PROJECT);
    assertClientNotArchivedForMutationMock.mockResolvedValue(undefined);
    getTemporaryUploadLinkMock.mockResolvedValue({ uploadUrl: "https://content.dropboxapi.com/apitul/x/abc" });

    const { POST } = await import("@/app/projects/[id]/files/upload-init/route");
    const res = await POST(
      makeRequest({ filename: "cover.jpg", mimeType: "image/jpeg", sizeBytes: 1234 }),
      { params: Promise.resolve({ id: "project-1" }) }
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.uploadUrl).toBe("https://content.dropboxapi.com/apitul/x/abc");
    expect(typeof json.requestId).toBe("string");
    expect(resolveAvailableUploadPathMock).toHaveBeenCalledWith({ dir: `${STORAGE_DIR}/uploads`, filename: "cover.jpg" });
    expect(json.targetPath).toBe(`${STORAGE_DIR}/uploads/cover.jpg`);
    expect(getTemporaryUploadLinkMock).toHaveBeenCalledWith({ targetPath: json.targetPath });
  });

  it("uses the collision-free path returned by resolveAvailableUploadPath", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1" });
    getProjectMock.mockResolvedValue(PROJECT);
    assertClientNotArchivedForMutationMock.mockResolvedValue(undefined);
    resolveAvailableUploadPathMock.mockResolvedValue(`${STORAGE_DIR}/uploads/cover-2.jpg`);
    getTemporaryUploadLinkMock.mockResolvedValue({ uploadUrl: "https://content.dropboxapi.com/apitul/x/abc" });

    const { POST } = await import("@/app/projects/[id]/files/upload-init/route");
    const res = await POST(
      makeRequest({ filename: "cover.jpg", mimeType: "image/jpeg", sizeBytes: 1234 }),
      { params: Promise.resolve({ id: "project-1" }) }
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.targetPath).toBe(`${STORAGE_DIR}/uploads/cover-2.jpg`);
    expect(getTemporaryUploadLinkMock).toHaveBeenCalledWith({ targetPath: `${STORAGE_DIR}/uploads/cover-2.jpg` });
  });

  it("returns 401 when requireUser throws", async () => {
    requireUserMock.mockRejectedValue(new Error("Missing auth token"));
    const { POST } = await import("@/app/projects/[id]/files/upload-init/route");
    const res = await POST(makeRequest({ filename: "x.jpg", mimeType: "image/jpeg", sizeBytes: 1 }), { params: Promise.resolve({ id: "project-1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the project does not exist", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1" });
    getProjectMock.mockResolvedValue(null);
    const { POST } = await import("@/app/projects/[id]/files/upload-init/route");
    const res = await POST(makeRequest({ filename: "x.jpg", mimeType: "image/jpeg", sizeBytes: 1 }), { params: Promise.resolve({ id: "project-1" }) });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the client is archived", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1" });
    getProjectMock.mockResolvedValue(PROJECT);
    assertClientNotArchivedForMutationMock.mockRejectedValue(new Error("Client is archived. Restore it before uploading files."));
    const { POST } = await import("@/app/projects/[id]/files/upload-init/route");
    const res = await POST(makeRequest({ filename: "x.jpg", mimeType: "image/jpeg", sizeBytes: 1 }), { params: Promise.resolve({ id: "project-1" }) });
    expect(res.status).toBe(409);
  });

  it("returns 400 for missing fields", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1" });
    getProjectMock.mockResolvedValue(PROJECT);
    assertClientNotArchivedForMutationMock.mockResolvedValue(undefined);
    const { POST } = await import("@/app/projects/[id]/files/upload-init/route");
    const res = await POST(makeRequest({ filename: "" }), { params: Promise.resolve({ id: "project-1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 400 when sizeBytes exceeds the 150 MB ceiling", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1" });
    getProjectMock.mockResolvedValue(PROJECT);
    assertClientNotArchivedForMutationMock.mockResolvedValue(undefined);
    const { POST } = await import("@/app/projects/[id]/files/upload-init/route");
    const res = await POST(
      makeRequest({ filename: "x.bin", mimeType: "application/octet-stream", sizeBytes: 150 * 1024 * 1024 + 1 }),
      { params: Promise.resolve({ id: "project-1" }) }
    );
    expect(res.status).toBe(400);
    expect(getTemporaryUploadLinkMock).not.toHaveBeenCalled();
  });

  it("returns 500 when Dropbox throws", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1" });
    getProjectMock.mockResolvedValue(PROJECT);
    assertClientNotArchivedForMutationMock.mockResolvedValue(undefined);
    getTemporaryUploadLinkMock.mockRejectedValue(new Error("dropbox down"));
    const { POST } = await import("@/app/projects/[id]/files/upload-init/route");
    const res = await POST(
      makeRequest({ filename: "x.jpg", mimeType: "image/jpeg", sizeBytes: 1 }),
      { params: Promise.resolve({ id: "project-1" }) }
    );
    expect(res.status).toBe(500);
  });

  it("returns 400 when filename contains a path separator", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1" });
    getProjectMock.mockResolvedValue(PROJECT);
    assertClientNotArchivedForMutationMock.mockResolvedValue(undefined);
    const { POST } = await import("@/app/projects/[id]/files/upload-init/route");
    const res = await POST(
      makeRequest({ filename: "../etc/passwd", mimeType: "text/plain", sizeBytes: 1 }),
      { params: Promise.resolve({ id: "project-1" }) }
    );
    expect(res.status).toBe(400);
    expect(getTemporaryUploadLinkMock).not.toHaveBeenCalled();
  });
});
