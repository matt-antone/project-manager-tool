// lib/imports/sync-prod-to-test/identity.ts
import type { Pool } from "pg";

export function normalizeCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const m = code.match(/^([A-Za-z]+)-0*(\d+)$/);
  return m ? `${m[1].toUpperCase()}-${m[2]}` : code;
}

export function padCodeVariants(code: string | null | undefined): string[] {
  if (!code) return [];
  const m = code.match(/^([A-Za-z]+)-(\d+)$/);
  if (!m) return [code];
  const prefix = m[1].toUpperCase(), numStr = m[2];
  const num = parseInt(numStr, 10);
  // If the numeric value is < 1000, generate both 4-digit and 3-digit variants
  if (num < 1000) {
    const variants = new Set<string>();
    variants.add(`${prefix}-${String(num).padStart(4, "0")}`);
    variants.add(`${prefix}-${String(num).padStart(3, "0")}`);
    return [...variants].sort();
  }
  return [code];
}

export async function findTestUserIdForBc2Placeholder(
  test: Pool,
  authorUserId: string | null,
): Promise<string | null> {
  if (!authorUserId) return null;
  const m = authorUserId.match(/^bc2_(\d+)$/);
  if (!m) return authorUserId;
  const r = await test.query(
    `SELECT local_user_profile_id FROM import_map_people WHERE basecamp_person_id = $1`,
    [m[1]],
  );
  return r.rows[0]?.local_user_profile_id ?? authorUserId;
}

export interface TestProjectMatch {
  test_project_id: string;
  match_kind: "by_basecamp_id" | "exact_code" | "padded_code" | "slug_name";
}

export async function resolveTestThreadIdForProdThread(
  prod: Pool,
  test: Pool,
  prodThreadId: string,
): Promise<string | null> {
  // Get prod's basecamp_thread_id (if any) for this prod thread row.
  const r = await prod.query(
    `SELECT m.basecamp_thread_id
       FROM import_map_threads m
       WHERE m.local_thread_id = $1
       LIMIT 1`,
    [prodThreadId],
  );
  const bc = r.rows[0]?.basecamp_thread_id ?? null;
  const lookupKey = bc ?? `prod_native_${prodThreadId}`;
  const t = await test.query(
    `SELECT local_thread_id FROM import_map_threads WHERE basecamp_thread_id = $1 LIMIT 1`,
    [lookupKey],
  );
  return t.rows[0]?.local_thread_id ?? null;
}

export async function resolveTestCommentIdForProdComment(
  prod: Pool,
  test: Pool,
  prodCommentId: string,
): Promise<string | null> {
  const r = await prod.query(
    `SELECT m.basecamp_comment_id
       FROM import_map_comments m
       WHERE m.local_comment_id = $1
       LIMIT 1`,
    [prodCommentId],
  );
  const bc = r.rows[0]?.basecamp_comment_id ?? null;
  const lookupKey = bc ?? `prod_native_${prodCommentId}`;
  const t = await test.query(
    `SELECT local_comment_id FROM import_map_comments WHERE basecamp_comment_id = $1 LIMIT 1`,
    [lookupKey],
  );
  return t.rows[0]?.local_comment_id ?? null;
}

export async function findTestProjectMatch(
  test: Pool,
  bcProjectIds: string[],
  prodCode: string | null,
  clientSlug: string | null,
  projectSlug: string | null,
  name: string | null,
): Promise<TestProjectMatch | null> {
  if (bcProjectIds.length > 0) {
    const r = await test.query(
      `SELECT local_project_id FROM import_map_projects
        WHERE basecamp_project_id = ANY($1::text[]) LIMIT 1`,
      [bcProjectIds],
    );
    if (r.rows[0]) return { test_project_id: r.rows[0].local_project_id, match_kind: "by_basecamp_id" };
  }
  if (prodCode) {
    const r = await test.query(`SELECT id FROM projects WHERE project_code = $1 LIMIT 1`, [prodCode]);
    if (r.rows[0]) return { test_project_id: r.rows[0].id, match_kind: "exact_code" };
  }
  const variants = padCodeVariants(prodCode);
  for (const v of variants) {
    if (v === prodCode) continue;
    const r = await test.query(`SELECT id FROM projects WHERE project_code = $1 LIMIT 1`, [v]);
    if (r.rows[0]) return { test_project_id: r.rows[0].id, match_kind: "padded_code" };
  }
  if (clientSlug && projectSlug && name) {
    const r = await test.query(
      `SELECT id FROM projects
        WHERE client_slug = $1 AND project_slug = $2 AND name = $3
        LIMIT 1`,
      [clientSlug, projectSlug, name],
    );
    if (r.rows[0]) return { test_project_id: r.rows[0].id, match_kind: "slug_name" };
  }
  return null;
}
