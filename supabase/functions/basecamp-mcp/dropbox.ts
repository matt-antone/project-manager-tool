import { Dropbox } from "dropbox";

export class DropboxAuthError extends Error {
  constructor() {
    super("Dropbox authentication failed");
    this.name = "DropboxAuthError";
  }
}

export class DropboxConfigError extends Error {
  constructor() {
    super("Dropbox credentials missing");
    this.name = "DropboxConfigError";
  }
}

export class DropboxStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DropboxStorageError";
  }
}

let clientPromise: Promise<Dropbox> | null = null;

export function _resetTokenCache() {
  clientPromise = null;
}

function getConfig() {
  const clientId = Deno.env.get("DROPBOX_APP_KEY");
  const clientSecret = Deno.env.get("DROPBOX_APP_SECRET");
  const refreshToken = Deno.env.get("DROPBOX_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new DropboxConfigError();
  }
  return {
    clientId,
    clientSecret,
    refreshToken,
    selectUser: Deno.env.get("DROPBOX_SELECT_USER"),
    selectAdmin: Deno.env.get("DROPBOX_SELECT_ADMIN"),
  };
}

async function getClient(): Promise<Dropbox> {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const config = getConfig();

    const baseClient = new Dropbox({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: config.refreshToken,
      selectUser: config.selectUser,
      selectAdmin: config.selectAdmin,
    });

    try {
      const account = await baseClient.usersGetCurrentAccount();
      const rootInfo = account.result.root_info;

      if (rootInfo.root_namespace_id === rootInfo.home_namespace_id) {
        return baseClient;
      }

      return new Dropbox({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken: config.refreshToken,
        selectUser: config.selectUser,
        selectAdmin: config.selectAdmin,
        pathRoot: JSON.stringify({
          ".tag": "root",
          root: rootInfo.root_namespace_id,
        }),
      });
    } catch {
      // If account lookup fails, return base client — better than failing entirely
      return baseClient;
    }
  })();

  return clientPromise;
}

export async function getTemporaryLink(pathOrId: string): Promise<string> {
  try {
    const client = await getClient();
    const result = await client.filesGetTemporaryLink({ path: pathOrId });
    return result.result.link;
  } catch (e: any) {
    throw classifyError(e);
  }
}

export async function uploadFile(
  path: string,
  bytes: Uint8Array
): Promise<{ fileId: string; pathDisplay: string; size: number; contentHash: string }> {
  try {
    const client = await getClient();
    const res = await client.filesUpload({
      path,
      contents: bytes,
      mode: { ".tag": "add" },
      autorename: true,
    });
    const r = res.result as unknown as {
      id: string;
      path_display?: string;
      size: number;
      content_hash?: string;
    };
    return {
      fileId: r.id,
      pathDisplay: r.path_display ?? path,
      size: r.size,
      contentHash: r.content_hash ?? "",
    };
  } catch (e: any) {
    throw classifyError(e);
  }
}

export async function downloadFile(
  pathOrId: string
): Promise<{ bytes: Uint8Array; contentType: string }> {
  try {
    const client = await getClient();
    const response = await client.filesDownload({ path: pathOrId });
    const payload = response.result as unknown as Record<string, unknown>;
    const binary = payload.fileBinary ?? payload.fileBlob;

    if (!binary) {
      throw new DropboxStorageError("Storage error");
    }

    let bytes: Uint8Array;
    if (binary instanceof ArrayBuffer) {
      bytes = new Uint8Array(binary);
    } else if (binary instanceof Uint8Array) {
      bytes = binary;
    } else if (typeof (binary as any).arrayBuffer === "function") {
      bytes = new Uint8Array(await (binary as any).arrayBuffer());
    } else {
      throw new DropboxStorageError("Storage error");
    }

    const contentType =
      (response.result as any).content_type ??
      "application/octet-stream";

    return { bytes, contentType };
  } catch (e: any) {
    throw classifyError(e);
  }
}

function sanitize(msg: string): string {
  const secrets = [
    Deno.env.get("DROPBOX_APP_KEY"),
    Deno.env.get("DROPBOX_APP_SECRET"),
    Deno.env.get("DROPBOX_REFRESH_TOKEN"),
  ].filter(Boolean) as string[];
  let out = msg;
  for (const s of secrets) out = out.replaceAll(s, "***");
  return out;
}

function classifyError(e: any): Error {
  if (e instanceof DropboxConfigError || e instanceof DropboxStorageError || e instanceof DropboxAuthError) {
    return e;
  }

  const status = e?.status;
  const message = String(e?.error?.error_summary ?? e?.message ?? "");

  if (status === 401 || message.includes("invalid_access_token")) {
    return new DropboxAuthError();
  }
  if (status === 409 && message.includes("not_found")) {
    return new DropboxStorageError(`File not found in storage (${sanitize(message)})`);
  }
  if (status === 429) {
    return new DropboxStorageError("Storage rate limited, try again later");
  }

  return new DropboxStorageError(`Storage error: status=${status}, summary=${sanitize(message)}`);
}
