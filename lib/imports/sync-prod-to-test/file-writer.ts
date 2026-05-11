// lib/imports/sync-prod-to-test/file-writer.ts
//
// NOTE — thumbnail enqueue is DEFERRED, not inline.
//
// enqueueThumbnailJobAndNotifyBestEffort (lib/thumbnail-enqueue-after-save.ts) calls
// upsertThumbnailJob from lib/repositories.ts, which uses the module-level `query()`
// helper (its own pool). Running it inside an open PoolClient transaction would cause
// the thumbnail job row to be written on a separate connection — it would be visible
// before the project_files row commits, and a crash between INSERT and COMMIT would
// leave an orphaned job. To avoid this, writeFile returns the inserted test_file_id
// and lets the orchestrator call enqueueThumbnailJobAndNotifyBestEffort AFTER commit.
import type { Pool, PoolClient } from "pg";
import type { ProdFileRow } from "./types";
import {
  findTestUserIdForBc2Placeholder,
  resolveTestThreadIdForProdThread,
  resolveTestCommentIdForProdComment,
} from "./identity";
import { copyProdFileToTestRoot, type CopyResult } from "./dropbox-copy";

export type FileWriteResult =
  | "inserted"
  | "skipped_existing"
  | "skipped_dry_run"
  | "failed_copy";

export interface WriteFileOpts {
  dryRun: boolean;
  /** When true, skip Dropbox copy and thumbnail enqueue; insert with prod-side path. */
  skipFiles: boolean;
}

function asPoolLike(c: PoolClient): Pool {
  return {
    query: (sql: string, params?: unknown[]) => c.query(sql, params as never),
  } as unknown as Pool;
}

export async function writeFile(
  testTx: PoolClient,
  testProjectId: string,
  testThreadIdMap: Map<string, string | null>,
  testCommentIdMap: Map<string, string | null>,
  prodFile: ProdFileRow,
  opts: WriteFileOpts,
  prodPool: Pool,
): Promise<{ result: FileWriteResult; test_file_id: string | null; copy: CopyResult | null }> {
  const lookupKey = prodFile.basecamp_file_id ?? `prod_native_${prodFile.id}`;
  const existing = await testTx.query(
    `SELECT local_file_id FROM import_map_files WHERE basecamp_file_id = $1 LIMIT 1`,
    [lookupKey],
  );
  if (existing.rows[0]) {
    return {
      result: "skipped_existing",
      test_file_id: existing.rows[0].local_file_id as string,
      copy: null,
    };
  }

  if (opts.dryRun) {
    return { result: "skipped_dry_run", test_file_id: null, copy: null };
  }

  let dropboxPath: string | null = prodFile.dropbox_path;
  let dropboxFileId: string | null = prodFile.dropbox_file_id;
  let sizeBytes: number | null = prodFile.size_bytes;
  let copy: CopyResult | null = null;

  if (!opts.skipFiles && prodFile.dropbox_path) {
    copy = await copyProdFileToTestRoot(prodFile.dropbox_path);
    if (!copy.ok) {
      return { result: "failed_copy", test_file_id: null, copy };
    }
    dropboxPath = copy.newPath;
    dropboxFileId = copy.newFileId;
    sizeBytes = copy.newSize ?? sizeBytes;
  }

  const uploader = await findTestUserIdForBc2Placeholder(
    asPoolLike(testTx),
    prodFile.uploader_user_id,
  );

  // Resolve thread_id: try in-run map first, then fall back to test import_map_threads.
  let testThreadId: string | null = null;
  if (prodFile.thread_id) {
    if (testThreadIdMap.has(prodFile.thread_id)) {
      testThreadId = testThreadIdMap.get(prodFile.thread_id) ?? null;
    } else {
      testThreadId = await resolveTestThreadIdForProdThread(
        prodPool,
        asPoolLike(testTx),
        prodFile.thread_id,
      );
    }
  }

  // Resolve comment_id: try in-run map first, then fall back to test import_map_comments.
  let testCommentId: string | null = null;
  if (prodFile.comment_id) {
    if (testCommentIdMap.has(prodFile.comment_id)) {
      testCommentId = testCommentIdMap.get(prodFile.comment_id) ?? null;
    } else {
      testCommentId = await resolveTestCommentIdForProdComment(
        prodPool,
        asPoolLike(testTx),
        prodFile.comment_id,
      );
    }
  }

  const ins = await testTx.query(
    `INSERT INTO project_files
       (project_id, thread_id, comment_id, uploader_user_id,
        filename, mime_type, size_bytes,
        dropbox_file_id, dropbox_path, checksum,
        bc_attachment_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      testProjectId,
      testThreadId,
      testCommentId,
      uploader,
      prodFile.filename,
      prodFile.mime_type,
      sizeBytes,
      dropboxFileId,
      dropboxPath,
      prodFile.checksum,
      prodFile.bc_attachment_id,
      prodFile.created_at,
    ],
  );
  const testFileId: string = ins.rows[0].id as string;

  await testTx.query(
    `INSERT INTO import_map_files (basecamp_file_id, local_file_id)
     VALUES ($1, $2)
     ON CONFLICT (basecamp_file_id) DO NOTHING`,
    [lookupKey, testFileId],
  );

  // Thumbnail enqueue is intentionally NOT called here.
  // The orchestrator must call enqueueThumbnailJobAndNotifyBestEffort after COMMIT:
  //
  //   import { enqueueThumbnailJobAndNotifyBestEffort } from "../../thumbnail-enqueue-after-save";
  //   await enqueueThumbnailJobAndNotifyBestEffort({
  //     projectId: testProjectId,
  //     fileRecord: { id: testFileId },
  //   });
  //
  // See module-level comment for why.

  return { result: "inserted", test_file_id: testFileId, copy };
}
