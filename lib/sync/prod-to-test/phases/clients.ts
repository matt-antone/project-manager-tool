// lib/sync/prod-to-test/phases/clients.ts
import { randomUUID } from "node:crypto";
import type { PhaseCtx, PhaseResult, PhaseError } from "./types";

interface ProdClientRow {
  id: string;
  code: string;
  name: string;
  archived_at: Date | null;
  dropbox_archive_status: string;
  archive_started_at: Date | null;
  archive_error: string | null;
  github_repos: string[];
  domains: string[];
  created_at: Date;
}

export async function runClientsPhase(ctx: PhaseCtx): Promise<PhaseResult> {
  const watermark = ctx.watermarks.get("clients") ?? new Date(0);
  const limit = ctx.flags.limitPerPhase;

  const sql =
    `select id, code, name, archived_at, dropbox_archive_status, archive_started_at,
            archive_error, github_repos, domains, created_at
       from clients
       where created_at > $1
       order by created_at asc, id asc` +
    (limit ? ` limit ${Math.max(1, Math.floor(limit))}` : "");
  const prodRes = await ctx.prod.query<ProdClientRow>(sql, [watermark]);

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  const errors: PhaseError[] = [];
  let maxSeen = watermark;

  for (const row of prodRes.rows) {
    try {
      await ctx.test.query("begin");
      const existingMap = await ctx.test.query<{ local_id: string }>(
        "select local_id from import_map_prod_clients where prod_id = $1",
        [row.id]
      );
      if (existingMap.rows.length > 0) {
        await ctx.test.query("commit");
        skipped++;
        if (row.created_at > maxSeen) maxSeen = row.created_at;
        continue;
      }

      const byCode = await ctx.test.query<{ id: string }>(
        "select id from clients where lower(code) = lower($1) limit 1",
        [row.code]
      );
      let localId: string;
      if (byCode.rows.length > 0) {
        localId = byCode.rows[0].id;
      } else {
        localId = randomUUID();
        await ctx.test.query(
          `insert into clients
             (id, code, name, archived_at, dropbox_archive_status, archive_started_at,
              archive_error, github_repos, domains, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            localId,
            row.code,
            row.name,
            row.archived_at,
            row.dropbox_archive_status,
            row.archive_started_at,
            row.archive_error,
            row.github_repos,
            row.domains,
            row.created_at,
          ]
        );
      }
      await ctx.test.query(
        "insert into import_map_prod_clients (prod_id, local_id) values ($1, $2)",
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
    `[clients] scanned=${prodRes.rows.length} inserted=${inserted} skipped=${skipped} failed=${failed}`
  );

  return {
    entity: "clients",
    scanned: prodRes.rows.length,
    inserted,
    skipped,
    failed,
    newWatermark: maxSeen,
    errors,
  };
}
