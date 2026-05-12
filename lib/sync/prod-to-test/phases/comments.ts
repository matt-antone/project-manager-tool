import { randomUUID } from "node:crypto";
import type { PhaseCtx, PhaseResult, PhaseError } from "./types";
import { resolveUserRef } from "./user-ref";

interface ProdCommentRow {
  id: string;
  project_id: string;
  thread_id: string;
  body_markdown: string;
  body_html: string;
  author_user_id: string;
  edited_at: Date | null;
  created_at: Date;
}

async function lookupMap(ctx: PhaseCtx, table: string, prodId: string): Promise<string | null> {
  const r = await ctx.test.query<{ local_id: string }>(
    `select local_id from ${table} where prod_id = $1`,
    [prodId]
  );
  return r.rows[0]?.local_id ?? null;
}

export async function runCommentsPhase(ctx: PhaseCtx): Promise<PhaseResult> {
  const watermark = ctx.watermarks.get("comments") ?? new Date(0);
  const limit = ctx.flags.limitPerPhase;

  // Fetch prod_ids of matched-existing projects so we can exclude their children.
  const matchedRes = await ctx.test.query<{ prod_id: string }>(
    "select prod_id from import_map_prod_projects where matched_existing = true"
  );
  const matchedProdProjectIds = matchedRes.rows.map((r) => r.prod_id);

  const limitClause = limit ? ` limit ${Math.max(1, Math.floor(limit))}` : "";
  const sql =
    `select t.id, t.project_id, t.thread_id, t.body_markdown, t.body_html, t.author_user_id, t.edited_at, t.created_at
       from discussion_comments t
       where t.created_at > $1
         and exists (
           select 1 from projects p
            where p.id = t.project_id
              and p.archived = false
              and (p.status is null or p.status <> 'complete')
         )
         and t.project_id <> all($2::uuid[])
       order by t.created_at asc, t.id asc` + limitClause;
  const prodRes = await ctx.prod.query<ProdCommentRow>(sql, [watermark, matchedProdProjectIds]);

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  const errors: PhaseError[] = [];
  let maxSeen = watermark;

  for (const row of prodRes.rows) {
    try {
      await ctx.test.query("begin");
      const mapped = await lookupMap(ctx, "import_map_prod_comments", row.id);
      if (mapped) {
        await ctx.test.query("commit");
        skipped++;
        if (row.created_at > maxSeen) maxSeen = row.created_at;
        continue;
      }
      const localThread = await lookupMap(ctx, "import_map_prod_threads", row.thread_id);
      if (!localThread) throw new Error(`unresolved thread ${row.thread_id}`);
      const localAuthor = await resolveUserRef(ctx, row.author_user_id);

      const projRes = await ctx.test.query<{ project_id: string }>(
        "select project_id from discussion_threads where id = $1",
        [localThread]
      );
      const localProject = projRes.rows[0]?.project_id;
      if (!localProject) throw new Error(`local thread ${localThread} missing project_id`);

      const localId = randomUUID();
      await ctx.test.query(
        `insert into discussion_comments
           (id, project_id, thread_id, body_markdown, body_html, author_user_id, edited_at, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          localId,
          localProject,
          localThread,
          row.body_markdown,
          row.body_html,
          localAuthor,
          row.edited_at,
          row.created_at,
        ]
      );
      await ctx.test.query(
        "insert into import_map_prod_comments (prod_id, local_id) values ($1, $2)",
        [row.id, localId]
      );
      await ctx.test.query("commit");
      inserted++;
      if (row.created_at > maxSeen) maxSeen = row.created_at;
    } catch (e) {
      try { await ctx.test.query("rollback"); } catch { /* ignore */ }
      failed++;
      errors.push({ prodId: row.id, reason: (e as Error).message });
    }
  }

  ctx.log(
    `[comments] scanned=${prodRes.rows.length} inserted=${inserted} skipped=${skipped} failed=${failed}`
  );

  return {
    entity: "comments",
    scanned: prodRes.rows.length,
    inserted,
    skipped,
    failed,
    newWatermark: maxSeen,
    errors,
  };
}
