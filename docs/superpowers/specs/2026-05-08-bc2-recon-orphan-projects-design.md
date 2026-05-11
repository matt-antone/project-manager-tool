# BC2 Reconciliation — Orphan Projects (Bucket 1)

> **Status:** Design approved 2026-05-08. Implementation plan to be written next.
>
> **Bucket:** 1 of 2 outstanding BC2 reconciliation buckets identified by `pnpm audit:bc2-dump` (see `docs/superpowers/notes/2026-05-08-bc2-reconciliation-status.md`; treat that doc's "Bucket 1 missed-phase" section as superseded — it collapsed into this orphan bucket once we verified the data).

## Goal

Resolve the 17 BC2 projects whose titles did not match any client code, so the original migration created no `import_map_projects` row and consequently never imported their topics, comments, or files. The audit attributes ~120 missing topics, ~60 stranded child comments, and 141 missing files to these orphans.

A two-script workflow lets the operator review and decide each orphan deliberately:

1. `scripts/dump-orphan-decisions.ts` writes a stub CSV at `docs/imports/bc2-orphan-decisions.csv` with one row per orphan and empty action/code/name fields.
2. The operator hand-edits the CSV, choosing `assign`, `create`, or `skip` per row.
3. `scripts/apply-orphan-decisions.ts` reads the edited CSV, validates it, applies the mappings to the DB, and — if `--run-phases` is set — runs `migrateThreadsAndComments` and `migrateFiles` for the newly-mapped projects.

The decision CSV is checked into the repo. It is the canonical record of "why this orphan was handled this way" and survives database resets.

## Hard Constraints

- Never re-run `scripts/migrate-from-dump.ts`. Phase rerun must operate on a targeted, mapped subset only.
- DB backup must be confirmed before the applier runs. The applier requires `--i-have-a-backup` and refuses to run otherwise.
- No changes to migration phase modules. They are reused as-is.

## File Layout

**New:**
- `scripts/dump-orphan-decisions.ts` — read-only generator (~80 lines).
- `scripts/apply-orphan-decisions.ts` — DB-writing orchestrator (~250 lines).
- `lib/imports/orphans/types.ts` — `DecisionAction`, `OrphanDecision`, `RowError` types.
- `lib/imports/orphans/csv.ts` — `parseDecisionCsv` / `formatDecisionCsv` pure functions.
- `lib/imports/orphans/apply.ts` — `applyDecision` per-row logic.
- `tests/unit/orphans-csv.test.ts` — parser/formatter unit tests.
- `tests/unit/orphans-apply.test.ts` — per-row applier unit tests.
- `tests/unit/dump-orphan-decisions.test.ts` — generator unit tests.
- `tests/unit/apply-orphan-decisions.test.ts` — orchestrator unit tests (mocks `pg`, phases).

**Operator artifact (committed once filled):**
- `docs/imports/bc2-orphan-decisions.csv`.

**Modified:**
- `package.json` — add npm scripts `dump:orphan-decisions` and `apply:orphan-decisions`.

**Untouched:**
- `scripts/migrate-from-dump.ts`.
- All `lib/imports/migration/*` phase modules (`projects.ts`, `threads.ts`, `files.ts`, `jobs.ts`, `types.ts`).
- `lib/imports/dump-reader.ts`.
- `lib/imports/bc2-client-resolver.ts`.
- DB schema.

**Branch:** `feat/recon-orphan-projects` off `main`.

## Decision CSV Schema

Filename: `docs/imports/bc2-orphan-decisions.csv`.

Columns (header row mandatory):

| Column        | Type   | Notes                                                                                  |
|---------------|--------|----------------------------------------------------------------------------------------|
| `bc2_id`      | string | BC2 project ID. Numeric string; preserved as text to match the `import_map_projects.basecamp_project_id` column type. |
| `title`       | string | The orphan's BC2 title. Informational; never read by the applier (used only for human review). |
| `action`      | enum   | `assign`, `create`, or `skip`. Empty/unknown → row error.                               |
| `code`        | string | Required for `assign` and `create`. Must match an existing client (assign) or be unique (create). Empty for `skip`. |
| `client_name` | string | Required for `create`. Empty/ignored for `assign` and `skip`.                           |

Generated stub for the 17 orphans (action/code/client_name all blank):

```
bc2_id,title,action,code,client_name
12449980,"24 Hr HomeCare: 001-Book Jacket/Bookmark",,,
12450413,"Huntsman: Email Change",,,
12836341,"Levato (SummitLA) Website",,,
12859408,"Levato (Summit LA) Logo & Stationery Package",,,
13663293,"Falconvision.com updates",,,
14049017,"Website Template",,,
14107635,"Avivo Domain Names",,,
14113918,"MediaTemple Server Upgrade",,,
14312106,"Freeborn Proposal",,,
15081406,"Cynthia Cohn (Realtor) Information",,,
17004712,"Theater D",,,
17490625,"Alliance Business Solutions",,,
18049673,"New Nemecek Logo On Site",,,
18186485,"Dr. Richard Onofrio Foundation Letterhead",,,
18681846,"Legacy Notes",,,
19336775,"R2LG-003: Training w/Matt",,,
19770284,"Match My Sound Info",,,
```

## Per-Row Validation

Performed by `parseDecisionCsv`, surfaced as `RowError[]`. The applier prints all errors and exits 1 before opening the DB pool when any row is invalid.

| Action   | `code` required? | `client_name` required? | Notes                                                                  |
|----------|------------------|--------------------------|------------------------------------------------------------------------|
| `assign` | yes              | no                       | Code must match an existing client (case-insensitive). Verified DB-side at apply time. |
| `create` | yes              | yes                      | Code must be unique against existing clients. Verified DB-side at apply time. |
| `skip`   | no               | no                       | Both columns must be empty. Logs a `import_logs` row at apply time.   |

Empty / unknown action, missing required cell, or extra cell where `skip` row should be empty → row error.

## CLI

```bash
# 1. Generate stub (read-only)
pnpm dump:orphan-decisions \
  [--audit-csv=tmp/audit/projects.csv] \
  [--out=docs/imports/bc2-orphan-decisions.csv] \
  [--force]

# 2. Edit docs/imports/bc2-orphan-decisions.csv in your editor of choice.

# 3. Apply (DB-writing, backup-gated)
pnpm apply:orphan-decisions \
  --i-have-a-backup \
  [--decisions=docs/imports/bc2-orphan-decisions.csv] \
  [--run-phases] \
  [--dry-run] \
  [--dump-dir=/Volumes/Spare/basecamp-dump] \
  [--verbose]
```

`--dry-run` is mutually allowed with everything else; it short-circuits all DB writes and prints the intended actions instead.

`--run-phases` triggers `migrateThreadsAndComments` + `migrateFiles` for projects that were just mapped (assign + create rows). Skipped rows do not run phases.

## Data Flow

### `dump-orphan-decisions.ts`

1. Parse flags, refuse to overwrite the out-file unless `--force`.
2. Read audit CSV. Filter rows where `status == "failed"`.
3. For each filtered row, build a stub `OrphanDecision` with empty action/code/client_name.
4. Format via `formatDecisionCsv` and write to the out-path.
5. Print: `wrote N rows to <out>. Edit the file, then run pnpm apply:orphan-decisions --i-have-a-backup [--run-phases]`.

### `apply-orphan-decisions.ts`

1. Parse flags. Reject if `--i-have-a-backup` missing.
2. Read decisions file. Run `parseDecisionCsv`. If any `RowError`, print all errors and exit 1 before opening the pool.
3. Open `pg.Pool`. `createImportJob(q, { kind: "reconcile-orphan-projects", ... })` → `jobId`.
4. **Mapping pass.** For each decision (in CSV order):
   - Idempotency check: `select 1 from import_map_projects where basecamp_project_id = $1`. If present, log `<bc2_id> already mapped, skipping` and continue.
   - `assign`: `select id from clients where lower(code) = lower($1)`. If missing → row error, abort run with exit 1. Otherwise continue to project insert.
   - `create`: `select id from clients where lower(code) = lower($1)`. If present → log `client <code> already exists, reusing`. If absent → `insert into clients (name, code) values ($1, $2) returning id`.
   - For both `assign` and `create`: insert `projects` row using sanitized name + Dropbox folder path (factor the existing migrate logic into `lib/imports/orphans/apply.ts` rather than duplicating; if extraction is too invasive, copy the bare minimum needed for orphan inserts and document the duplication). Insert `import_map_projects (basecamp_project_id, local_project_id) values ($1, $2)`. Log success.
   - `skip`: `logRecord(q, { jobId, recordType: "project", sourceId: bc2_id, status: "success", message: "orphan_skipped: " + title, dataSource: "api" })`. No `import_map_projects` row.
   - On caught DB error for any row: log to stderr + `import_logs` (status=failed, message=error.message), abort remaining rows in the mapping pass, set exit code 1.
5. Print mapping summary: `assigned=N created=M skipped=K already_mapped=A errors=E`.
6. **If `--run-phases` and exit code is still 0:**
   - Build `personMap` via inline `loadPersonMap` (copied from `scripts/migrate-from-dump.ts`).
   - Construct `DumpReader` via `createDumpReader({ dumpDir })`.
   - Construct `downloadEnv` from `BC2_USERNAME` / `BC2_PASSWORD` env (matches `migrate-from-dump`).
   - For each newly-mapped project (in CSV order, excluding skip + already-mapped):
     - `await migrateThreadsAndComments({ reader, q, jobId, project, personMap })`.
     - `await migrateFiles({ reader, q, jobId, project, downloadEnv, personMap })`.
     - Catch per-project exceptions, log + record, continue with next project.
   - Print phases summary per project + aggregate.
7. `finishJob(q, jobId, "completed")` in success path; `"failed"` in `try/finally` if main throws.
8. `pool.end()` in `finally`.
9. `process.exit(<aggregated code>)`.

### Verify (operator-side)

The applier prints summaries but does not run an inline audit. After a clean run, the operator runs `pnpm audit:bc2-dump` and confirms `tmp/audit/summary.csv` shows `unaccounted` near zero across all five entity rows. The 17 originally-failed projects should drop to either `mapped` (assign + create) or `accounted_skip` (skip).

## Atomicity & Idempotency

**Mapping pass uses per-row autocommit, not a single transaction.**

Reason: a mid-pass failure under single-transaction semantics rolls back every successful decision, forcing a full re-run from scratch. With per-row commits and the idempotency checks above, partial progress is preserved and the operator can rerun the applier safely after fixing the offending row.

**Idempotency rules:**

| Scenario                                                 | Behavior                                                       |
|----------------------------------------------------------|----------------------------------------------------------------|
| Re-run with the same decisions                           | Each row hits the `import_map_projects` precheck → no-op.       |
| Re-run after editing `assign` to `create`                | Detected as already-mapped → no-op (operator must remap manually if they want to re-map a project to a different client). |
| `create` with code that exists from a prior run          | Reuse client, continue with project insert.                    |
| `skip` written multiple times                            | Multiple `import_logs` rows; harmless (status=success, identical message). |
| `--run-phases` after partial mapping                     | Phases use phase-module idempotency (verified separately) to skip already-imported records. |

## Error Handling

| Failure                                                | Behavior                                                                              |
|--------------------------------------------------------|---------------------------------------------------------------------------------------|
| `dump`: out-file exists without `--force`              | Exit 1 with message before reading audit CSV.                                          |
| `dump`: audit CSV missing                              | Exit 1.                                                                                |
| `apply`: `--i-have-a-backup` missing                   | Exit 1 with usage, before opening pool.                                                |
| `apply`: decision CSV missing or unreadable            | Exit 1.                                                                                |
| `apply`: any row invalid                               | Print all per-row errors, exit 1 before opening pool.                                  |
| `apply`: `assign` row's `code` not found in `clients`  | Reported with other row errors (DB-side validation), abort before mapping any rows.   |
| `apply`: `create` row's `code` already exists in `clients` | Logged + reused (not an error). |
| `apply`: DB error during mapping for a row             | Catch, log to stderr + `import_logs` (failed), abort remaining mapping rows, exit 1.  |
| `apply --run-phases`: phase throws for one project     | Catch, record + continue with next project. Exit 1 after pass completes.              |
| `apply`: uncaught error                                | `try/finally` calls `finishJob(jobId, "failed")` and `pool.end()`.                    |

**Exit codes:**
- `0` — every row applied cleanly; `--run-phases` (if set) ran without exceptions.
- `1` — any of: invalid row, mapping DB error, phase exception, missing flag, file error.

## Test Plan

All unit tests, no DB or network. Mock `pg` and the phase imports.

`tests/unit/orphans-csv.test.ts` (10 tests):
1. valid file with all three actions parses to expected rows.
2. header-only file → empty array, no errors.
3. missing required column → row error.
4. empty `action` cell → row error.
5. `assign` without `code` → row error.
6. `create` without `client_name` → row error.
7. `skip` with non-empty `code` → row error.
8. unknown action → row error.
9. titles with commas + double-quotes parse correctly.
10. `formatDecisionCsv` round-trips parsed rows back to text.

`tests/unit/orphans-apply.test.ts` (6 tests):
1. `applyDecision({action:"assign"})` looks up client by code, inserts project + `import_map_projects` row.
2. `applyDecision({action:"assign"})` with unknown code throws `ClientNotFoundError`.
3. `applyDecision({action:"create"})` inserts client + project + map.
4. `applyDecision({action:"create"})` with existing code reuses the client (idempotent).
5. `applyDecision({action:"skip"})` writes a log row, no map insert.
6. `applyDecision` against an already-mapped `bc2_id` is a no-op.

`tests/unit/dump-orphan-decisions.test.ts` (3 tests):
1. Reads audit CSV, filters `status=failed`, emits stub rows with empty action.
2. Refuses to overwrite existing out-file without `--force`.
3. With `--force`, overwrites.

`tests/unit/apply-orphan-decisions.test.ts` (7 tests):
1. `--i-have-a-backup` missing → exit 1.
2. Decision CSV with one invalid row → exits 1 before any DB call.
3. Happy path: 3 decisions (assign, create, skip) → 3 expected DB call sequences in order; correct summary.
4. `--dry-run` → no DB writes, prints intended actions.
5. `--run-phases` → phases called for assigned + created, not for skipped.
6. Phase throws for one project → other phases still run, exit 1.
7. Re-run with already-applied decisions → all rows reported as no-op, exit 0.

Out of scope (existing coverage): phase modules, dump reader, audit CSV format, client lookup repository.

## Operator Runbook

```bash
# 0. Verify backup
psql "$DATABASE_URL" -c "select pg_size_pretty(pg_database_size(current_database()))"
# ... pg_dump (or platform equivalent), confirm checksum/size ...

# 1. Generate stub
pnpm dump:orphan-decisions
# wrote 17 rows to docs/imports/bc2-orphan-decisions.csv

# 2. Edit docs/imports/bc2-orphan-decisions.csv in your editor.
#    For each row, set action to assign|create|skip, fill code (and client_name for create).

# 3. Dry-run to preview
pnpm apply:orphan-decisions --i-have-a-backup --dry-run

# 4. Apply mappings only (no phases yet)
pnpm apply:orphan-decisions --i-have-a-backup

# 5. Inspect import_map_projects + clients to confirm what landed.

# 6. Apply phases for the newly-mapped projects
pnpm apply:orphan-decisions --i-have-a-backup --run-phases

# 7. Cross-check via audit
pnpm audit:bc2-dump
head tmp/audit/summary.csv
# Expect projects.unaccounted near 0; topics/comments/files unaccounted dropped.
```

## Self-Review

- **Placeholders:** none.
- **Internal consistency:** the 17 orphan IDs listed in Decision CSV Schema match `tmp/audit/projects.csv` rows where `status=failed` (confirmed during brainstorm). The applier's atomicity choice (per-row autocommit) is consistent with the idempotency rules and is documented.
- **Scope:** single bucket. The 44 file-URL parse failures are out of scope; the ~751 stranded comments under successfully-migrated topics on 6 separate projects are out of scope and deferred to a future bucket.
- **Ambiguity:** `assign` vs `create` is explicit (`assign` requires existing code; `create` requires unique code). `skip` is explicit (no DB-state changes beyond a log row). `--run-phases` is opt-in and only operates on assigned + created rows.
- **Project insert detail:** the spec defers the exact SQL/helper structure for the `projects` row insert to the implementation plan, with the constraint that the result must match what `migrateProjects` would have produced (sanitized name, Dropbox folder path, `archived` flag). The plan must either factor `migrateProjects`' inner logic into `lib/imports/orphans/apply.ts` or duplicate the minimum needed and explicitly document the duplication.
