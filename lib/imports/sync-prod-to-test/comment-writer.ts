// lib/imports/sync-prod-to-test/comment-writer.ts
import type { Pool, PoolClient } from "pg";
import type { ProdCommentRow } from "./types";
import { findTestUserIdForBc2Placeholder, resolveTestThreadIdForProdThread } from "./identity";

export type CommentWriteResult = "inserted" | "skipped_existing" | "error_missing_thread";

function asPoolLike(c: PoolClient): Pool {
  return { query: (sql: string, params?: unknown[]) => c.query(sql, params as never) } as unknown as Pool;
}

export async function writeComment(
  testTx: PoolClient,
  testProjectId: string,
  testThreadIdForProdThreadId: Map<string, string | null>,
  prodComment: ProdCommentRow,
  prodPool: Pool,
): Promise<{ result: CommentWriteResult; test_comment_id: string | null; error?: string }> {
  const lookupKey = prodComment.basecamp_comment_id ?? `prod_native_${prodComment.id}`;
  const existing = await testTx.query(
    `SELECT local_comment_id FROM import_map_comments WHERE basecamp_comment_id = $1 LIMIT 1`,
    [lookupKey],
  );
  if (existing.rows[0]) {
    return { result: "skipped_existing", test_comment_id: existing.rows[0].local_comment_id };
  }

  let testThreadId: string | null = null;
  if (prodComment.thread_id) {
    if (testThreadIdForProdThreadId.has(prodComment.thread_id)) {
      testThreadId = testThreadIdForProdThreadId.get(prodComment.thread_id) ?? null;
    } else {
      // Pre-cutoff thread — resolve via import_map_threads in test.
      testThreadId = await resolveTestThreadIdForProdThread(
        prodPool,
        asPoolLike(testTx),
        prodComment.thread_id,
      );
      if (testThreadId === null) {
        const msg = `Cannot resolve test thread_id for prod thread ${prodComment.thread_id} (comment ${prodComment.id})`;
        return { result: "error_missing_thread", test_comment_id: null, error: msg };
      }
    }
  }

  const author = await findTestUserIdForBc2Placeholder(asPoolLike(testTx), prodComment.author_user_id);
  const ins = await testTx.query(
    `INSERT INTO discussion_comments
       (project_id, thread_id, body_markdown, body_html, author_user_id,
        created_at, updated_at, edited_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [testProjectId, testThreadId, prodComment.body_markdown, prodComment.body_html,
     author, prodComment.created_at, prodComment.updated_at, prodComment.edited_at],
  );
  await testTx.query(
    `INSERT INTO import_map_comments (basecamp_comment_id, local_comment_id)
     VALUES ($1, $2) ON CONFLICT (basecamp_comment_id) DO NOTHING`,
    [lookupKey, ins.rows[0].id],
  );
  return { result: "inserted", test_comment_id: ins.rows[0].id };
}
