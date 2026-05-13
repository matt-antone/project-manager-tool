import { randomUUID } from "node:crypto";
import type { PhaseCtx, PhaseResult, PhaseError } from "./types";
import { resolveUserRef } from "./user-ref";

interface ProdThreadRow {
  id: string;
  project_id: string;
  title: string;
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

export async function runThreadsPhase(ctx: PhaseCtx): Promise<PhaseResult> {
  const watermark = ctx.watermarks.get("threads") ?? new Date(0);
  const limit = ctx.flags.limitPerPhase;

  // Fetch prod_ids of matched-existing projects so we can exclude their children.
  const matchedRes = await ctx.test.query<{ prod_id: string }>(
    "select prod_id from import_map_prod_projects where matched_existing = true"
  );
  const matchedProdProjectIds = matchedRes.rows.map((r) => r.prod_id);

  const limitClause = limit ? ` limit ${Math.max(1, Math.floor(limit))}` : "";
  const sql =
    `select t.id, t.project_id, t.title, t.body_markdown, t.body_html, t.author_user_id, t.edited_at, t.created_at
       from discussion_threads t
       where exists (
           select 1 from projects p
            where p.id = t.project_id
              and p.archived = false
         )
         and t.project_id <> all($1::uuid[])
       order by t.created_at asc, t.id asc` + limitClause;
  const prodRes = await ctx.prod.query<ProdThreadRow>(sql, [matchedProdProjectIds]);

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  const errors: PhaseError[] = [];
  let maxSeen = watermark;

  for (const row of prodRes.rows) {
    try {
      await ctx.test.query("begin");
      const mapped = await lookupMap(ctx, "import_map_prod_threads", row.id);
      if (mapped) {
        await ctx.test.query("commit");
        skipped++;
        if (row.created_at > maxSeen) maxSeen = row.created_at;
        continue;
      }
      const localProject = await lookupMap(ctx, "import_map_prod_projects", row.project_id);
      if (!localProject) throw new Error(`unresolved project ${row.project_id}`);
      const localAuthor = await resolveUserRef(ctx, row.author_user_id);

      const localId = randomUUID();
      await ctx.test.query(
        `insert into discussion_threads
           (id, project_id, title, body_markdown, body_html, author_user_id, edited_at, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [localId, localProject, row.title, row.body_markdown, row.body_html, localAuthor, row.edited_at, row.created_at]
      );
      await ctx.test.query(
        "insert into import_map_prod_threads (prod_id, local_id) values ($1, $2)",
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
    `[threads] scanned=${prodRes.rows.length} inserted=${inserted} skipped=${skipped} failed=${failed}`
  );

  return {
    entity: "threads",
    kind: "insert",
    scanned: prodRes.rows.length,
    inserted,
    skipped,
    failed,
    newWatermark: maxSeen,
    errors,
  };
}

interface ProdThreadRefreshRow {
  id: string;
  title: string;
  body_markdown: string;
  body_html: string;
  edited_at: Date | null;
}

export async function runThreadsPhaseRefresh(ctx: PhaseCtx): Promise<PhaseResult> {
  const mapRes = await ctx.test.query<{ prod_id: string; local_id: string }>(
    "select prod_id, local_id from import_map_prod_threads"
  );
  if (mapRes.rows.length === 0) {
    ctx.log("[threads:refresh] no mapped threads");
    return { entity: "threads", kind: "refresh", scanned: 0, inserted: 0, skipped: 0, failed: 0, newWatermark: new Date(0), errors: [] };
  }
  const prodIds = mapRes.rows.map((r) => r.prod_id);
  const localByProd = new Map(mapRes.rows.map((r) => [r.prod_id, r.local_id]));

  const limit = ctx.flags.limitPerPhase;
  const limitClause = limit ? ` limit ${Math.max(1, Math.floor(limit))}` : "";

  const prodRes = await ctx.prod.query<ProdThreadRefreshRow>(
    `select id, title, body_markdown, body_html, edited_at
       from discussion_threads
       where id = ANY($1)
       order by id asc` + limitClause,
    [prodIds]
  );

  let updated = 0;
  let failed = 0;
  const errors: PhaseError[] = [];

  for (const row of prodRes.rows) {
    const localId = localByProd.get(row.id);
    if (!localId) continue;
    try {
      await ctx.test.query(
        `update discussion_threads set
            title = $2,
            body_markdown = $3,
            body_html = $4,
            edited_at = $5
          where id = $1`,
        [localId, row.title, row.body_markdown, row.body_html, row.edited_at]
      );
      updated++;
    } catch (e) {
      failed++;
      errors.push({ prodId: row.id, reason: (e as Error).message });
    }
  }

  ctx.log(
    `[threads:refresh] scanned=${prodRes.rows.length} updated=${updated} failed=${failed}`
  );

  return {
    entity: "threads",
    kind: "refresh",
    scanned: prodRes.rows.length,
    inserted: updated,
    skipped: 0,
    failed,
    newWatermark: new Date(0),
    errors,
  };
}
