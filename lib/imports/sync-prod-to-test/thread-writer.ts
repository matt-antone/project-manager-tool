// lib/imports/sync-prod-to-test/thread-writer.ts
import type { Pool, PoolClient } from "pg";
import type { ProdThreadRow } from "./types";
import { findTestUserIdForBc2Placeholder } from "./identity";

export type ThreadWriteResult = "inserted" | "skipped_existing";

function asPoolLike(c: PoolClient): Pool {
  return { query: (sql: string, params?: unknown[]) => c.query(sql, params as never) } as unknown as Pool;
}

export async function writeThread(
  testTx: PoolClient,
  testProjectId: string,
  prodThread: ProdThreadRow,
): Promise<{ result: ThreadWriteResult; test_thread_id: string | null }> {
  if (!prodThread.basecamp_thread_id) {
    return { result: "skipped_existing", test_thread_id: null };
  }
  const existing = await testTx.query(
    `SELECT local_thread_id FROM import_map_threads WHERE basecamp_thread_id = $1 LIMIT 1`,
    [prodThread.basecamp_thread_id],
  );
  if (existing.rows[0]) {
    return { result: "skipped_existing", test_thread_id: existing.rows[0].local_thread_id };
  }
  const author = await findTestUserIdForBc2Placeholder(asPoolLike(testTx), prodThread.author_user_id);
  const ins = await testTx.query(
    `INSERT INTO discussion_threads
       (project_id, title, body_markdown, body_html, author_user_id, created_at, updated_at, edited_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [testProjectId, prodThread.title, prodThread.body_markdown, prodThread.body_html,
     author, prodThread.created_at, prodThread.updated_at, prodThread.edited_at],
  );
  await testTx.query(
    `INSERT INTO import_map_threads (basecamp_thread_id, local_thread_id)
     VALUES ($1, $2) ON CONFLICT (basecamp_thread_id) DO NOTHING`,
    [prodThread.basecamp_thread_id, ins.rows[0].id],
  );
  return { result: "inserted", test_thread_id: ins.rows[0].id };
}
