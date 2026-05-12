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

  const sql =
    `select id, project_id, title, body_markdown, body_html, author_user_id, edited_at, created_at
       from discussion_threads
       where created_at > $1
       order by created_at asc, id asc` +
    (limit ? ` limit ${Math.max(1, Math.floor(limit))}` : "");
  const prodRes = await ctx.prod.query<ProdThreadRow>(sql, [watermark]);

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
    scanned: prodRes.rows.length,
    inserted,
    skipped,
    failed,
    newWatermark: maxSeen,
    errors,
  };
}
