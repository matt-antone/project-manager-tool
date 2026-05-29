# Prod → Test Forward Importer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a one-shot CLI (`pnpm sync:prod-to-test`) that incrementally copies new prod content (projects, threads, comments, files+bytes) into the test DB with fresh UUIDs, per-entity prod-id → local-id maps, automatic FK parent creation for clients/users, idempotent re-runs, and an enforced `pg_dump` backup of the test DB before any writes.

**Architecture:** Single `scripts/sync-prod-to-test.ts` orchestrator that runs ordered phase modules under `lib/sync/prod-to-test/phases/`. Each phase reads from prod, writes to test inside a transaction, records its mapping in a per-entity `import_map_prod_*` table, advances its row in `sync_prod_watermarks` only on a clean run, and tolerates per-row errors without aborting the orchestrator.

**Tech Stack:** TypeScript, `pg` Pool, `@supabase/supabase-js` for storage, Vitest unit tests, `pg_dump` for the backup step, existing repo conventions (`@/` alias, `.env.local` loader, `npx tsx` script invocation, `pnpm` task runner).

**Source spec:** `docs/superpowers/specs/2026-05-12-prod-to-test-forward-importer-design.md` (commit `80426a3`).

---

## Schema findings the spec didn't fully resolve

These were uncovered while writing the plan and override the spec where they differ:

1. **`user_profiles.id` is `text`, not `uuid`** (supabase auth id string). Therefore `import_map_prod_users.local_id` must be `text`. The user phase still matches by `email`; when no test row matches, a new `user_profiles` row is inserted using prod's `id` value verbatim (it's a free-form text key, not a uuid bound to `auth.users` in test).
2. **`projects` has two unique identity columns: `slug` (unique) and `project_code` (unique).** On insert collision, the projects phase appends `-p<8charPrefix>` (8-char prefix of `local_id`) to both `slug` and `project_code` and retries the insert once.
3. **`project_files` always requires `project_id`**; `thread_id` and `comment_id` are nullable. The constraint `project_files_comment_requires_thread` means if `comment_id` is set, `thread_id` must also be set. The files phase preserves whichever of (project / project+thread / project+thread+comment) the prod row had.
4. **User-id-shaped columns are `text` everywhere** they appear (`projects.created_by`, `discussion_threads.author_user_id`, `discussion_comments.author_user_id`, `project_files.uploader_user_id`). Resolution always goes through `import_map_prod_users` to get the `text` `local_id`.

## File structure

```
supabase/migrations/
  0030_sync_prod_maps.sql                   # new

scripts/
  sync-prod-to-test.ts                      # new, CLI entry

lib/sync/prod-to-test/
  safety.ts                                 # env-equality + host-hint guards
  backup.ts                                 # pooler URL helper + pg_dump spawn
  watermarks.ts                             # read/write sync_prod_watermarks
  context.ts                                # PhaseCtx builder, pool + storage clients
  phases/
    types.ts                                # PhaseCtx, PhaseResult, EntityName
    clients.ts
    users.ts
    projects.ts
    threads.ts
    comments.ts
    files.ts

tests/unit/sync/prod-to-test/
  safety.test.ts
  backup.test.ts
  watermarks.test.ts
  phases/
    clients.test.ts
    users.test.ts
    projects.test.ts
    threads.test.ts
    comments.test.ts
    files.test.ts

package.json                                # add "sync:prod-to-test" script
```

Each phase is a self-contained module (one responsibility: read prod, decide, write test, return result). Tests mirror source paths under `tests/unit/`.

---

## Task 1: Migration — sync_prod_* tables

**Files:**
- Create: `supabase/migrations/0030_sync_prod_maps.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0030_sync_prod_maps.sql
-- Prod → Test forward importer: watermark + per-entity prod-id → local-id maps.
-- See docs/superpowers/specs/2026-05-12-prod-to-test-forward-importer-design.md.

create table if not exists sync_prod_watermarks (
  entity         text primary key,
  last_synced_at timestamptz not null,
  last_run_at    timestamptz not null default now()
);

create table if not exists import_map_prod_clients (
  prod_id  uuid primary key,
  local_id uuid not null
);

create table if not exists import_map_prod_users (
  prod_id  text primary key,
  local_id text not null
);

create table if not exists import_map_prod_projects (
  prod_id  uuid primary key,
  local_id uuid not null
);

create table if not exists import_map_prod_threads (
  prod_id  uuid primary key,
  local_id uuid not null
);

create table if not exists import_map_prod_comments (
  prod_id  uuid primary key,
  local_id uuid not null
);

create table if not exists import_map_prod_files (
  prod_id  uuid primary key,
  local_id uuid not null
);
```

- [ ] **Step 2: Apply migration to test DB**

Run: `pnpm supabase db push` (or the repo's standard apply command — confirm by checking `package.json` and `supabase/config.toml`).
Expected: migration applied without error; new tables visible via `supabase__list_tables` or `psql \dt`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0030_sync_prod_maps.sql
git commit -m "feat(sync): add sync_prod_watermarks and import_map_prod_* tables"
```

---

## Task 2: Safety guards module

**Files:**
- Create: `lib/sync/prod-to-test/safety.ts`
- Test: `tests/unit/sync/prod-to-test/safety.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/sync/prod-to-test/safety.test.ts
import { describe, it, expect } from "vitest";
import { assertEnvSafe, SafetyError } from "@/lib/sync/prod-to-test/safety";

describe("assertEnvSafe", () => {
  it("throws if PROD_DATABASE_URL equals DATABASE_URL", () => {
    expect(() =>
      assertEnvSafe({
        prodUrl: "postgres://x@h/db",
        testUrl: "postgres://x@h/db",
        prodHostHint: undefined,
      })
    ).toThrow(SafetyError);
  });

  it("throws if test url host contains the prod host hint", () => {
    expect(() =>
      assertEnvSafe({
        prodUrl: "postgres://x@prod.example.com/db",
        testUrl: "postgres://x@prod-staging.example.com/db",
        prodHostHint: "prod",
      })
    ).toThrow(/looks like prod/i);
  });

  it("passes when urls differ and host hint not matched", () => {
    expect(() =>
      assertEnvSafe({
        prodUrl: "postgres://x@prod.example.com/db",
        testUrl: "postgres://x@test.example.com/db",
        prodHostHint: "prod",
      })
    ).not.toThrow();
  });

  it("passes when host hint env is unset", () => {
    expect(() =>
      assertEnvSafe({
        prodUrl: "postgres://x@a.example.com/db",
        testUrl: "postgres://x@b.example.com/db",
        prodHostHint: undefined,
      })
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/sync/prod-to-test/safety.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/sync/prod-to-test/safety.ts
export class SafetyError extends Error {}

export interface SafetyInput {
  prodUrl: string;
  testUrl: string;
  prodHostHint: string | undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function assertEnvSafe(input: SafetyInput): void {
  if (!input.prodUrl || !input.testUrl) {
    throw new SafetyError("PROD_DATABASE_URL and DATABASE_URL must both be set");
  }
  if (input.prodUrl === input.testUrl) {
    throw new SafetyError(
      "PROD_DATABASE_URL must not equal DATABASE_URL — refusing to write to prod"
    );
  }
  if (input.prodHostHint && input.prodHostHint.trim() !== "") {
    const testHost = hostOf(input.testUrl);
    if (testHost.includes(input.prodHostHint)) {
      throw new SafetyError(
        `DATABASE_URL host "${testHost}" looks like prod (matched hint "${input.prodHostHint}")`
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/sync/prod-to-test/safety.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/prod-to-test/safety.ts tests/unit/sync/prod-to-test/safety.test.ts
git commit -m "feat(sync): env-safety guards for prod→test importer"
```

---

## Task 3: Backup runner

**Files:**
- Create: `lib/sync/prod-to-test/backup.ts`
- Test: `tests/unit/sync/prod-to-test/backup.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/sync/prod-to-test/backup.test.ts
import { describe, it, expect } from "vitest";
import { toPoolerUrl, buildBackupPath } from "@/lib/sync/prod-to-test/backup";

describe("toPoolerUrl", () => {
  it("rewrites :6543 to :5432", () => {
    expect(
      toPoolerUrl("postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres")
    ).toBe("postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres");
  });

  it("leaves :5432 unchanged", () => {
    expect(
      toPoolerUrl("postgresql://u:p@host:5432/postgres")
    ).toBe("postgresql://u:p@host:5432/postgres");
  });

  it("leaves urls with no port unchanged", () => {
    expect(toPoolerUrl("postgresql://u:p@host/postgres"))
      .toBe("postgresql://u:p@host/postgres");
  });
});

describe("buildBackupPath", () => {
  it("formats path as backups/sync-prod-YYYYMMDD-HHMMSS.dump", () => {
    const ts = new Date("2026-05-12T15:04:05Z");
    expect(buildBackupPath("backups", ts))
      .toMatch(/^backups\/sync-prod-20260512-\d{6}\.dump$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/sync/prod-to-test/backup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/sync/prod-to-test/backup.ts
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export class BackupError extends Error {}

export function toPoolerUrl(databaseUrl: string): string {
  return databaseUrl.replace(/:6543\b/, ":5432");
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

export function buildBackupPath(dir: string, now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const HH = pad(now.getUTCHours());
  const MM = pad(now.getUTCMinutes());
  const SS = pad(now.getUTCSeconds());
  return path.posix.join(dir, `sync-prod-${yyyy}${mm}${dd}-${HH}${MM}${SS}.dump`);
}

export interface RunBackupOptions {
  databaseUrl: string;
  backupDir: string;
  now?: Date;
  log?: (msg: string) => void;
}

export interface BackupResult {
  path: string;
  bytes: number;
}

export async function runBackup(opts: RunBackupOptions): Promise<BackupResult> {
  const log = opts.log ?? ((m: string) => process.stdout.write(m + "\n"));
  await fs.mkdir(opts.backupDir, { recursive: true });
  const outPath = buildBackupPath(opts.backupDir, opts.now);
  const pgUrl = toPoolerUrl(opts.databaseUrl);

  log(`[backup] running pg_dump → ${outPath}`);
  await new Promise<void>((resolveP, rejectP) => {
    const child = spawn("pg_dump", ["-F", "c", "-d", pgUrl, "-f", outPath], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", (e) =>
      rejectP(new BackupError(`pg_dump failed to start: ${e.message}`))
    );
    child.on("exit", (code) => {
      if (code === 0) resolveP();
      else rejectP(new BackupError(`pg_dump exited with code ${code}`));
    });
  });

  const stat = await fs.stat(outPath).catch(() => null);
  if (!stat || stat.size === 0) {
    throw new BackupError(`pg_dump output missing or empty: ${outPath}`);
  }
  log(`[backup] wrote ${stat.size} bytes`);
  return { path: outPath, bytes: stat.size };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/sync/prod-to-test/backup.test.ts`
Expected: PASS, 4/4. (`runBackup` itself is not unit-tested — it spawns a binary; it's exercised by the manual integration run in Task 14.)

- [ ] **Step 5: Commit**

```bash
git add lib/sync/prod-to-test/backup.ts tests/unit/sync/prod-to-test/backup.test.ts
git commit -m "feat(sync): pg_dump backup runner + pooler URL helper"
```

---

## Task 4: Watermarks module

**Files:**
- Create: `lib/sync/prod-to-test/watermarks.ts`
- Test: `tests/unit/sync/prod-to-test/watermarks.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/sync/prod-to-test/watermarks.test.ts
import { describe, it, expect, vi } from "vitest";
import { loadWatermarks, saveWatermark, ENTITY_NAMES } from "@/lib/sync/prod-to-test/watermarks";

function fakePool(rows: Array<{ entity: string; last_synced_at: Date }>) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as any;
}

describe("loadWatermarks", () => {
  it("returns an epoch-zero default for entities with no row", async () => {
    const pool = fakePool([]);
    const wm = await loadWatermarks(pool);
    for (const e of ENTITY_NAMES) {
      expect(wm.get(e)?.getTime()).toBe(0);
    }
  });

  it("returns the stored timestamp when present", async () => {
    const t = new Date("2026-05-01T00:00:00Z");
    const pool = fakePool([{ entity: "projects", last_synced_at: t }]);
    const wm = await loadWatermarks(pool);
    expect(wm.get("projects")?.toISOString()).toBe(t.toISOString());
    expect(wm.get("clients")?.getTime()).toBe(0);
  });
});

describe("saveWatermark", () => {
  it("upserts the row for that entity", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as any;
    const t = new Date("2026-05-12T00:00:00Z");
    await saveWatermark(pool, "projects", t);
    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/insert into sync_prod_watermarks/i);
    expect(sql).toMatch(/on conflict \(entity\) do update/i);
    expect(params).toEqual(["projects", t]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/sync/prod-to-test/watermarks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/sync/prod-to-test/watermarks.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/sync/prod-to-test/watermarks.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/prod-to-test/watermarks.ts tests/unit/sync/prod-to-test/watermarks.test.ts
git commit -m "feat(sync): watermark load/save for sync_prod_watermarks"
```

---

## Task 5: Phase types

**Files:**
- Create: `lib/sync/prod-to-test/phases/types.ts`

- [ ] **Step 1: Write the file**

```ts
// lib/sync/prod-to-test/phases/types.ts
import type { Pool } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EntityName, WatermarkMap } from "@/lib/sync/prod-to-test/watermarks";

export interface CliFlags {
  phase: EntityName | null;
  limitPerPhase: number | null;
  noBackup: boolean;
  iKnowWhatImDoing: boolean;
}

export interface PhaseCtx {
  prod: Pool;
  test: Pool;
  prodStorage: SupabaseClient;
  testStorage: SupabaseClient;
  watermarks: WatermarkMap;
  flags: CliFlags;
  log: (msg: string) => void;
}

export interface PhaseError {
  prodId: string;
  reason: string;
}

export interface PhaseResult {
  entity: EntityName;
  scanned: number;
  inserted: number;
  skipped: number;
  failed: number;
  newWatermark: Date;
  errors: PhaseError[];
}

export type RunPhase = (ctx: PhaseCtx) => Promise<PhaseResult>;
```

- [ ] **Step 2: Commit**

```bash
git add lib/sync/prod-to-test/phases/types.ts
git commit -m "feat(sync): phase context + result types"
```

---

## Task 6: Clients phase

**Files:**
- Create: `lib/sync/prod-to-test/phases/clients.ts`
- Test: `tests/unit/sync/prod-to-test/phases/clients.test.ts`

This phase is the simplest pattern and establishes the per-row transaction shape every later phase repeats.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/sync/prod-to-test/phases/clients.test.ts
import { describe, it, expect, vi } from "vitest";
import { runClientsPhase } from "@/lib/sync/prod-to-test/phases/clients";
import type { PhaseCtx } from "@/lib/sync/prod-to-test/phases/types";

function makeCtx(overrides: Partial<PhaseCtx> = {}): PhaseCtx {
  const prodQuery = vi.fn();
  const testQuery = vi.fn();
  const testConnect = vi.fn(async () => ({
    query: testQuery,
    release: vi.fn(),
  }));
  const watermarks = new Map();
  watermarks.set("clients", new Date(0));
  return {
    prod: { query: prodQuery } as any,
    test: { query: testQuery, connect: testConnect } as any,
    prodStorage: {} as any,
    testStorage: {} as any,
    watermarks,
    flags: { phase: null, limitPerPhase: null, noBackup: false, iKnowWhatImDoing: false },
    log: () => {},
    ...overrides,
  };
}

describe("runClientsPhase", () => {
  it("inserts a new client when no test row matches by code", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any)
      .mockResolvedValueOnce({
        rows: [
          { id: "11111111-1111-1111-1111-111111111111", code: "ACME", name: "Acme Inc", created_at: new Date("2026-04-01T00:00:00Z") },
        ],
      });
    const testQuery = (ctx.test as any).query as ReturnType<typeof vi.fn>;
    testQuery.mockImplementation((sql: string) => {
      if (/begin/i.test(sql)) return { rows: [] };
      if (/commit/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_clients/i.test(sql)) return { rows: [] };
      if (/from clients where lower\(code\)/i.test(sql)) return { rows: [] };
      if (/insert into clients/i.test(sql)) return { rows: [] };
      if (/insert into import_map_prod_clients/i.test(sql)) return { rows: [] };
      return { rows: [] };
    });

    const result = await runClientsPhase(ctx);
    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.newWatermark.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("reuses existing test client (by code) and only writes the map row", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValueOnce({
      rows: [
        { id: "22222222-2222-2222-2222-222222222222", code: "BETA", name: "Beta", created_at: new Date("2026-04-02T00:00:00Z") },
      ],
    });
    const inserts: string[] = [];
    (ctx.test as any).query = vi.fn((sql: string) => {
      if (/insert into clients/i.test(sql)) inserts.push(sql);
      if (/from clients where lower\(code\)/i.test(sql)) {
        return { rows: [{ id: "99999999-9999-9999-9999-999999999999" }] };
      }
      if (/from import_map_prod_clients/i.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const result = await runClientsPhase(ctx);
    expect(result.inserted).toBe(1);
    expect(inserts).toHaveLength(0);
  });

  it("skips when import_map_prod_clients already has the prod id", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValueOnce({
      rows: [
        { id: "33333333-3333-3333-3333-333333333333", code: "GAMMA", name: "Gamma", created_at: new Date("2026-04-03T00:00:00Z") },
      ],
    });
    (ctx.test as any).query = vi.fn((sql: string) => {
      if (/from import_map_prod_clients/i.test(sql)) {
        return { rows: [{ local_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }] };
      }
      return { rows: [] };
    });
    const result = await runClientsPhase(ctx);
    expect(result.skipped).toBe(1);
    expect(result.inserted).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/sync/prod-to-test/phases/clients.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/sync/prod-to-test/phases/clients.ts
import { randomUUID } from "node:crypto";
import type { PhaseCtx, PhaseResult, PhaseError } from "./types";

interface ProdClientRow {
  id: string;
  code: string;
  name: string;
  created_at: Date;
}

export async function runClientsPhase(ctx: PhaseCtx): Promise<PhaseResult> {
  const watermark = ctx.watermarks.get("clients") ?? new Date(0);
  const limit = ctx.flags.limitPerPhase;

  const sql =
    `select id, code, name, created_at
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
          "insert into clients (id, code, name) values ($1, $2, $3)",
          [localId, row.code, row.name]
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/sync/prod-to-test/phases/clients.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/prod-to-test/phases/clients.ts tests/unit/sync/prod-to-test/phases/clients.test.ts
git commit -m "feat(sync): clients phase — match by code, insert when new"
```

---

## Task 7: Users phase

**Files:**
- Create: `lib/sync/prod-to-test/phases/users.ts`
- Test: `tests/unit/sync/prod-to-test/phases/users.test.ts`

`user_profiles.id` is `text` (Supabase auth id). Match by email; if no match, insert using prod's `id` verbatim — these are free-form text keys in test (no `auth.users` FK on `public.user_profiles`).

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/sync/prod-to-test/phases/users.test.ts
import { describe, it, expect, vi } from "vitest";
import { runUsersPhase } from "@/lib/sync/prod-to-test/phases/users";
import type { PhaseCtx } from "@/lib/sync/prod-to-test/phases/types";

function makeCtx(): PhaseCtx {
  const watermarks = new Map();
  watermarks.set("users", new Date(0));
  return {
    prod: { query: vi.fn() } as any,
    test: { query: vi.fn() } as any,
    prodStorage: {} as any,
    testStorage: {} as any,
    watermarks,
    flags: { phase: null, limitPerPhase: null, noBackup: false, iKnowWhatImDoing: false },
    log: () => {},
  };
}

describe("runUsersPhase", () => {
  it("matches by email when existing test user found", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValueOnce({
      rows: [{
        id: "prod-user-1",
        email: "Alice@Example.com",
        first_name: "Alice",
        last_name: "Z",
        avatar_url: null,
        job_title: null,
        timezone: null,
        bio: null,
        created_at: new Date("2026-04-01T00:00:00Z"),
      }],
    });
    const inserts: string[] = [];
    (ctx.test as any).query = vi.fn((sql: string) => {
      if (/from import_map_prod_users/i.test(sql)) return { rows: [] };
      if (/from user_profiles where lower\(email\)/i.test(sql)) {
        return { rows: [{ id: "existing-local-user" }] };
      }
      if (/insert into user_profiles/i.test(sql)) inserts.push(sql);
      return { rows: [] };
    });
    const result = await runUsersPhase(ctx);
    expect(result.inserted).toBe(1);
    expect(inserts).toHaveLength(0);
  });

  it("inserts a new user_profile using prod's id when no email match", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValueOnce({
      rows: [{
        id: "prod-user-2",
        email: "bob@example.com",
        first_name: "Bob",
        last_name: null,
        avatar_url: null,
        job_title: null,
        timezone: null,
        bio: null,
        created_at: new Date("2026-04-02T00:00:00Z"),
      }],
    });
    const inserts: Array<[string, any[]]> = [];
    (ctx.test as any).query = vi.fn((sql: string, params?: any[]) => {
      if (/from import_map_prod_users/i.test(sql)) return { rows: [] };
      if (/from user_profiles where lower\(email\)/i.test(sql)) return { rows: [] };
      if (/insert into user_profiles/i.test(sql)) inserts.push([sql, params ?? []]);
      return { rows: [] };
    });
    const result = await runUsersPhase(ctx);
    expect(result.inserted).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1][0]).toBe("prod-user-2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/sync/prod-to-test/phases/users.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/sync/prod-to-test/phases/users.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/prod-to-test/phases/users.ts tests/unit/sync/prod-to-test/phases/users.test.ts
git commit -m "feat(sync): users phase — match by email, insert with prod id"
```

---

## Task 8: Projects phase (with FK resolver + slug collision retry)

**Files:**
- Create: `lib/sync/prod-to-test/phases/projects.ts`
- Test: `tests/unit/sync/prod-to-test/phases/projects.test.ts`

Introduces the **FK resolver helper**: given a prod parent id and a map table name, return the local id; if missing, fetch the parent row from prod and run its phase for just that one row, then look up the map again.

For projects: parent FK is `client_id` (via `import_map_prod_clients`); `created_by` is resolved via `import_map_prod_users`. On `slug` or `project_code` unique violation (`'23505'`), retry once with `-p<8charPrefix>` suffix.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/sync/prod-to-test/phases/projects.test.ts
import { describe, it, expect, vi } from "vitest";
import { runProjectsPhase } from "@/lib/sync/prod-to-test/phases/projects";
import type { PhaseCtx } from "@/lib/sync/prod-to-test/phases/types";

function makeCtx(): PhaseCtx {
  const watermarks = new Map();
  watermarks.set("projects", new Date(0));
  watermarks.set("clients", new Date(0));
  watermarks.set("users", new Date(0));
  return {
    prod: { query: vi.fn() } as any,
    test: { query: vi.fn() } as any,
    prodStorage: {} as any,
    testStorage: {} as any,
    watermarks,
    flags: { phase: null, limitPerPhase: null, noBackup: false, iKnowWhatImDoing: false },
    log: () => {},
  };
}

const sampleProdProject = {
  id: "p1",
  name: "New Project",
  slug: "new-project",
  description: null,
  archived: false,
  created_by: "prod-user-1",
  client_id: "c1",
  project_code: "ACME-0042",
  client_slug: "acme",
  project_slug: "new-project",
  storage_project_dir: "acme/new-project",
  created_at: new Date("2026-04-15T00:00:00Z"),
};

describe("runProjectsPhase", () => {
  it("inserts a new project, resolving client_id and created_by via maps", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({ rows: [sampleProdProject] });

    const seen: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      seen.push({ sql, params });
      if (/from import_map_prod_projects/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_clients/i.test(sql)) {
        return { rows: [{ local_id: "local-client-1" }] };
      }
      if (/from import_map_prod_users/i.test(sql)) {
        return { rows: [{ local_id: "local-user-1" }] };
      }
      return { rows: [] };
    });

    const result = await runProjectsPhase(ctx);
    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(0);
    const insertProj = seen.find((s) => /insert into projects/i.test(s.sql));
    expect(insertProj).toBeTruthy();
    expect(insertProj!.params).toContain("local-client-1");
    expect(insertProj!.params).toContain("local-user-1");
  });

  it("retries with -p<prefix> suffix on slug/project_code unique violation", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({ rows: [sampleProdProject] });

    let projectInsertCalls = 0;
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      if (/from import_map_prod_projects/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_clients/i.test(sql)) return { rows: [{ local_id: "lc" }] };
      if (/from import_map_prod_users/i.test(sql)) return { rows: [{ local_id: "lu" }] };
      if (/insert into projects/i.test(sql)) {
        projectInsertCalls++;
        if (projectInsertCalls === 1) {
          const err: any = new Error("duplicate key");
          err.code = "23505";
          throw err;
        }
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await runProjectsPhase(ctx);
    expect(projectInsertCalls).toBe(2);
    expect(result.inserted).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/sync/prod-to-test/phases/projects.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/sync/prod-to-test/phases/projects.ts
import { randomUUID } from "node:crypto";
import type { PhaseCtx, PhaseResult, PhaseError } from "./types";

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
            project_code, client_slug, project_slug, storage_project_dir, created_at
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
      const localCreatedBy = await lookupMap(ctx, "import_map_prod_users", row.created_by);
      if (!localCreatedBy) {
        throw new Error(`unresolved created_by user ${row.created_by}`);
      }

      const localId = randomUUID();
      let slug = row.slug;
      let code = row.project_code;

      const doInsert = async () =>
        ctx.test.query(
          `insert into projects
             (id, name, slug, description, archived, created_by, client_id,
              project_code, client_slug, project_slug, storage_project_dir, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/sync/prod-to-test/phases/projects.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/prod-to-test/phases/projects.ts tests/unit/sync/prod-to-test/phases/projects.test.ts
git commit -m "feat(sync): projects phase — resolves FKs + retries slug collisions"
```

---

## Task 9: Threads phase

**Files:**
- Create: `lib/sync/prod-to-test/phases/threads.ts`
- Test: `tests/unit/sync/prod-to-test/phases/threads.test.ts`

Same shape as projects, minus the unique-slug retry. FKs: `project_id` via `import_map_prod_projects`; `author_user_id` via `import_map_prod_users`. If parent project not yet mapped, **skip the row with `failed++`** — projects phase ran first, so an unmapped parent means the project was outside the project phase's reach (e.g. an FK error there) and the thread is intentionally held until the next run.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/sync/prod-to-test/phases/threads.test.ts
import { describe, it, expect, vi } from "vitest";
import { runThreadsPhase } from "@/lib/sync/prod-to-test/phases/threads";
import type { PhaseCtx } from "@/lib/sync/prod-to-test/phases/types";

function makeCtx(): PhaseCtx {
  const watermarks = new Map();
  watermarks.set("threads", new Date(0));
  return {
    prod: { query: vi.fn() } as any,
    test: { query: vi.fn() } as any,
    prodStorage: {} as any,
    testStorage: {} as any,
    watermarks,
    flags: { phase: null, limitPerPhase: null, noBackup: false, iKnowWhatImDoing: false },
    log: () => {},
  };
}

const sampleProdThread = {
  id: "t1",
  project_id: "p1",
  title: "Hi",
  body_markdown: "# hi",
  body_html: "<h1>hi</h1>",
  author_user_id: "prod-user-1",
  created_at: new Date("2026-04-20T00:00:00Z"),
};

describe("runThreadsPhase", () => {
  it("inserts thread when project + user maps resolve", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({ rows: [sampleProdThread] });
    const seen: string[] = [];
    (ctx.test as any).query = vi.fn((sql: string) => {
      seen.push(sql);
      if (/from import_map_prod_threads/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_projects/i.test(sql)) return { rows: [{ local_id: "lp" }] };
      if (/from import_map_prod_users/i.test(sql)) return { rows: [{ local_id: "lu" }] };
      return { rows: [] };
    });
    const result = await runThreadsPhase(ctx);
    expect(result.inserted).toBe(1);
    expect(seen.some((s) => /insert into discussion_threads/i.test(s))).toBe(true);
  });

  it("fails the row when project map is missing", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({ rows: [sampleProdThread] });
    (ctx.test as any).query = vi.fn((sql: string) => {
      if (/from import_map_prod_threads/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_projects/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_users/i.test(sql)) return { rows: [{ local_id: "lu" }] };
      return { rows: [] };
    });
    const result = await runThreadsPhase(ctx);
    expect(result.inserted).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].reason).toMatch(/unresolved project/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/sync/prod-to-test/phases/threads.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/sync/prod-to-test/phases/threads.ts
import { randomUUID } from "node:crypto";
import type { PhaseCtx, PhaseResult, PhaseError } from "./types";

interface ProdThreadRow {
  id: string;
  project_id: string;
  title: string;
  body_markdown: string;
  body_html: string;
  author_user_id: string;
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
    `select id, project_id, title, body_markdown, body_html, author_user_id, created_at
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
      const localAuthor = await lookupMap(ctx, "import_map_prod_users", row.author_user_id);
      if (!localAuthor) throw new Error(`unresolved author ${row.author_user_id}`);

      const localId = randomUUID();
      await ctx.test.query(
        `insert into discussion_threads
           (id, project_id, title, body_markdown, body_html, author_user_id, created_at)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [localId, localProject, row.title, row.body_markdown, row.body_html, localAuthor, row.created_at]
      );
      await ctx.test.query(
        "insert into import_map_prod_threads (prod_id, local_id) values ($1, $2)",
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/sync/prod-to-test/phases/threads.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/prod-to-test/phases/threads.ts tests/unit/sync/prod-to-test/phases/threads.test.ts
git commit -m "feat(sync): threads phase — project + author FK resolution"
```

---

## Task 10: Comments phase

**Files:**
- Create: `lib/sync/prod-to-test/phases/comments.ts`
- Test: `tests/unit/sync/prod-to-test/phases/comments.test.ts`

Comments live under threads; `project_id` is denormalized on the comment row. FKs: `thread_id` via `import_map_prod_threads`; `author_user_id` via `import_map_prod_users`; `project_id` derived from the *local* thread row (`select project_id from discussion_threads where id = $1`).

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/sync/prod-to-test/phases/comments.test.ts
import { describe, it, expect, vi } from "vitest";
import { runCommentsPhase } from "@/lib/sync/prod-to-test/phases/comments";
import type { PhaseCtx } from "@/lib/sync/prod-to-test/phases/types";

function makeCtx(): PhaseCtx {
  const watermarks = new Map();
  watermarks.set("comments", new Date(0));
  return {
    prod: { query: vi.fn() } as any,
    test: { query: vi.fn() } as any,
    prodStorage: {} as any,
    testStorage: {} as any,
    watermarks,
    flags: { phase: null, limitPerPhase: null, noBackup: false, iKnowWhatImDoing: false },
    log: () => {},
  };
}

const sampleProdComment = {
  id: "c1",
  project_id: "p1",
  thread_id: "t1",
  body_markdown: "lgtm",
  body_html: "<p>lgtm</p>",
  author_user_id: "prod-user-1",
  edited_at: null,
  created_at: new Date("2026-04-25T00:00:00Z"),
};

describe("runCommentsPhase", () => {
  it("inserts a comment, deriving project_id from local thread", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({ rows: [sampleProdComment] });
    const inserts: Array<[string, any[]]> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      if (/from import_map_prod_comments/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_threads/i.test(sql)) return { rows: [{ local_id: "lt" }] };
      if (/from import_map_prod_users/i.test(sql)) return { rows: [{ local_id: "lu" }] };
      if (/select project_id from discussion_threads/i.test(sql)) {
        return { rows: [{ project_id: "lp" }] };
      }
      if (/insert into discussion_comments/i.test(sql)) inserts.push([sql, params]);
      return { rows: [] };
    });
    const result = await runCommentsPhase(ctx);
    expect(result.inserted).toBe(1);
    expect(inserts[0][1]).toContain("lp");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/sync/prod-to-test/phases/comments.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/sync/prod-to-test/phases/comments.ts
import { randomUUID } from "node:crypto";
import type { PhaseCtx, PhaseResult, PhaseError } from "./types";

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

  const sql =
    `select id, project_id, thread_id, body_markdown, body_html, author_user_id, edited_at, created_at
       from discussion_comments
       where created_at > $1
       order by created_at asc, id asc` +
    (limit ? ` limit ${Math.max(1, Math.floor(limit))}` : "");
  const prodRes = await ctx.prod.query<ProdCommentRow>(sql, [watermark]);

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
      const localAuthor = await lookupMap(ctx, "import_map_prod_users", row.author_user_id);
      if (!localAuthor) throw new Error(`unresolved author ${row.author_user_id}`);

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
      await ctx.test.query("rollback").catch(() => {});
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/sync/prod-to-test/phases/comments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/prod-to-test/phases/comments.ts tests/unit/sync/prod-to-test/phases/comments.test.ts
git commit -m "feat(sync): comments phase — derives project_id from local thread"
```

---

## Task 11: Files phase (Supabase Storage byte copy)

**Files:**
- Create: `lib/sync/prod-to-test/phases/files.ts`
- Test: `tests/unit/sync/prod-to-test/phases/files.test.ts`

Storage bucket name is taken from env var `SUPABASE_STORAGE_BUCKET` (already in `.env.local`; same logical bucket name in both envs — physical buckets differ because they live in different Supabase projects). The in-bucket key is preserved verbatim (`storage_path` copied as-is); only the Supabase client used differs.

`project_files.dropbox_path` and `dropbox_file_id` are required, not-null fields on the row. They are copied from the prod row verbatim — the Dropbox copy is **not** mirrored. The file's bytes in Supabase Storage are what get copied; the test app reads from test's Supabase Storage. The Dropbox columns remain as a reference string only.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/sync/prod-to-test/phases/files.test.ts
import { describe, it, expect, vi } from "vitest";
import { runFilesPhase } from "@/lib/sync/prod-to-test/phases/files";
import type { PhaseCtx } from "@/lib/sync/prod-to-test/phases/types";

function makeCtx(downloadOk: boolean, uploadOk: boolean): PhaseCtx {
  const watermarks = new Map();
  watermarks.set("files", new Date(0));
  const fakeBucket = {
    download: vi.fn(async () =>
      downloadOk
        ? { data: new Blob([new Uint8Array([1, 2, 3])]), error: null }
        : { data: null, error: new Error("not found") }
    ),
    upload: vi.fn(async () =>
      uploadOk ? { data: { path: "ok" }, error: null } : { data: null, error: new Error("upload fail") }
    ),
  };
  const fakeStorage = { from: vi.fn(() => fakeBucket) };
  return {
    prod: { query: vi.fn() } as any,
    test: { query: vi.fn() } as any,
    prodStorage: { storage: fakeStorage } as any,
    testStorage: { storage: fakeStorage } as any,
    watermarks,
    flags: { phase: null, limitPerPhase: null, noBackup: false, iKnowWhatImDoing: false },
    log: () => {},
  };
}

const sampleProdFile = {
  id: "f1",
  project_id: "p1",
  thread_id: null,
  comment_id: null,
  uploader_user_id: "prod-user-1",
  filename: "foo.png",
  mime_type: "image/png",
  size_bytes: 1234,
  dropbox_file_id: "dbx-1",
  dropbox_path: "/foo.png",
  checksum: "abc",
  created_at: new Date("2026-04-30T00:00:00Z"),
};

describe("runFilesPhase", () => {
  it("downloads from prod, uploads to test, inserts row + map", async () => {
    const ctx = makeCtx(true, true);
    (ctx.prod.query as any).mockResolvedValue({ rows: [sampleProdFile] });
    (ctx.test as any).query = vi.fn((sql: string) => {
      if (/from import_map_prod_files/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_projects/i.test(sql)) return { rows: [{ local_id: "lp" }] };
      if (/from import_map_prod_users/i.test(sql)) return { rows: [{ local_id: "lu" }] };
      return { rows: [] };
    });
    const result = await runFilesPhase(ctx);
    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("fails the row when upload fails (no insert, watermark held)", async () => {
    const ctx = makeCtx(true, false);
    (ctx.prod.query as any).mockResolvedValue({ rows: [sampleProdFile] });
    (ctx.test as any).query = vi.fn((sql: string) => {
      if (/from import_map_prod_files/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_projects/i.test(sql)) return { rows: [{ local_id: "lp" }] };
      if (/from import_map_prod_users/i.test(sql)) return { rows: [{ local_id: "lu" }] };
      return { rows: [] };
    });
    const result = await runFilesPhase(ctx);
    expect(result.inserted).toBe(0);
    expect(result.failed).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/sync/prod-to-test/phases/files.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/sync/prod-to-test/phases/files.ts
import { randomUUID } from "node:crypto";
import type { PhaseCtx, PhaseResult, PhaseError } from "./types";

interface ProdFileRow {
  id: string;
  project_id: string;
  thread_id: string | null;
  comment_id: string | null;
  uploader_user_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  dropbox_file_id: string;
  dropbox_path: string;
  checksum: string;
  created_at: Date;
}

async function lookupMap(ctx: PhaseCtx, table: string, prodId: string): Promise<string | null> {
  const r = await ctx.test.query<{ local_id: string }>(
    `select local_id from ${table} where prod_id = $1`,
    [prodId]
  );
  return r.rows[0]?.local_id ?? null;
}

function bucketName(): string {
  return process.env.SUPABASE_STORAGE_BUCKET ?? "project-files";
}

async function blobToBuffer(b: Blob): Promise<Buffer> {
  return Buffer.from(await b.arrayBuffer());
}

export async function runFilesPhase(ctx: PhaseCtx): Promise<PhaseResult> {
  const watermark = ctx.watermarks.get("files") ?? new Date(0);
  const limit = ctx.flags.limitPerPhase;

  const sql =
    `select id, project_id, thread_id, comment_id, uploader_user_id, filename, mime_type,
            size_bytes, dropbox_file_id, dropbox_path, checksum, created_at
       from project_files
       where created_at > $1
       order by created_at asc, id asc` +
    (limit ? ` limit ${Math.max(1, Math.floor(limit))}` : "");
  const prodRes = await ctx.prod.query<ProdFileRow>(sql, [watermark]);

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  const errors: PhaseError[] = [];
  let maxSeen = watermark;

  const bucket = bucketName();

  for (const row of prodRes.rows) {
    try {
      await ctx.test.query("begin");
      const mapped = await lookupMap(ctx, "import_map_prod_files", row.id);
      if (mapped) {
        await ctx.test.query("commit");
        skipped++;
        if (row.created_at > maxSeen) maxSeen = row.created_at;
        continue;
      }

      const localProject = await lookupMap(ctx, "import_map_prod_projects", row.project_id);
      if (!localProject) throw new Error(`unresolved project ${row.project_id}`);
      const localUploader = await lookupMap(ctx, "import_map_prod_users", row.uploader_user_id);
      if (!localUploader) throw new Error(`unresolved uploader ${row.uploader_user_id}`);
      const localThread = row.thread_id
        ? await lookupMap(ctx, "import_map_prod_threads", row.thread_id)
        : null;
      const localComment = row.comment_id
        ? await lookupMap(ctx, "import_map_prod_comments", row.comment_id)
        : null;

      const storageKey = row.dropbox_path; // same key in both buckets
      const dl = await (ctx.prodStorage as any).storage
        .from(bucket)
        .download(storageKey);
      if (dl.error || !dl.data) throw new Error(`download failed: ${dl.error?.message ?? "no data"}`);
      const bytes = await blobToBuffer(dl.data as Blob);

      const up = await (ctx.testStorage as any).storage
        .from(bucket)
        .upload(storageKey, bytes, {
          contentType: row.mime_type,
          upsert: true,
        });
      if (up.error) throw new Error(`upload failed: ${up.error.message}`);

      const localId = randomUUID();
      await ctx.test.query(
        `insert into project_files
           (id, project_id, thread_id, comment_id, uploader_user_id, filename, mime_type,
            size_bytes, dropbox_file_id, dropbox_path, checksum, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          localId,
          localProject,
          localThread,
          localComment,
          localUploader,
          row.filename,
          row.mime_type,
          row.size_bytes,
          row.dropbox_file_id,
          row.dropbox_path,
          row.checksum,
          row.created_at,
        ]
      );
      await ctx.test.query(
        "insert into import_map_prod_files (prod_id, local_id) values ($1, $2)",
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
    `[files] scanned=${prodRes.rows.length} inserted=${inserted} skipped=${skipped} failed=${failed}`
  );

  return {
    entity: "files",
    scanned: prodRes.rows.length,
    inserted,
    skipped,
    failed,
    newWatermark: maxSeen,
    errors,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/sync/prod-to-test/phases/files.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add lib/sync/prod-to-test/phases/files.ts tests/unit/sync/prod-to-test/phases/files.test.ts
git commit -m "feat(sync): files phase — Supabase Storage byte copy with FK resolution"
```

---

## Task 12: Context builder

**Files:**
- Create: `lib/sync/prod-to-test/context.ts`

- [ ] **Step 1: Write the file**

```ts
// lib/sync/prod-to-test/context.ts
import { Pool } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadWatermarks } from "./watermarks";
import type { PhaseCtx, CliFlags } from "./phases/types";

export interface BuildContextInput {
  prodUrl: string;
  testUrl: string;
  prodSupabaseUrl: string;
  prodServiceRoleKey: string;
  testSupabaseUrl: string;
  testServiceRoleKey: string;
  flags: CliFlags;
  log: (msg: string) => void;
}

export async function buildContext(input: BuildContextInput): Promise<PhaseCtx> {
  const prod = new Pool({ connectionString: input.prodUrl, max: 4 });
  const test = new Pool({ connectionString: input.testUrl, max: 4 });
  const prodStorage = createClient(input.prodSupabaseUrl, input.prodServiceRoleKey, {
    auth: { persistSession: false },
  });
  const testStorage = createClient(input.testSupabaseUrl, input.testServiceRoleKey, {
    auth: { persistSession: false },
  });
  const watermarks = await loadWatermarks(test);
  return {
    prod,
    test,
    prodStorage: prodStorage as SupabaseClient,
    testStorage: testStorage as SupabaseClient,
    watermarks,
    flags: input.flags,
    log: input.log,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/sync/prod-to-test/context.ts
git commit -m "feat(sync): build PhaseCtx with prod+test pools and storage clients"
```

---

## Task 13: Orchestrator + CLI

**Files:**
- Create: `scripts/sync-prod-to-test.ts`
- Modify: `package.json` (add script entry)

The orchestrator: parses flags, loads env, runs safety gates, runs backup (unless `--no-backup` + `--i-know-what-im-doing`), builds context, runs phases in order (or one phase if `--phase=` set), advances each phase's watermark on clean run, writes summary to `tmp/sync-prod/run-<ts>.json`.

- [ ] **Step 1: Add the `sync:prod-to-test` script to `package.json`**

Open `package.json`, locate the `"scripts"` block, add the line below alphabetically (after `recon:stranded-comments`):

```json
    "sync:prod-to-test": "npx tsx scripts/sync-prod-to-test.ts",
```

- [ ] **Step 2: Write the CLI**

```ts
// scripts/sync-prod-to-test.ts
import { config } from "dotenv";
import { resolve } from "path";
import { promises as fs } from "node:fs";
import * as path from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { assertEnvSafe } from "@/lib/sync/prod-to-test/safety";
import { runBackup } from "@/lib/sync/prod-to-test/backup";
import { buildContext } from "@/lib/sync/prod-to-test/context";
import { saveWatermark, ENTITY_NAMES, type EntityName } from "@/lib/sync/prod-to-test/watermarks";
import { runClientsPhase } from "@/lib/sync/prod-to-test/phases/clients";
import { runUsersPhase } from "@/lib/sync/prod-to-test/phases/users";
import { runProjectsPhase } from "@/lib/sync/prod-to-test/phases/projects";
import { runThreadsPhase } from "@/lib/sync/prod-to-test/phases/threads";
import { runCommentsPhase } from "@/lib/sync/prod-to-test/phases/comments";
import { runFilesPhase } from "@/lib/sync/prod-to-test/phases/files";
import type { CliFlags, PhaseResult, RunPhase } from "@/lib/sync/prod-to-test/phases/types";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    process.stderr.write(`Missing required env var: ${name}\n`);
    process.exit(1);
  }
  return v;
}

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = {
    phase: null,
    limitPerPhase: null,
    noBackup: false,
    iKnowWhatImDoing: false,
  };
  for (const a of argv) {
    if (a.startsWith("--phase=")) {
      const v = a.slice("--phase=".length) as EntityName;
      if (!(ENTITY_NAMES as readonly string[]).includes(v)) {
        process.stderr.write(`Unknown phase: ${v}\n`);
        process.exit(1);
      }
      out.phase = v;
    } else if (a.startsWith("--limit-per-phase=")) {
      const n = parseInt(a.slice("--limit-per-phase=".length), 10);
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write(`Invalid --limit-per-phase value\n`);
        process.exit(1);
      }
      out.limitPerPhase = n;
    } else if (a === "--no-backup") {
      out.noBackup = true;
    } else if (a === "--i-know-what-im-doing") {
      out.iKnowWhatImDoing = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      process.stderr.write(`Unknown flag: ${a}\n`);
      process.exit(1);
    }
  }
  if (out.noBackup && !out.iKnowWhatImDoing) {
    process.stderr.write("--no-backup requires --i-know-what-im-doing\n");
    process.exit(1);
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(
    `Usage: pnpm sync:prod-to-test [flags]\n` +
      `  --phase=<name>          run only one phase (${ENTITY_NAMES.join("|")})\n` +
      `  --limit-per-phase=<n>   cap rows scanned per phase\n` +
      `  --no-backup             skip pg_dump (requires --i-know-what-im-doing)\n` +
      `  --i-know-what-im-doing  acknowledge no-backup risk\n`
  );
}

const PHASES: Record<EntityName, RunPhase> = {
  clients: runClientsPhase,
  users: runUsersPhase,
  projects: runProjectsPhase,
  threads: runThreadsPhase,
  comments: runCommentsPhase,
  files: runFilesPhase,
};

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const log = (m: string) => process.stdout.write(m + "\n");

  const prodUrl = requireEnv("PROD_DATABASE_URL");
  const testUrl = requireEnv("DATABASE_URL");
  assertEnvSafe({
    prodUrl,
    testUrl,
    prodHostHint: process.env.PROD_HOST_HINT,
  });

  if (!flags.noBackup) {
    await runBackup({ databaseUrl: testUrl, backupDir: "backups", log });
  } else {
    log("[backup] SKIPPED (--no-backup --i-know-what-im-doing)");
  }

  const ctx = await buildContext({
    prodUrl,
    testUrl,
    prodSupabaseUrl: requireEnv("PROD_SUPABASE_URL"),
    prodServiceRoleKey: requireEnv("PROD_SUPABASE_SERVICE_ROLE_KEY"),
    testSupabaseUrl: requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    testServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    flags,
    log,
  });

  const order: EntityName[] = flags.phase ? [flags.phase] : [...ENTITY_NAMES];
  const results: PhaseResult[] = [];
  let exitCode = 0;
  try {
    for (const name of order) {
      const result = await PHASES[name](ctx);
      results.push(result);
      if (result.failed === 0 && result.newWatermark.getTime() > 0) {
        await saveWatermark(ctx.test, name, result.newWatermark);
      } else if (result.failed > 0) {
        log(`[${name}] watermark HELD (failed=${result.failed})`);
        exitCode = 1;
      }
    }
  } finally {
    const outDir = "tmp/sync-prod";
    await fs.mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(outDir, `run-${stamp}.json`);
    await fs.writeFile(outPath, JSON.stringify(results, null, 2));
    log(`[summary] wrote ${outPath}`);
    await ctx.prod.end().catch(() => {});
    await ctx.test.end().catch(() => {});
  }
  process.exit(exitCode);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).stack ?? (e as Error).message}\n`);
  process.exit(1);
});
```

- [ ] **Step 3: Verify env vars referenced exist in `.env.local`**

Run: `grep -E "^(PROD_DATABASE_URL|DATABASE_URL|PROD_SUPABASE_URL|PROD_SUPABASE_SERVICE_ROLE_KEY|NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=" .env.local | wc -l`
Expected: `6` — all six vars present.

If any are missing, add them before running the script. Document the missing names in the run log and stop until they are added. (`PROD_SUPABASE_URL` and `PROD_SUPABASE_SERVICE_ROLE_KEY` may be new — copy them from the prod Supabase project's API settings page.)

- [ ] **Step 4: Type-check + run all unit tests**

Run: `pnpm test`
Expected: all tests across phases + safety + backup + watermarks pass.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/sync-prod-to-test.ts
git commit -m "feat(sync): orchestrator CLI for prod→test forward importer"
```

---

## Task 14: Manual integration verification

**Files:** (no code changes; verification only)

This task is a one-time manual run to confirm end-to-end behavior on a throwaway target. **Do not run against the real test DB until this passes.**

- [ ] **Step 1: Provision a throwaway target**

Create a fresh Supabase project (or branch) to act as a sacrificial target. Apply all migrations through `0030` to it. Set `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` to point at this throwaway in `.env.local`.

- [ ] **Step 2: Set prod vars to a read-only role**

Confirm `PROD_DATABASE_URL` connects with a Postgres role that has **no** write privileges. (If unsure, create one: `create role sync_reader login password '…'; grant connect on database … to sync_reader; grant usage on schema public to sync_reader; grant select on all tables in schema public to sync_reader;`.) Set `PROD_SUPABASE_URL` + `PROD_SUPABASE_SERVICE_ROLE_KEY` to the prod project.

- [ ] **Step 3: Dry-size run**

Run: `pnpm sync:prod-to-test --limit-per-phase=5`
Expected output, in order:
- `[backup] running pg_dump → backups/sync-prod-…dump`
- `[backup] wrote N bytes`
- six `[<phase>] scanned=… inserted=… skipped=… failed=…` lines
- `[summary] wrote tmp/sync-prod/run-….json`

- [ ] **Step 4: Inspect the throwaway DB**

For each entity, `select count(*)` on the table and on `import_map_prod_<entity>` — counts should match for `inserted` rows. Pick one project at random and verify it has the expected client, threads, comments, files, with FKs that resolve to throwaway-local IDs.

- [ ] **Step 5: Verify file bytes**

Pick one row from `project_files`. Confirm the object exists in the throwaway Supabase Storage bucket at `dropbox_path`. Download it and confirm size matches `size_bytes`.

- [ ] **Step 6: Idempotency check**

Run: `pnpm sync:prod-to-test --limit-per-phase=5` again.
Expected: every phase reports `inserted=0 skipped=N` for some N > 0; no errors; watermarks advanced.

- [ ] **Step 7: Tear down throwaway, restore env**

Delete the throwaway project. Restore `.env.local` to point at the real test DB.

- [ ] **Step 8: Commit a note for posterity**

Append a short note to `docs/superpowers/specs/2026-05-12-prod-to-test-forward-importer-design.md` under a new `## 12. Integration verification log` heading: date, throwaway project name (or "deleted"), counts observed, anything surprising.

```bash
git add docs/superpowers/specs/2026-05-12-prod-to-test-forward-importer-design.md
git commit -m "docs(sync): integration verification log for prod→test importer"
```

---

## Self-review checklist

Run mentally before declaring the plan complete:

- [ ] Every spec section (§1–§11) maps to at least one task above.
- [ ] No "TBD", "TODO", "handle edge cases" prose anywhere.
- [ ] Types used across tasks are consistent (`PhaseCtx`, `PhaseResult`, `EntityName`, `WatermarkMap`, `RunPhase`).
- [ ] Every phase test verifies the three core behaviors: insert / map-skip / FK-failure (where applicable).
- [ ] Backup runs before any phase except when explicitly waived.
- [ ] Watermark is only advanced when `failed === 0` and `newWatermark > 0`.
