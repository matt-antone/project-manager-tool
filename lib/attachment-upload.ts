"use client";

import { authedJsonFetch, ensureAccessToken } from "@/lib/browser-auth";

type UploadAttachmentArgs = {
  token: string;
  onToken: (token: string | null) => void;
  projectId: string;
  threadId: string;
  commentId?: string;
  file: File;
  onUploadProgress: (value: number) => void;
};

export async function uploadAttachment(args: UploadAttachmentArgs) {
  const { token, onToken, projectId, threadId, commentId, file, onUploadProgress } = args;
  const resolvedToken = await ensureAccessToken(token, onToken);

  onUploadProgress(0.1);

  // 1. Mint upload link.
  const { data: initData } = await authedJsonFetch({
    accessToken: resolvedToken,
    init: {
      method: "POST",
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size
      })
    },
    onToken,
    path: `/projects/${projectId}/files/upload-init`
  });
  const { uploadUrl, targetPath, requestId } = initData as { uploadUrl: string; targetPath: string; requestId: string };

  try {
    await uploadBytesAndFinalize();
  } catch (error) {
    // The temporary upload link may have already committed bytes to Dropbox before failing.
    // Delete that orphan (best effort) so the original filename is free again on retry.
    await abortUpload({ accessToken: resolvedToken, onToken, projectId, targetPath });
    throw error;
  }

  onUploadProgress(1);

  // --- Steps 2 & 3, scoped so a failure can trigger orphan cleanup. ---
  async function uploadBytesAndFinalize() {
  // 2. POST bytes directly to Dropbox via XHR (Fetch lacks upload-progress events).
  //    Dropbox temporary upload links accept POST with the file body. The response is
  //    only {"content-hash": "..."} so we rely on targetPath for the metadata lookup.
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadUrl);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const dropboxFraction = event.loaded / event.total;
        // Map 0-100% Dropbox upload to 10-90% of the overall progress band.
        onUploadProgress(Math.max(0.1, Math.min(0.9, 0.1 + dropboxFraction * 0.8)));
      }
    };
    xhr.onload = () => {
      // 4xx/5xx: real HTTP failure
      if (xhr.status < 200 || xhr.status >= 300) {
        const body = xhr.responseText.slice(0, 300);
        if (/conflict|already exists|path\/conflict/i.test(body)) {
          reject(new Error(
            "A file with this name already exists in this project. Rename the file and try again."
          ));
          return;
        }
        reject(new Error(`Upload failed (${xhr.status}): ${body}`));
        return;
      }
      // 2xx: parse body and verify it looks like a successful upload response.
      let parsed: { "content-hash"?: string; ".tag"?: string; reason?: { ".tag"?: string } } | null = null;
      try {
        parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        parsed = null;
      }
      // Dropbox sometimes returns 200 with an embedded WriteError shape on commit conflicts.
      if (parsed && parsed[".tag"] === "path") {
        const reasonTag = parsed.reason?.[".tag"] ?? "unknown";
        if (/conflict/i.test(reasonTag)) {
          reject(new Error(
            "A file with this name already exists in this project. Rename the file and try again."
          ));
          return;
        }
        reject(new Error(`Upload rejected by Dropbox: ${reasonTag}`));
        return;
      }
      if (!parsed || !parsed["content-hash"]) {
        reject(new Error("Upload completed but server response was unexpected."));
        return;
      }
      resolve();
    };
    xhr.onerror = () => reject(new Error("Network error uploading to Dropbox"));
    xhr.timeout = 300_000; // 5 minutes
    xhr.ontimeout = () => reject(new Error("Upload timed out"));
    xhr.send(file);
  });

  onUploadProgress(0.9);

  // 3. Finalize on the server via path-keyed metadata lookup.
  await authedJsonFetch({
    accessToken: resolvedToken,
    init: {
      method: "POST",
      headers: { "x-original-mime-type": file.type || "application/octet-stream" },
      body: JSON.stringify({
        targetPath,
        requestId,
        threadId,
        ...(commentId ? { commentId } : {})
      })
    },
    onToken,
    path: `/projects/${projectId}/files/upload-complete`
  });
  }

  async function abortUpload(abortArgs: {
    accessToken: string;
    onToken: (token: string | null) => void;
    projectId: string;
    targetPath: string;
  }) {
    try {
      await authedJsonFetch({
        accessToken: abortArgs.accessToken,
        init: {
          method: "POST",
          body: JSON.stringify({ targetPath: abortArgs.targetPath })
        },
        onToken: abortArgs.onToken,
        path: `/projects/${abortArgs.projectId}/files/upload-abort`
      });
    } catch {
      // Cleanup is best effort — never mask the original upload error.
    }
  }
}
