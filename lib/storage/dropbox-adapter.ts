import { Dropbox } from "dropbox";
import { config } from "../config-core";
export class DropboxStorageAdapter {
  private readonly baseClient: Dropbox;
  private clientPromise: Promise<Dropbox> | null = null;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly refreshToken: string | undefined;
  private readonly selectUser: string | undefined;
  private readonly selectAdmin: string | undefined;
  private readonly dropboxFetch: typeof fetch;

  constructor() {
    this.clientId = config.dropboxAppKey() ?? undefined;
    this.clientSecret = config.dropboxAppSecret() ?? undefined;
    this.refreshToken = config.dropboxRefreshToken() ?? undefined;
    this.selectUser = config.dropboxSelectUser() ?? undefined;
    this.selectAdmin = config.dropboxSelectAdmin() ?? undefined;

    this.dropboxFetch = async (...args) => {
      if (typeof globalThis.fetch !== "function") {
        throw new Error("Global fetch is unavailable in this runtime");
      }
      const response = await globalThis.fetch(...args);
      const compatibleResponse = response as Response & { buffer?: () => Promise<Buffer> };
      if (typeof compatibleResponse.buffer !== "function") {
        compatibleResponse.buffer = async () => Buffer.from(await response.arrayBuffer());
      }
      return compatibleResponse;
    };

    this.baseClient = new Dropbox({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      refreshToken: this.refreshToken,
      selectUser: this.selectUser,
      selectAdmin: this.selectAdmin,
      fetch: this.dropboxFetch
    });
  }

  private async getClient() {
    if (this.clientPromise) {
      return this.clientPromise;
    }

    this.clientPromise = (async () => {
      const account = await this.baseClient.usersGetCurrentAccount();
      const rootInfo = account.result.root_info;
      if (rootInfo.root_namespace_id === rootInfo.home_namespace_id) {
        return this.baseClient;
      }

      return new Dropbox({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken: this.refreshToken,
        selectUser: this.selectUser,
        selectAdmin: this.selectAdmin,
        pathRoot: JSON.stringify({ ".tag": "root", root: rootInfo.root_namespace_id }),
        fetch: this.dropboxFetch
      });
    })();

    return this.clientPromise;
  }

  async copyFile(args: { fromPath: string; toPath: string; autorename: boolean }): Promise<{ id: string; pathDisplay: string }> {
    const client = await this.getClient();
    const res = await client.filesCopyV2({
      from_path: args.fromPath,
      to_path: args.toPath,
      autorename: args.autorename,
    });
    const meta = res.result.metadata as { id: string; path_display?: string };
    return {
      id: meta.id,
      pathDisplay: meta.path_display ?? args.toPath,
    };
  }

  async uploadComplete(args: {
    sessionId: string;
    targetPath: string;
    filename: string;
    content: Buffer;
    mimeType: string;
  }) {
    const client = await this.getClient();
    const parentDir = getParentDir(args.targetPath);
    if (parentDir) {
      await this.ensureDirectoryChain(parentDir);
    }

    const completed = await client.filesUpload({
      path: args.targetPath,
      contents: args.content,
      autorename: true,
      mode: { ".tag": "add" },
      mute: false
    });

    return {
      fileId: completed.result.id,
      path: completed.result.path_display ?? args.targetPath,
      rev: completed.result.rev
    };
  }

  async getTemporaryUploadLink(args: { targetPath: string }): Promise<{ uploadUrl: string }> {
    const client = await this.getClient();
    const response = await client.filesGetTemporaryUploadLink({
      commit_info: {
        path: args.targetPath,
        mode: { ".tag": "add" },
        // autorename is false because targetPath is UUID-prefixed and globally unique by construction
        autorename: false,
        mute: true
      },
      duration: 14400 // 4 hours, the documented Dropbox max for this endpoint
    });
    return { uploadUrl: response.result.link };
  }

  async getFileMetadata(args: { targetPath: string }): Promise<{
    fileId: string;
    pathDisplay: string;
    contentHash: string;
    size: number;
    serverModified: string;
  }> {
    const client = await this.getClient();
    const response = await client.filesGetMetadata({ path: args.targetPath });
    const entry = response.result as {
      ".tag": string;
      id?: string;
      path_display?: string;
      content_hash?: string;
      size?: number;
      server_modified?: string;
    };
    if (entry[".tag"] !== "file") {
      throw new Error(`Dropbox metadata for ${args.targetPath} is not a file (got .tag=${entry[".tag"]})`);
    }
    if (!entry.id || !entry.path_display || !entry.content_hash || typeof entry.size !== "number" || !entry.server_modified) {
      throw new Error(`Dropbox metadata for ${args.targetPath} is missing required fields`);
    }
    return {
      fileId: entry.id,
      pathDisplay: entry.path_display,
      contentHash: entry.content_hash,
      size: entry.size,
      serverModified: entry.server_modified
    };
  }

  async createTemporaryDownloadLink(path: string) {
    const client = await this.getClient();
    const result = await client.filesGetTemporaryLink({ path });
    return result.result.link;
  }

  async listFolderEntries(path: string) {
    const client = await this.getClient();
    const entries: Array<{
      ".tag": "file" | "folder";
      name: string;
      path_display: string;
      id?: string;
    }> = [];
    try {
      let response = await client.filesListFolder({ path, recursive: false });
      for (const entry of response.result.entries) {
        if (entry[".tag"] === "file" || entry[".tag"] === "folder") {
          entries.push(entry as (typeof entries)[number]);
        }
      }
      while (response.result.has_more) {
        response = await client.filesListFolderContinue({ cursor: response.result.cursor });
        for (const entry of response.result.entries) {
          if (entry[".tag"] === "file" || entry[".tag"] === "folder") {
            entries.push(entry as (typeof entries)[number]);
          }
        }
      }
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
    return entries;
  }

  async moveFile(args: { from?: string; fromId?: string; to: string; autorename?: boolean }) {
    if (!!args.from === !!args.fromId) {
      throw new Error("moveFile requires exactly one of `from` or `fromId`");
    }
    const client = await this.getClient();
    const fromPath = args.fromId ? args.fromId : (args.from as string);
    const result = await client.filesMoveV2({
      from_path: fromPath,
      to_path: args.to,
      autorename: args.autorename ?? false
    });
    const meta = result.result.metadata as { path_display?: string; id?: string; rev?: string };
    return {
      path: meta.path_display ?? args.to,
      fileId: meta.id,
      rev: meta.rev
    };
  }

  async createFolderLink(path: string) {
    const client = await this.getClient();
    const existing = await client.sharingListSharedLinks({
      path,
      direct_only: true
    });
    const existingLink = existing.result.links.find((link) => typeof link.url === "string");
    if (existingLink?.url) {
      return existingLink.url;
    }

    try {
      const created = await client.sharingCreateSharedLinkWithSettings({ path });
      return created.result.url;
    } catch (error) {
      if (isSharedLinkAlreadyExistsError(error)) {
        const retry = await client.sharingListSharedLinks({
          path,
          direct_only: true
        });
        const retryLink = retry.result.links.find((link) => typeof link.url === "string");
        if (retryLink?.url) {
          return retryLink.url;
        }
      }
      throw error;
    }
  }

  async downloadFile(path: string) {
    const client = await this.getClient();
    const response = await client.filesDownload({ path });
    const payload = response.result as unknown as Record<string, unknown>;
    const binary = payload.fileBinary ?? payload.fileBlob;
    if (!binary) {
      throw new Error("Dropbox file download response did not include binary data");
    }

    const metadata = payload.metadata as Record<string, unknown> | undefined;
    const contentType =
      typeof payload.content_type === "string"
        ? payload.content_type
        : typeof metadata?.content_type === "string"
          ? metadata.content_type
          : "application/octet-stream";

    return {
      bytes: this.ensureBuffer(binary, "Dropbox file download response did not include binary data"),
      contentType
    };
  }

  async ensureProjectFolders(args: { clientCodeUpper: string; projectFolderBaseName: string }) {
    const projectsRoot = config.dropboxProjectsRootFolder();
    const clientDir = `${projectsRoot}/${args.clientCodeUpper}`;
    await this.ensureFolderExists(clientDir);

    const projectDir = await this.createProjectDirWithSuffix({
      clientDir,
      projectFolderBaseName: args.projectFolderBaseName
    });
    const uploadsDir = `${projectDir}/uploads`;
    await this.ensureFolderExists(uploadsDir);

    return { projectDir, uploadsDir };
  }

  async archiveClientRootFolder(args: { clientCodeUpper: string }) {
    const clientCodeUpper = normalizeClientCode(args.clientCodeUpper);
    const fromPath = joinDropboxPath(config.dropboxProjectsRootFolder(), clientCodeUpper);
    const toPath = joinDropboxPath(config.dropboxArchivedClientsRoot(), clientCodeUpper);
    await this.moveProjectFolder({ fromPath, toPath });
    return { fromPath, toPath };
  }

  async restoreClientRootFolder(args: { clientCodeUpper: string }) {
    const clientCodeUpper = normalizeClientCode(args.clientCodeUpper);
    const fromPath = joinDropboxPath(config.dropboxArchivedClientsRoot(), clientCodeUpper);
    const toPath = joinDropboxPath(config.dropboxProjectsRootFolder(), clientCodeUpper);
    await this.moveProjectFolder({ fromPath, toPath });
    return { fromPath, toPath };
  }

  async moveProjectFolder(args: { fromPath: string; toPath: string }) {
    const fromPath = normalizeDropboxFolderPath(args.fromPath, "fromPath");
    const toPath = normalizeDropboxFolderPath(args.toPath, "toPath");
    if (args.fromPath === args.toPath) {
      return { projectDir: toPath };
    }

    const client = await this.getClient();
    const parentDir = getParentDir(toPath);
    if (parentDir) {
      await this.ensureDirectoryChain(parentDir);
    }

    try {
      await client.filesMoveV2({
        from_path: fromPath,
        to_path: toPath,
        autorename: false
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        const destinationExists = await this.pathExists(toPath);
        if (destinationExists) {
          return { projectDir: toPath };
        }
      }
      throw error;
    }

    return { projectDir: toPath };
  }

  private async createProjectDirWithSuffix(args: { clientDir: string; projectFolderBaseName: string }) {
    const maxSuffixAttempts = 200;
    for (let attempt = 0; attempt < maxSuffixAttempts; attempt += 1) {
      const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
      const candidatePath = `${args.clientDir}/${args.projectFolderBaseName}${suffix}`;
      const created = await this.tryCreateFolder(candidatePath);
      if (created) {
        return candidatePath;
      }
    }
    throw new Error(`Unable to provision unique Dropbox project directory for ${args.projectFolderBaseName}`);
  }

  private async ensureFolderExists(path: string) {
    const created = await this.tryCreateFolder(path);
    if (created) {
      return;
    }
    const exists = await this.pathExists(path);
    if (!exists) {
      throw new Error(`Failed to create Dropbox folder at ${path}`);
    }
  }

  private async tryCreateFolder(path: string): Promise<boolean> {
    const client = await this.getClient();
    try {
      await client.filesCreateFolderV2({ path, autorename: false });
      return true;
    } catch (error) {
      if (isPathConflictError(error)) {
        return false;
      }
      throw error;
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    const client = await this.getClient();
    try {
      await client.filesGetMetadata({ path });
      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  private async ensureDirectoryChain(path: string) {
    const segments = path.split("/").filter(Boolean);
    if (!segments.length) return;

    let currentPath = "";
    for (const segment of segments) {
      currentPath += `/${segment}`;
      const created = await this.tryCreateFolder(currentPath);
      if (created) {
        continue;
      }
      const exists = await this.pathExists(currentPath);
      if (!exists) {
        throw new Error(`Failed to create Dropbox folder at ${currentPath}`);
      }
    }
  }

  private ensureBuffer(value: unknown, errorMessage: string) {
    if (Buffer.isBuffer(value)) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return Buffer.from(value);
    }
    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView;
      return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    }
    if (typeof value === "string") {
      return Buffer.from(value);
    }
    throw new Error(errorMessage);
  }
}

export function mapDropboxMetadata(args: {
  projectId: string;
  uploaderUserId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  dropboxFileId: string;
  dropboxPath: string;
}) {
  return {
    project_id: args.projectId,
    uploader_user_id: args.uploaderUserId,
    filename: args.filename,
    mime_type: args.mimeType,
    size_bytes: args.sizeBytes,
    dropbox_file_id: args.dropboxFileId,
    dropbox_path: args.dropboxPath,
    checksum: args.checksum
  };
}

function normalizeClientCode(value: string) {
  const normalized = value.trim().toUpperCase();
  if (!normalized || /[\\/]/.test(normalized)) {
    throw new Error("Client code must be a single Dropbox folder segment");
  }
  return normalized;
}

function normalizeDropboxFolderPath(path: string, label: string) {
  const normalized = path.trim().replace(/\/+$/, "");
  if (!normalized.startsWith("/") || normalized === "/") {
    throw new Error(`${label} must be an absolute Dropbox folder path`);
  }
  return normalized;
}

function joinDropboxPath(root: string, leaf: string) {
  return `${normalizeDropboxFolderPath(root, "Dropbox root path")}/${leaf}`;
}

function getParentDir(path: string) {
  const normalized = path.trim();
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return "";
  return normalized.slice(0, lastSlash);
}

export function getDropboxErrorSummary(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    const nestedError = obj.error;
    if (typeof nestedError === "object" && nestedError !== null) {
      const nested = nestedError as Record<string, unknown>;
      if (typeof nested.error_summary === "string") {
        return nested.error_summary;
      }
      if (typeof nested.message === "string") {
        return nested.message;
      }
      try {
        return JSON.stringify(nested);
      } catch {
        // Fall through to outer fields below.
      }
    }
    if (typeof obj.error_summary === "string") {
      return obj.error_summary;
    }
    if (typeof obj.message === "string") {
      return obj.message;
    }
    try {
      return JSON.stringify(obj);
    } catch {
      // Fall through to String(error) below.
    }
  }
  return String(error);
}

function isPathConflictError(error: unknown) {
  const summary = getDropboxErrorSummary(error).toLowerCase();
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  return summary.includes("path/conflict") || summary.includes("conflict/folder") || (status === 409 && summary.includes("conflict"));
}

function isSharedLinkAlreadyExistsError(error: unknown) {
  const summary = getDropboxErrorSummary(error).toLowerCase();
  return summary.includes("shared_link_already_exists");
}

export function isTeamSelectUserRequiredError(error: unknown) {
  const summary = getDropboxErrorSummary(error).toLowerCase();
  return summary.includes("dropbox-api-select-user") || summary.includes("select_user");
}

function isNotFoundError(error: unknown) {
  const summary = getDropboxErrorSummary(error).toLowerCase();
  return summary.includes("not_found");
}

