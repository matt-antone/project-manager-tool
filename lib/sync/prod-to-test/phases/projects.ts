// lib/sync/prod-to-test/phases/projects.ts
import { randomUUID } from "node:crypto";
import type { PhaseCtx, PhaseResult, PhaseError } from "./types";
import { resolveUserRef } from "./user-ref";

interface ProdProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  archived: boolean;
  created_by: string;
  client_id: string | null;
  project_code: string | null;
  client_slug: string | null;
  project_slug: string | null;
  storage_project_dir: string | null;
  status: string;
  project_seq: number | null;
  tags: string[];
  requestor: string | null;
  deadline: string | null;
  last_activity_at: Date | null;
  pm_note: string | null;
  created_at: Date;
}

async function lookupMap(
  ctx: PhaseCtx,
  table: string,
  prodId: string
): Promise<string | null> {
  const r = await ctx.test.query<{ local_id: string }>(
    `select local_id from ${table} where prod_id = $1`,
    [prodId]
  );
  return r.rows[0]?.local_id ?? null;
}

function suffixFor(localId: string): string {
  return `-p${localId.replace(/-/g, "").slice(0, 8)}`;
}

export async function runProjectsPhase(ctx: PhaseCtx): Promise<PhaseResult> {
  const watermark = ctx.watermarks.get("projects") ?? new Date(0);
  const limit = ctx.flags.limitPerPhase;

  const sql =
    `select id, name, slug, description, archived, created_by, client_id,
            project_code, client_slug, project_slug, storage_project_dir,
            status, project_seq, tags, requestor, deadline, last_activity_at, pm_note,
            created_at
       from projects
       where created_at > $1
       order by created_at asc, id asc` +
    (limit ? ` limit ${Math.max(1, Math.floor(limit))}` : "");
  const prodRes = await ctx.prod.query<ProdProjectRow>(sql, [watermark]);

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  const errors: PhaseError[] = [];
  let maxSeen = watermark;

  for (const row of prodRes.rows) {
    try {
      await ctx.test.query("begin");
      const mapped = await lookupMap(ctx, "import_map_prod_projects", row.id);
      if (mapped) {
        await ctx.test.query("commit");
        skipped++;
        if (row.created_at > maxSeen) maxSeen = row.created_at;
        continue;
      }

      const localClient = row.client_id
        ? await lookupMap(ctx, "import_map_prod_clients", row.client_id)
        : null;
      const localCreatedBy = await resolveUserRef(ctx, row.created_by);

      const localId = randomUUID();
      let slug = row.slug;
      let code = row.project_code;

      const doInsert = async () =>
        ctx.test.query(
          `insert into projects
             (id, name, slug, description, archived, created_by, client_id,
              project_code, client_slug, project_slug, storage_project_dir,
              status, project_seq, tags, requestor, deadline, last_activity_at, pm_note,
              created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            localId,
            row.name,
            slug,
            row.description,
            row.archived,
            localCreatedBy,
            localClient,
            code,
            row.client_slug,
            row.project_slug,
            row.storage_project_dir,
            row.status,
            row.project_seq,
            row.tags,
            row.requestor,
            row.deadline,
            row.last_activity_at,
            row.pm_note,
            row.created_at,
          ]
        );

      try {
        await doInsert();
      } catch (e: any) {
        if (e?.code === "23505") {
          slug = `${row.slug}${suffixFor(localId)}`;
          code = row.project_code ? `${row.project_code}${suffixFor(localId)}` : null;
          await doInsert();
        } else {
          throw e;
        }
      }

      await ctx.test.query(
        "insert into import_map_prod_projects (prod_id, local_id) values ($1, $2)",
        [row.id, localId]
      );
      await ctx.test.query("commit");
      inserted++;
      if (row.created_at > maxSeen) maxSeen = row.created_at;
    } catch (e) {
      await ctx.test.query("rollback").catch(() => {});
      failed++;
      errors.push({ prodId: row.id, reason: (e as Error).message });
    }
  }

  ctx.log(
    `[projects] scanned=${prodRes.rows.length} inserted=${inserted} skipped=${skipped} failed=${failed}`
  );

  return {
    entity: "projects",
    scanned: prodRes.rows.length,
    inserted,
    skipped,
    failed,
    newWatermark: maxSeen,
    errors,
  };
}
