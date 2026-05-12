# Prod → Test Forward Importer — Design

**Date:** 2026-05-12
**Status:** Draft (awaiting user review before plan)
**Owner:** Matthew Antone

## 1. Purpose

Incrementally copy *new* content created on the live production DB into the test DB so the test environment stays usefully fresh without a full re-migration. Scope is forward-only (insert) for four content domains: **projects**, **discussion threads**, **discussion comments**, **project files (with binaries)**. Clients and users are auto-created as needed to satisfy foreign keys but are not the primary target of the sync.

This tool is operator-invoked, idempotent, and does not propagate updates or deletes — only new records.

## 2. Constraints and ground rules

- **IDs are not portable.** Test rows must receive *fresh local UUIDs*. Prod IDs are recorded in per-entity `import_map_prod_*` tables, matching the existing BC2 importer pattern (which uses `import_map_*`).
- **Insert-only, idempotent.** Already-mapped prod records are skipped on re-run.
- **Watermark-driven.** Per-entity `created_at` watermark stored in test DB. Each phase advances its watermark only on a clean (zero-failure) run, so failed rows are automatically retried next run.
- **Auto-create FK parents.** A new prod project on an unknown client → the client is auto-created in test. Same for unknown comment authors. This intentionally lets the importer pull in supporting records that fall outside the four primary entities.
- **Binaries copied byte-for-byte.** Files are downloaded from prod Supabase Storage and re-uploaded to test Supabase Storage. The `storage_path` written to the test row references the test bucket.
- **DB backup is part of the script.** The first action is a `pg_dump -F c` of the test DB to `backups/`. If the backup fails, the importer aborts before any writes.
- **No CI coverage of the importer.** It touches real DBs; CI runs unit tests only.

## 3. Existing context

- Two DBs are configured in `.env.local`: `PROD_DATABASE_URL` and `DATABASE_URL` (test).
- Schema (test DB) includes: `clients`, `user_profiles`, `projects`, `discussion_threads`, `discussion_comments`, `project_files`, plus existing `import_map_*` tables reserved for the BC2 importer.
- Precedent: `scripts/seed-clients-from-prod.ts` already reads prod, writes test, refuses to run if URLs are equal.
- Backup convention (from BC2 reconciliation memory): use the session-pooler URL (port 5432, replace `:6543` with `:5432`) and `pg_dump -F c` into `backups/` (gitignored).

## 4. Architecture

Single CLI entry point: `pnpm sync:prod-to-test` → `scripts/sync-prod-to-test.ts`.

```
[safety gates] → [backup] → [load watermarks]
  → [phase: clients]
  → [phase: user_profiles]
  → [phase: projects]
  → [phase: discussion_threads]
  → [phase: discussion_comments]
  → [phase: project_files]
  → [final summary]
```

Each phase lives under `lib/sync/prod-to-test/phases/<entity>.ts` and exports `runPhase(ctx) → PhaseResult`. The orchestrator stops on a phase that *throws* (connection lost, fatal); per-row errors are accumulated within the phase and do not halt execution.

### Phase contract

```ts
type PhaseCtx = {
  prod: Pool;
  test: Pool;
  prodStorage: SupabaseClient;
  testStorage: SupabaseClient;
  watermarks: Map<EntityName, Date>;
  log: (msg: string) => void;
  flags: CliFlags;
};

type PhaseResult = {
  entity: EntityName;
  scanned: number;     // rows matching prod WHERE created_at > watermark
  inserted: number;    // new local rows + map rows written
  skipped: number;     // already mapped (idempotent re-run)
  failed: number;      // per-row errors (logged, not thrown)
  newWatermark: Date;  // max(created_at) seen this run
  errors: Array<{ prodId: string; reason: string }>;
};
```

Per-row pseudocode inside a phase:

```
rows = SELECT … FROM prod.<table>
       WHERE created_at > $watermark
       ORDER BY created_at ASC, id ASC;

for row in rows:
  BEGIN tx on test
    if exists in import_map_prod_<entity> for row.id:
      skipped++; COMMIT; continue
    resolved_fks = resolve_parent_maps(row)   // may recurse to import parents
    new_local_id = uuid()
    INSERT INTO <local table> (id, …resolved_fks…, mutable fields)
    INSERT INTO import_map_prod_<entity> (prod_id, local_id)
  COMMIT
  inserted++
```

Watermark advances per phase only when `failed === 0`. Any per-row failure pins the watermark so the next run retries the failed records (plus anything else newly created in prod since the run).

## 5. New tables (test DB)

One Supabase migration adds:

```sql
create table if not exists sync_prod_watermarks (
  entity        text primary key,
  last_synced_at timestamptz not null,
  last_run_at   timestamptz not null default now()
);

create table if not exists import_map_prod_clients   (prod_id uuid primary key, local_id uuid not null);
create table if not exists import_map_prod_users     (prod_id uuid primary key, local_id uuid not null);
create table if not exists import_map_prod_projects  (prod_id uuid primary key, local_id uuid not null);
create table if not exists import_map_prod_threads   (prod_id uuid primary key, local_id uuid not null);
create table if not exists import_map_prod_comments  (prod_id uuid primary key, local_id uuid not null);
create table if not exists import_map_prod_files     (prod_id uuid primary key, local_id uuid not null);
```

These are intentionally separate from the existing BC2 `import_map_*` tables so the two importers cannot interfere with each other's mappings.

## 6. Per-entity rules

**clients.** Match prod row by `code` (case-insensitive). If a test row with the same code exists, reuse its `id` for the map row (no insert). Otherwise insert a new client with prod's `code` and `name`. Mirrors `seed-clients-from-prod.ts`.

**user_profiles.** Match by `email` (case-insensitive). If a test row exists, reuse its `id`. Otherwise insert a new `user_profiles` row with a fresh UUID and prod's display fields. The `auth.users` shadow row is **not** synced; the importer touches only `public.user_profiles`. Downstream FKs use the new local `user_profiles.id`.

**projects.** Always insert as a new row with a fresh UUID. FKs resolved via the client map (`client_id`) and user map (`created_by`). Copy `name`, `description`, `status`, `pm_note`, `last_activity_at`, billing/hourly fields, and `created_at` (preserved from prod so chronology is correct in test).

**discussion_threads.** Fresh UUID. FK `project_id` via project map; `created_by` via user map. Copy `title`, `body`, `created_at`.

**discussion_comments.** Fresh UUID. FK `thread_id` via thread map; `author_id` via user map. Copy `body`, `created_at`, and `parent_comment_id` resolved via the comments map (if the parent isn't yet mapped, recursive auto-import triggers).

**project_files.** Fresh UUID. The file's parent is whichever of `project_id` / `thread_id` / `comment_id` is set on the prod row, resolved via the matching import map. Bytes: `prodStorage.download(prod.storage_path)` from the prod bucket → `testStorage.upload(newPath, bytes)` to the test bucket. The schema and bucket layout are identical across envs, so the in-bucket key is preserved verbatim: `newPath === prod.storage_path`. Only the bucket differs (prod bucket vs. test bucket), determined by the Supabase client each side is constructed against. The new `storage_path` written to the test row is therefore the same string as on prod, and the test bucket is the one the row resolves against in the test app. On upload failure: the row is **not** inserted, the error is logged, the watermark is held.

## 7. Backup, safety gates, error handling

### Backup (runs before any writes)

```
backups/sync-prod-YYYYMMDD-HHMMSS.dump
```

Steps:

1. Compute pooler URL by replacing `:6543` with `:5432` in `DATABASE_URL` if needed.
2. Spawn `pg_dump -F c -d <pooler URL>` with stderr streamed to console.
3. Abort if exit code ≠ 0 or the output file is missing/empty.
4. Log final dump path + size before any phase runs.

### Safety gates (run before backup)

- Refuse if `PROD_DATABASE_URL === DATABASE_URL`.
- Refuse if `DATABASE_URL` host matches a known prod host substring (configurable via `PROD_HOST_HINT` env, fail-closed when set).
- Refuse if the `pg_dump` binary is not on `PATH`.

### Per-phase error handling

- Per-record errors are caught, accumulated in `errors[]`, and do not throw.
- Storage upload failure → record skipped, watermark held.
- FK auto-import failure (e.g., orphan parent in prod) → record skipped, error logged with the resolution chain.
- A phase finishes either way; the orchestrator only stops if a phase throws *outside* the row loop (connection lost, etc.).

### Idempotency guarantees

- Every insert is gated by `import_map_prod_*` existence check inside the same transaction.
- Re-running after partial failure: already-mapped rows are skipped; only new and previously-failed rows are attempted.
- Watermark is held until a phase completes clean → guarantees failed rows are retried.

### Output

- Per-phase log lines, e.g. `[projects] scanned=42 inserted=40 skipped=0 failed=2`.
- Final JSON summary written to `tmp/sync-prod/run-<timestamp>.json` with all phase results plus the per-row error lists.

## 8. CLI flags

Per Q6 the runner shape is one-shot CLI with no scheduling and no overrides. Flags are limited to the testing/debug knobs introduced in section 5:

```
pnpm sync:prod-to-test
  [--phase=<name>]              # run only one phase
  [--limit-per-phase=<n>]       # cap rows scanned per phase
  [--no-backup]                 # gated behind --i-know-what-im-doing
  [--i-know-what-im-doing]
```

No `--since` and no `--dry-run` in v1. If a watermark override or preview-only mode is needed later, it can be added after the baseline is in use.

## 9. Testing

**Unit (Vitest)** — `lib/sync/prod-to-test/phases/*.test.ts`, one file per phase:

- happy path (insert + map written)
- idempotent re-run (already-mapped → skipped)
- FK auto-import recursion (unmapped parent → parent imported, then child)
- per-row failure (caught, not thrown; watermark held)

Plus:

- `lib/sync/prod-to-test/backup.test.ts` — pooler URL rewrite, missing `pg_dump`, empty-output abort. Spawn behavior mocked.
- `lib/sync/prod-to-test/safety.test.ts` — env-equality guard, host-hint guard.

**Integration (manual, one-time):**

- Throwaway Supabase project as fake "test". Point `DATABASE_URL` at it, `PROD_DATABASE_URL` at real prod via a read-only pg role. Run with `--limit-per-phase=5` to import 5 of each entity end-to-end. Verify rows, map tables, and storage objects.
- Re-run to confirm second run is a no-op (everything reports `skipped`).

**CI:** unit tests only. The importer itself is never exercised in CI.

## 10. File layout

```
scripts/
  sync-prod-to-test.ts                  # CLI entry
lib/sync/prod-to-test/
  backup.ts                             # pg_dump runner + pooler URL helper
  safety.ts                             # env-equality + host-hint guards
  context.ts                            # PhaseCtx builder, pool/storage clients
  watermarks.ts                         # read/write sync_prod_watermarks
  phases/
    clients.ts
    users.ts
    projects.ts
    threads.ts
    comments.ts
    files.ts
  __tests__/
    backup.test.ts
    safety.test.ts
    phases/
      clients.test.ts
      users.test.ts
      projects.test.ts
      threads.test.ts
      comments.test.ts
      files.test.ts
supabase/migrations/
  00NN_sync_prod_maps.sql
```

## 11. Out of scope (explicit non-goals)

- Updates to records that already exist in test (forward-only).
- Deletes propagated from prod (insert-only).
- Schema drift detection between prod and test (assumed identical; migrations are applied to both).
- BC2 import-map interaction (separate namespace, separate tables).
- `auth.users` synchronization (only `public.user_profiles` is touched).
- Scheduling (operator-invoked only; no cron).
