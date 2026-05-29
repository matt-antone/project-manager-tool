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

async function syncProjectSubTables(
  ctx: PhaseCtx,
  prodProjectId: string,
  localProjectId: string
): Promise<void> {
  // 1. Members
  await ctx.test.query("delete from project_members where project_id = $1", [localProjectId]);
  const membersRes = await ctx.prod.query<{ user_id: string; added_at: Date }>(
    "select user_id, added_at from project_members where project_id = $1",
    [prodProjectId]
  );
  for (const m of membersRes.rows) {
    const localUserId = await resolveUserRef(ctx, m.user_id);
    await ctx.test.query(
      `insert into project_members (project_id, user_id, added_at)
       values ($1, $2, $3)
       on conflict (project_id, user_id) do nothing`,
      [localProjectId, localUserId, m.added_at]
    );
  }

  // 2. Expense lines
  await ctx.test.query(
    "delete from project_expense_lines where project_id = $1",
    [localProjectId]
  );
  const expensesRes = await ctx.prod.query<{
    label: string;
    amount: string;
    sort_order: number;
    created_at: Date;
  }>(
    "select label, amount, sort_order, created_at from project_expense_lines where project_id = $1 order by sort_order, created_at",
    [prodProjectId]
  );
  for (const e of expensesRes.rows) {
    await ctx.test.query(
      `insert into project_expense_lines (project_id, label, amount, sort_order, created_at)
       values ($1, $2, $3, $4, $5)`,
      [localProjectId, e.label, e.amount, e.sort_order, e.created_at]
    );
  }

  // 3. User hours
  await ctx.test.query(
    "delete from project_user_hours where project_id = $1",
    [localProjectId]
  );
  const hoursRes = await ctx.prod.query<{
    user_id: string;
    hours: string;
    created_at: Date;
  }>(
    "select user_id, hours, created_at from project_user_hours where project_id = $1",
    [prodProjectId]
  );
  for (const h of hoursRes.rows) {
    const localUserId = await resolveUserRef(ctx, h.user_id);
    await ctx.test.query(
      `insert into project_user_hours (project_id, user_id, hours, created_at)
       values ($1, $2, $3, $4)
       on conflict (project_id, user_id) do nothing`,
      [localProjectId, localUserId, h.hours, h.created_at]
    );
  }
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
       where archived = false
       order by created_at asc, id asc` +
    (limit ? ` limit ${Math.max(1, Math.floor(limit))}` : "");
  const prodRes = await ctx.prod.query<ProdProjectRow>(sql);

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

      // Try match by project_code first.
      let localId: string | null = null;
      let insertedNewRow = false;

      if (row.project_code) {
        const byCode = await ctx.test.query<{ id: string }>(
          String.raw`select id from projects where regexp_replace(lower(project_code), '^([a-z]+)-0*([0-9]+[a-z]?)$', '\1-\2') = regexp_replace(lower($1), '^([a-z]+)-0*([0-9]+[a-z]?)$', '\1-\2') limit 1`,
          [row.project_code]
        );
        if (byCode.rows.length > 0) {
          localId = byCode.rows[0].id;
        }
      }

      if (!localId) {
        // No existing match — INSERT a new project.
        const localClient = row.client_id
          ? await lookupMap(ctx, "import_map_prod_clients", row.client_id)
          : null;
        const localCreatedBy = await resolveUserRef(ctx, row.created_by);

        localId = randomUUID();
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
        } catch (e) {
          if ((e as { code?: string })?.code === "23505") {
            slug = `${row.slug}${suffixFor(localId)}`;
            code = row.project_code ? `${row.project_code}${suffixFor(localId)}` : null;
            await doInsert();
          } else {
            throw e;
          }
        }
        insertedNewRow = true;
      }

      // matched_existing derived solely from whether doInsert() ran — single source of truth.
      const matchedExisting = !insertedNewRow;
      ctx.log(`[projects] map prod=${row.id} local=${localId} matched_existing=${matchedExisting}`);
      await ctx.test.query(
        "insert into import_map_prod_projects (prod_id, local_id, matched_existing) values ($1, $2, $3)",
        [row.id, localId, matchedExisting]
      );
      await syncProjectSubTables(ctx, row.id, localId);
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
    kind: "insert",
    scanned: prodRes.rows.length,
    inserted,
    skipped,
    failed,
    newWatermark: maxSeen,
    errors,
  };
}

interface ProdProjectRefreshRow {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
  client_id: string | null;
  status: string;
  project_seq: number | null;
  tags: string[];
  requestor: string | null;
  deadline: string | null;
  last_activity_at: Date | null;
  pm_note: string | null;
  project_code: string | null;
  client_slug: string | null;
  project_slug: string | null;
  storage_project_dir: string | null;
}

export async function runProjectsPhaseRefresh(ctx: PhaseCtx): Promise<PhaseResult> {
  // Fetch all active prod projects (archived = false only — complete is NOT archived).
  const prodRes = await ctx.prod.query<ProdProjectRefreshRow>(
    `select id, name, description, archived, client_id, status, project_seq, tags,
            requestor, deadline, last_activity_at, pm_note, project_code, client_slug,
            project_slug, storage_project_dir
       from projects
       where archived = false
       order by id asc`
  );

  let updated = 0;
  let failed = 0;
  const errors: PhaseError[] = [];

  for (const row of prodRes.rows) {
    try {
      await ctx.test.query("begin");

      // 1. Check existing map row (any matched_existing value — both get updated now).
      const mapHit = await ctx.test.query<{ local_id: string }>(
        "select local_id from import_map_prod_projects where prod_id = $1",
        [row.id]
      );
      let localId: string | null = mapHit.rows[0]?.local_id ?? null;

      // 2. No map → try normalized-code match.
      if (!localId && row.project_code) {
        const byCode = await ctx.test.query<{ id: string }>(
          String.raw`select id from projects where regexp_replace(lower(project_code), '^([a-z]+)-0*([0-9]+[a-z]?)$', '\1-\2') = regexp_replace(lower($1), '^([a-z]+)-0*([0-9]+[a-z]?)$', '\1-\2') limit 1`,
          [row.project_code]
        );
        if (byCode.rows.length > 0) {
          localId = byCode.rows[0].id;
          // Write map row for future tracking.
          await ctx.test.query(
            "insert into import_map_prod_projects (prod_id, local_id, matched_existing) values ($1, $2, $3) on conflict (prod_id) do nothing",
            [row.id, localId, true]
          );
        }
      }

      // 3. No map and no code match → skip.
      if (!localId) {
        await ctx.test.query("commit");
        continue;
      }

      // 4. Resolve client_id via client map.
      const localClient = row.client_id
        ? await lookupMap(ctx, "import_map_prod_clients", row.client_id)
        : null;

      // 5. Update mutable fields — identity/chronology columns excluded.
      await ctx.test.query(
        `update projects set
            name = $2,
            description = $3,
            archived = $4,
            client_id = $5,
            status = $6,
            project_seq = $7,
            tags = $8,
            requestor = $9,
            deadline = $10,
            last_activity_at = $11,
            pm_note = $12,
            project_code = $13,
            client_slug = $14,
            project_slug = $15,
            storage_project_dir = $16
          where id = $1`,
        [
          localId,
          row.name,
          row.description,
          row.archived,
          localClient,
          row.status,
          row.project_seq,
          row.tags,
          row.requestor,
          row.deadline,
          row.last_activity_at,
          row.pm_note,
          row.project_code,
          row.client_slug,
          row.project_slug,
          row.storage_project_dir,
        ]
      );
      await syncProjectSubTables(ctx, row.id, localId);
      await ctx.test.query("commit");
      updated++;
    } catch (e) {
      try { await ctx.test.query("rollback"); } catch { /* ignore */ }
      failed++;
      errors.push({ prodId: row.id, reason: (e as Error).message });
    }
  }

  ctx.log(`[projects:refresh] scanned=${prodRes.rows.length} updated=${updated} failed=${failed}`);

  return {
    entity: "projects",
    kind: "refresh",
    scanned: prodRes.rows.length,
    inserted: updated,
    skipped: 0,
    failed,
    newWatermark: new Date(0),
    errors,
  };
}
