import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Dropbox } from "dropbox";
import { DropboxStorageAdapter } from "@/lib/storage/dropbox-adapter";
// Note: additional describe blocks below also use dynamic import to isolate module state

describe("DropboxStorageAdapter", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => ({
      arrayBuffer: async () => new ArrayBuffer(0)
    })) as unknown as typeof fetch;
  });

  it("downloads a file and prefers the top-level content type", async () => {
    const filesDownloadMock = vi.fn().mockResolvedValue({
      result: {
        fileBinary: Buffer.from("file-data"),
        content_type: "image/png",
        metadata: { content_type: "image/webp" }
      }
    });

    const adapter = new DropboxStorageAdapter() as unknown as {
      downloadFile: DropboxStorageAdapter["downloadFile"];
      getClient: () => Promise<{ filesDownload: (args: { path: string }) => Promise<unknown> }>;
    };
    adapter.getClient = async () => ({
      filesDownload: filesDownloadMock
    });

    const result = await adapter.downloadFile("/Projects/alpha/file.png");

    expect(filesDownloadMock).toHaveBeenCalledWith({ path: "/Projects/alpha/file.png" });
    expect(result.bytes).toEqual(Buffer.from("file-data"));
    expect(result.contentType).toBe("image/png");
  });

  it("uses the metadata content type when the top-level field is missing", async () => {
    const filesDownloadMock = vi.fn().mockResolvedValue({
      result: {
        fileBinary: Buffer.from("metadata-data"),
        metadata: { content_type: "image/jpeg" }
      }
    });

    const adapter = new DropboxStorageAdapter() as unknown as {
      downloadFile: DropboxStorageAdapter["downloadFile"];
      getClient: () => Promise<{ filesDownload: (args: { path: string }) => Promise<unknown> }>;
    };
    adapter.getClient = async () => ({
      filesDownload: filesDownloadMock
    });

    const result = await adapter.downloadFile("/Projects/alpha/file.png");
    expect(result.contentType).toBe("image/jpeg");
  });

  it("falls back to application/octet-stream when metadata lacks a content type", async () => {
    const filesDownloadMock = vi.fn().mockResolvedValue({
      result: {
        fileBinary: Buffer.from("other-data")
      }
    });

    const adapter = new DropboxStorageAdapter() as unknown as {
      downloadFile: DropboxStorageAdapter["downloadFile"];
      getClient: () => Promise<{ filesDownload: (args: { path: string }) => Promise<unknown> }>;
    };
    adapter.getClient = async () => ({
      filesDownload: filesDownloadMock
    });

    const result = await adapter.downloadFile("/Projects/alpha/file.png");

    expect(result.contentType).toBe("application/octet-stream");
  });

  it("treats a missing source move as already moved when destination exists", async () => {
    const filesMoveV2Mock = vi.fn().mockRejectedValue(new Error("path/not_found/"));
    const filesGetMetadataMock = vi.fn().mockResolvedValue({ result: { ".tag": "folder" } });
    const ensureDirectoryChainMock = vi.fn().mockResolvedValue(undefined);

    const adapter = new DropboxStorageAdapter() as unknown as {
      moveProjectFolder: DropboxStorageAdapter["moveProjectFolder"];
      getClient: () => Promise<{
        filesMoveV2: (args: { from_path: string; to_path: string; autorename: boolean }) => Promise<unknown>;
        filesGetMetadata: (args: { path: string }) => Promise<unknown>;
      }>;
      ensureDirectoryChain: (path: string) => Promise<void>;
    };
    adapter.getClient = async () => ({
      filesMoveV2: filesMoveV2Mock,
      filesGetMetadata: filesGetMetadataMock
    });
    adapter.ensureDirectoryChain = ensureDirectoryChainMock;

    const result = await adapter.moveProjectFolder({
      fromPath: "/Projects/BRGS/BRGS-0001-Acme Website Refresh",
      toPath: "/Projects/BRGS/_Archive/BRGS-0001-Acme Website Refresh"
    });

    expect(ensureDirectoryChainMock).toHaveBeenCalledWith("/Projects/BRGS/_Archive");
    expect(filesMoveV2Mock).toHaveBeenCalledWith({
      from_path: "/Projects/BRGS/BRGS-0001-Acme Website Refresh",
      to_path: "/Projects/BRGS/_Archive/BRGS-0001-Acme Website Refresh",
      autorename: false
    });
    expect(filesGetMetadataMock).toHaveBeenCalledWith({
      path: "/Projects/BRGS/_Archive/BRGS-0001-Acme Website Refresh"
    });
    expect(result).toEqual({ projectDir: "/Projects/BRGS/_Archive/BRGS-0001-Acme Website Refresh" });
  });

  it("rethrows when source is missing and destination also does not exist", async () => {
    const moveError = new Error("path/not_found/");
    const filesMoveV2Mock = vi.fn().mockRejectedValue(moveError);
    const filesGetMetadataMock = vi.fn().mockRejectedValue(new Error("path/not_found/"));
    const ensureDirectoryChainMock = vi.fn().mockResolvedValue(undefined);

    const adapter = new DropboxStorageAdapter() as unknown as {
      moveProjectFolder: DropboxStorageAdapter["moveProjectFolder"];
      getClient: () => Promise<{
        filesMoveV2: (args: { from_path: string; to_path: string; autorename: boolean }) => Promise<unknown>;
        filesGetMetadata: (args: { path: string }) => Promise<unknown>;
      }>;
      ensureDirectoryChain: (path: string) => Promise<void>;
    };
    adapter.getClient = async () => ({
      filesMoveV2: filesMoveV2Mock,
      filesGetMetadata: filesGetMetadataMock
    });
    adapter.ensureDirectoryChain = ensureDirectoryChainMock;

    await expect(
      adapter.moveProjectFolder({
        fromPath: "/Projects/BRGS/BRGS-0001-Acme Website Refresh",
        toPath: "/Projects/BRGS/_Archive/BRGS-0001-Acme Website Refresh"
      })
    ).rejects.toThrow("path/not_found/");
    expect(filesGetMetadataMock).toHaveBeenCalledWith({
      path: "/Projects/BRGS/_Archive/BRGS-0001-Acme Website Refresh"
    });
  });
});

describe("DropboxStorageAdapter.getTemporaryUploadLink", () => {
  it("calls SDK with the expected commit_info and returns the link", async () => {
    const filesGetTemporaryUploadLink = vi.fn().mockResolvedValue({
      result: { link: "https://content.dropboxapi.com/apitul/x/abc" }
    });

    const { DropboxStorageAdapter } = await import("@/lib/storage/dropbox-adapter");
    const adapter = new DropboxStorageAdapter();
    adapter.getClient = async () => ({ filesGetTemporaryUploadLink }) as unknown as Dropbox;

    const result = await adapter.getTemporaryUploadLink({
      targetPath: "/Projects/ACME/ACME-0001-Brief/uploads/cover.jpg"
    });

    expect(filesGetTemporaryUploadLink).toHaveBeenCalledWith({
      commit_info: {
        path: "/Projects/ACME/ACME-0001-Brief/uploads/cover.jpg",
        mode: { ".tag": "add" },
        autorename: false,
        mute: true
      },
      duration: 14400
    });
    expect(result).toEqual({ uploadUrl: "https://content.dropboxapi.com/apitul/x/abc" });
  });
});

describe("DropboxStorageAdapter.deleteByPath", () => {
  it("deletes the path via filesDeleteV2", async () => {
    const filesDeleteV2 = vi.fn().mockResolvedValue({ result: {} });
    const { DropboxStorageAdapter } = await import("@/lib/storage/dropbox-adapter");
    const adapter = new DropboxStorageAdapter();
    adapter.getClient = async () => ({ filesDeleteV2 }) as unknown as Dropbox;

    await adapter.deleteByPath("/Projects/ACME/ACME-0001-Brief/uploads/cover.jpg");
    expect(filesDeleteV2).toHaveBeenCalledWith({ path: "/Projects/ACME/ACME-0001-Brief/uploads/cover.jpg" });
  });

  it("treats a not_found path as already deleted", async () => {
    const filesDeleteV2 = vi.fn().mockRejectedValue(new Error("path_lookup/not_found/"));
    const { DropboxStorageAdapter } = await import("@/lib/storage/dropbox-adapter");
    const adapter = new DropboxStorageAdapter();
    adapter.getClient = async () => ({ filesDeleteV2 }) as unknown as Dropbox;

    await expect(adapter.deleteByPath("/Projects/ACME/ACME-0001-Brief/uploads/gone.jpg")).resolves.toBeUndefined();
  });

  it("rethrows non-not_found errors", async () => {
    const filesDeleteV2 = vi.fn().mockRejectedValue(new Error("insufficient_space"));
    const { DropboxStorageAdapter } = await import("@/lib/storage/dropbox-adapter");
    const adapter = new DropboxStorageAdapter();
    adapter.getClient = async () => ({ filesDeleteV2 }) as unknown as Dropbox;

    await expect(adapter.deleteByPath("/Projects/ACME/ACME-0001-Brief/uploads/x.jpg")).rejects.toThrow(/insufficient_space/);
  });
});

describe("DropboxStorageAdapter.resolveAvailableUploadPath", () => {
  function adapterWithExisting(existing: Set<string>) {
    const filesGetMetadata = vi.fn(async ({ path }: { path: string }) => {
      if (existing.has(path)) {
        return { result: { ".tag": "file", id: "id", path_display: path } };
      }
      throw new Error("path/not_found/");
    });
    const adapter = new DropboxStorageAdapter();
    adapter.getClient = async () => ({ filesGetMetadata }) as unknown as Dropbox;
    return { adapter, filesGetMetadata };
  }

  const DIR = "/Projects/ACME/ACME-0001-Brief/uploads";

  it("returns the unsuffixed path when nothing exists", async () => {
    const { adapter, filesGetMetadata } = adapterWithExisting(new Set());
    const result = await adapter.resolveAvailableUploadPath({ dir: DIR, filename: "report.pdf" });
    expect(result).toBe(`${DIR}/report.pdf`);
    expect(filesGetMetadata).toHaveBeenCalledTimes(1);
  });

  it("inserts an incrementing -N before the extension on collision", async () => {
    const { adapter } = adapterWithExisting(new Set([`${DIR}/report.pdf`, `${DIR}/report-1.pdf`]));
    const result = await adapter.resolveAvailableUploadPath({ dir: DIR, filename: "report.pdf" });
    expect(result).toBe(`${DIR}/report-2.pdf`);
  });

  it("appends -N for extensionless filenames", async () => {
    const { adapter } = adapterWithExisting(new Set([`${DIR}/README`]));
    const result = await adapter.resolveAvailableUploadPath({ dir: DIR, filename: "README" });
    expect(result).toBe(`${DIR}/README-1`);
  });

  it("preserves multi-dot names, splitting on the last dot", async () => {
    const { adapter } = adapterWithExisting(new Set([`${DIR}/archive.tar.gz`]));
    const result = await adapter.resolveAvailableUploadPath({ dir: DIR, filename: "archive.tar.gz" });
    expect(result).toBe(`${DIR}/archive.tar-1.gz`);
  });
});

describe("DropboxStorageAdapter.getFileMetadata", () => {
  it("looks up by targetPath and returns normalized fields", async () => {
    const filesGetMetadata = vi.fn().mockResolvedValue({
      result: {
        ".tag": "file",
        id: "id:abc123",
        path_display: "/Projects/ACME/ACME-0001-Brief/uploads/550e8400-e29b-41d4-a716-446655440000-cover.jpg",
        content_hash: "deadbeef",
        size: 1234,
        server_modified: "2026-04-30T17:00:00Z"
      }
    });

    const { DropboxStorageAdapter } = await import("@/lib/storage/dropbox-adapter");
    const adapter = new DropboxStorageAdapter();
    adapter.getClient = async () => ({ filesGetMetadata }) as unknown as Dropbox;

    const targetPath = "/Projects/ACME/ACME-0001-Brief/uploads/550e8400-e29b-41d4-a716-446655440000-cover.jpg";
    const result = await adapter.getFileMetadata({ targetPath });

    expect(filesGetMetadata).toHaveBeenCalledWith({ path: targetPath });
    expect(result).toEqual({
      fileId: "id:abc123",
      pathDisplay: "/Projects/ACME/ACME-0001-Brief/uploads/550e8400-e29b-41d4-a716-446655440000-cover.jpg",
      contentHash: "deadbeef",
      size: 1234,
      serverModified: "2026-04-30T17:00:00Z"
    });
  });

  it("throws when Dropbox returns a non-file metadata entry", async () => {
    const filesGetMetadata = vi.fn().mockResolvedValue({
      result: { ".tag": "folder", id: "id:xyz", path_display: "/Projects/foo" }
    });

    const { DropboxStorageAdapter } = await import("@/lib/storage/dropbox-adapter");
    const adapter = new DropboxStorageAdapter();
    adapter.getClient = async () => ({ filesGetMetadata }) as unknown as Dropbox;

    await expect(adapter.getFileMetadata({ targetPath: "/Projects/ACME/ACME-0001-Brief/uploads/uuid-x.jpg" })).rejects.toThrow(/not a file/);
  });

  it("throws when Dropbox returns a file entry with missing required fields", async () => {
    const filesGetMetadata = vi.fn().mockResolvedValue({
      result: {
        ".tag": "file",
        id: "id:abc",
        // path_display intentionally omitted
        content_hash: "h",
        size: 1,
        server_modified: "2026-04-30T17:00:00Z"
      }
    });

    const { DropboxStorageAdapter } = await import("@/lib/storage/dropbox-adapter");
    const adapter = new DropboxStorageAdapter();
    adapter.getClient = async () => ({ filesGetMetadata }) as unknown as Dropbox;

    await expect(adapter.getFileMetadata({ targetPath: "/Projects/ACME/ACME-0001-Brief/uploads/uuid-file.jpg" }))
      .rejects.toThrow(/missing required fields/);
  });
});
