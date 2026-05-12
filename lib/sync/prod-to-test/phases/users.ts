// lib/sync/prod-to-test/phases/users.ts
import type { PhaseCtx, PhaseResult, PhaseError } from "./types";

interface ProdUserRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  job_title: string | null;
  timezone: string | null;
  bio: string | null;
  created_at: Date;
}

export async function runUsersPhase(ctx: PhaseCtx): Promise<PhaseResult> {
  const watermark = ctx.watermarks.get("users") ?? new Date(0);
  const limit = ctx.flags.limitPerPhase;

  const sql =
    `select id, email, first_name, last_name, avatar_url, job_title, timezone, bio, created_at
       from user_profiles
       where created_at > $1
       order by created_at asc, id asc` +
    (limit ? ` limit ${Math.max(1, Math.floor(limit))}` : "");
  const prodRes = await ctx.prod.query<ProdUserRow>(sql, [watermark]);

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  const errors: PhaseError[] = [];
  let maxSeen = watermark;

  for (const row of prodRes.rows) {
    try {
      await ctx.test.query("begin");
      const mapped = await ctx.test.query<{ local_id: string }>(
        "select local_id from import_map_prod_users where prod_id = $1",
        [row.id]
      );
      if (mapped.rows.length > 0) {
        await ctx.test.query("commit");
        skipped++;
        if (row.created_at > maxSeen) maxSeen = row.created_at;
        continue;
      }

      const byEmail = await ctx.test.query<{ id: string }>(
        "select id from user_profiles where lower(email) = lower($1) limit 1",
        [row.email]
      );
      let localId: string;
      if (byEmail.rows.length > 0) {
        localId = byEmail.rows[0].id;
      } else {
        localId = row.id;
        await ctx.test.query(
          `insert into user_profiles
             (id, email, first_name, last_name, avatar_url, job_title, timezone, bio)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (id) do nothing`,
          [
            row.id,
            row.email,
            row.first_name,
            row.last_name,
            row.avatar_url,
            row.job_title,
            row.timezone,
            row.bio,
          ]
        );
      }
      await ctx.test.query(
        "insert into import_map_prod_users (prod_id, local_id) values ($1, $2)",
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
    `[users] scanned=${prodRes.rows.length} inserted=${inserted} skipped=${skipped} failed=${failed}`
  );

  return {
    entity: "users",
    scanned: prodRes.rows.length,
    inserted,
    skipped,
    failed,
    newWatermark: maxSeen,
    errors,
  };
}
