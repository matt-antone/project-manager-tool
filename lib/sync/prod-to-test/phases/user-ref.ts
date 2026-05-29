// lib/sync/prod-to-test/phases/user-ref.ts
import type { PhaseCtx } from "./types";

interface ProdUserRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  job_title: string | null;
  timezone: string | null;
  bio: string | null;
}

/**
 * Resolve a prod user-id-shaped value (project.created_by, thread.author_user_id,
 * etc.) to its local equivalent. Three-tier:
 *   1. import_map_prod_users hit → return mapped local_id
 *   2. prod user_profiles has a row with this id → auto-import that user (match by
 *      lower(email), insert if no test row), write the map, return local_id
 *   3. prod has no user_profiles row → ref is a free-form token (e.g. "bc2_import");
 *      pass through verbatim. No map row written — the column accepts free text.
 *
 * Assumes the caller is already inside an open transaction on ctx.test.
 */
export async function resolveUserRef(ctx: PhaseCtx, prodUserRef: string): Promise<string> {
  const mapped = await ctx.test.query<{ local_id: string }>(
    "select local_id from import_map_prod_users where prod_id = $1",
    [prodUserRef]
  );
  if (mapped.rows.length > 0) return mapped.rows[0].local_id;

  const prodRes = await ctx.prod.query<ProdUserRow>(
    `select id, email, first_name, last_name, avatar_url, job_title, timezone, bio
       from user_profiles where id = $1`,
    [prodUserRef]
  );
  if (prodRes.rows.length === 0) {
    return prodUserRef;
  }

  const u = prodRes.rows[0];
  const byEmail = await ctx.test.query<{ id: string }>(
    "select id from user_profiles where lower(email) = lower($1) limit 1",
    [u.email]
  );
  let localId: string;
  if (byEmail.rows.length > 0) {
    localId = byEmail.rows[0].id;
  } else {
    localId = u.id;
    await ctx.test.query(
      `insert into user_profiles
         (id, email, first_name, last_name, avatar_url, job_title, timezone, bio)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do nothing`,
      [u.id, u.email, u.first_name, u.last_name, u.avatar_url, u.job_title, u.timezone, u.bio]
    );
  }
  await ctx.test.query(
    `insert into import_map_prod_users (prod_id, local_id) values ($1, $2)
     on conflict (prod_id) do nothing`,
    [u.id, localId]
  );
  return localId;
}
