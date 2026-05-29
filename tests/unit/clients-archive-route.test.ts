import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const getClientByIdMock = vi.fn();
const updateClientArchiveStateMock = vi.fn();
const rewriteClientDropboxPathsMock = vi.fn();
const archiveClientRootFolderMock = vi.fn();
const restoreClientRootFolderMock = vi.fn();
const dropboxArchivedClientsRootMock = vi.fn();

let scheduledAfterCallback: (() => Promise<void> | void) | null = null;

vi.mock("@/lib/auth", () => ({
  requireUser: requireUserMock
}));

vi.mock("@/lib/config", () => ({
  config: {
    dropboxArchivedClientsRoot: dropboxArchivedClientsRootMock
  }
}));

vi.mock("@/lib/repositories", () => ({
  getClientById: getClientByIdMock,
  updateClientArchiveState: updateClientArchiveStateMock,
  rewriteClientDropboxPaths: rewriteClientDropboxPathsMock
}));

vi.mock("@/lib/storage/dropbox-adapter", () => ({
  DropboxStorageAdapter: class {
    archiveClientRootFolder = archiveClientRootFolderMock;
    restoreClientRootFolder = restoreClientRootFolderMock;
  },
  getDropboxErrorSummary: (error: unknown) => (error instanceof Error ? error.message : String(error))
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (callback: () => Promise<void> | void) => {
      scheduledAfterCallback = callback;
    }
  };
});

describe("client archive routes", () => {
  beforeEach(() => {
    vi.resetModules();
    scheduledAfterCallback = null;
    requireUserMock.mockReset();
    getClientByIdMock.mockReset();
    updateClientArchiveStateMock.mockReset();
    rewriteClientDropboxPathsMock.mockReset();
    archiveClientRootFolderMock.mockReset();
    restoreClientRootFolderMock.mockReset();
    dropboxArchivedClientsRootMock.mockReset();
  });

  afterEach(() => {
    scheduledAfterCallback = null;
  });

  it("returns 202 and schedules archive work", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    dropboxArchivedClientsRootMock.mockReturnValue("/Projects Archive");
    getClientByIdMock.mockResolvedValue({
      id: "11111111-1111-1111-8111-111111111111",
      code: "ACME",
      name: "Acme",
      archived_at: null,
      dropbox_archive_status: "idle",
      archive_error: null
    });
    updateClientArchiveStateMock.mockResolvedValue(undefined);
    archiveClientRootFolderMock.mockResolvedValue({
      fromPath: "/Projects/ACME",
      toPath: "/Projects Archive/ACME"
    });
    rewriteClientDropboxPathsMock.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/clients/[id]/archive/route");
    const response = await POST(
      new Request("http://localhost/clients/11111111-1111-1111-8111-111111111111/archive", {
        method: "POST",
        headers: {
          authorization: "Bearer token"
        }
      }),
      { params: Promise.resolve({ id: "11111111-1111-1111-8111-111111111111" }) }
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      pollUrl: "/api/clients/11111111-1111-1111-8111-111111111111"
    });
    expect(updateClientArchiveStateMock).toHaveBeenCalledWith("11111111-1111-1111-8111-111111111111", {
      status: "pending",
      archiveError: null
    });
    expect(typeof scheduledAfterCallback).toBe("function");

    await scheduledAfterCallback?.();

    expect(archiveClientRootFolderMock).toHaveBeenCalledWith({ clientCodeUpper: "ACME" });
    expect(rewriteClientDropboxPathsMock).toHaveBeenCalledWith({
      clientId: "11111111-1111-1111-8111-111111111111",
      fromRoot: "/Projects/ACME",
      toRoot: "/Projects Archive/ACME"
    });
    expect(updateClientArchiveStateMock).toHaveBeenNthCalledWith(2, "11111111-1111-1111-8111-111111111111", {
      status: "in_progress",
      archiveError: null
    });
    expect(updateClientArchiveStateMock).toHaveBeenNthCalledWith(3, "11111111-1111-1111-8111-111111111111", {
      status: "completed",
      archiveError: null,
      archivedAt: expect.any(String)
    });
  });

  it("returns 400 when the archived Dropbox root is missing", async () => {
    requireUserMock.mockResolvedValue({ id: "user-1", email: "person@example.com" });
    dropboxArchivedClientsRootMock.mockImplementation(() => {
      throw new Error("DROPBOX_ARCHIVED_CLIENTS_ROOT is required to archive clients.");
    });
    getClientByIdMock.mockResolvedValue({
      id: "11111111-1111-1111-8111-111111111111",
      code: "ACME",
      name: "Acme",
      archived_at: null,
      dropbox_archive_status: "idle",
      archive_error: null
    });

    const { POST } = await import("@/app/api/clients/[id]/archive/route");
    const response = await POST(
      new Request("http://localhost/clients/11111111-1111-1111-8111-111111111111/archive", {
        method: "POST",
        headers: {
          authorization: "Bearer token"
        }
      }),
      { params: Promise.resolve({ id: "11111111-1111-1111-8111-111111111111" }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "DROPBOX_ARCHIVED_CLIENTS_ROOT is required to archive clients."
    });
    expect(updateClientArchiveStateMock).not.toHaveBeenCalled();
  });
});
