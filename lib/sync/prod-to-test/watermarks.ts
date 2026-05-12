import type { Pool } from "pg";

export const ENTITY_NAMES = [
  "clients",
  "users",
  "projects",
  "threads",
  "comments",
  "files",
] as const;

export type EntityName = (typeof ENTITY_NAMES)[number];

export type WatermarkMap = Map<EntityName, Date>;

export async function loadWatermarks(pool: Pool): Promise<WatermarkMap> {
  const res = await pool.query<{ entity: string; last_synced_at: Date }>(
    "select entity, last_synced_at from sync_prod_watermarks"
  );
  const map: WatermarkMap = new Map();
  for (const e of ENTITY_NAMES) map.set(e, new Date(0));
  for (const row of res.rows) {
    if ((ENTITY_NAMES as readonly string[]).includes(row.entity)) {
      map.set(row.entity as EntityName, new Date(row.last_synced_at));
    }
  }
  return map;
}

export async function saveWatermark(
  pool: Pool,
  entity: EntityName,
  newWatermark: Date
): Promise<void> {
  await pool.query(
    `insert into sync_prod_watermarks (entity, last_synced_at, last_run_at)
     values ($1, $2, now())
     on conflict (entity) do update
       set last_synced_at = excluded.last_synced_at,
           last_run_at    = now()`,
    [entity, newWatermark]
  );
}
