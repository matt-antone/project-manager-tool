# BC2 Reconciliation — Retry Transient File Failures

> **Status:** Design approved 2026-05-11. Implementation plan to be written next.
>
> **Scope:** subset of the BC2 file-failure population. **Out of scope:** the 44 "Failed to parse URL from undefined" rows, which are Google Drive linked attachments with no BC2 binary to download — accepted as documented loss.

## Goal

Re-run the file-import path (`importBc2FileFromAttachment`) for the 16 BC2 attachments whose original migration failed with a transient error: 12 `fetch failed` (network blips) and 4 `Response failed with a 409 code` (BC2 download conflicts, mostly on large media files).

A new `scripts/retry-failed-files.ts` reads the audit CSV, filters to retriable failure reasons, hydrates the necessary state from `import_map_*` and the dump, and re-invokes the single-file import for each row. One attempt per file. No DB writes outside what the existing single-file path already performs.

## Hard Constraints

- Never re-run `scripts/migrate-from-dump.ts`.
- DB backup confirmed before the run; the script requires `--i-have-a-backup` and refuses to run otherwise.
- No changes to migration phase modules or to `lib/imports/bc2-migrate-single-file.ts`. They are reused as-is.

## File Layout

**New:**
- `scripts/retry-failed-files.ts` (~150 lines).
- `tests/unit/retry-failed-files.test.ts`.

**Reused unchanged:**
- `lib/imports/dump-reader.ts` — `createDumpReader`.
- `lib/imports/bc2-migrate-single-file.ts` — `importBc2FileFromAttachment`.
- `lib/imports/bc2-attachment-linkage.ts` — `resolveBc2AttachmentLinkage`.
- `lib/imports/migration/jobs.ts` — `createImportJob`, `finishJob`, `Query`.

**Modified:**
- `package.json` — add `retry:failed-files` npm script.

**Untouched:**
- `scripts/migrate-from-dump.ts`.
- `scripts/apply-orphan-decisions.ts`.
- DB schema.

**Branch:** `feat/recon-retry-failed-files` off `main` (or off the orphan-recon branch if that is still open at implementation time).

## Retriable Reasons

The script hardcodes the allowlist (avoids accidentally retrying the 44 Google-Doc URL-parse failures that have no recovery path):

```ts
const RETRIABLE_REASONS = new Set([
  "fetch failed",
  "Response failed with a 409 code",
]);
```

Any audit row with `status=failed` and `reason` NOT in this set is ignored.

## CLI

```bash
pnpm retry:failed-files \
  --i-have-a-backup \
  [--audit-csv=tmp/audit/files.csv] \
  [--dump-dir=/Volumes/Spare/basecamp-dump] \
  [--verbose]
```

| Flag                 | Required | Meaning                                                                         |
|----------------------|----------|---------------------------------------------------------------------------------|
| `--i-have-a-backup`  | yes      | Bare flag. Acknowledges the operator has a recent DB backup.                    |
| `--audit-csv=`       | no       | Defaults to `tmp/audit/files.csv`.                                              |
| `--dump-dir=`        | no       | Defaults to `$BASECAMP_DUMP_DIR` or `/Volumes/Spare/basecamp-dump`.             |
| `--verbose`          | no       | Per-file progress lines instead of every-N cadence.                             |

No `--dry-run`. The script is single-attempt; re-running is itself the dry-run check.

## Data Flow

1. Parse flags. Reject if `--i-have-a-backup` missing.
2. Read audit CSV. Filter rows where `status="failed"` AND `reason ∈ RETRIABLE_REASONS`. Group by `bc2_project_id`. If zero retriable rows, print `nothing to retry` and exit 0.
3. Open `pg.Pool`. Build `Query` adapter.
4. `createImportJob(q, { kind: "retry-failed-files", count: N })` → `jobId`. Log: `[retry-failed-files] jobId=<uuid> attachments=<N> projects=<M>`.
5. Build `personMap: Map<number, string>` from `import_map_people`.
6. Construct a `DumpReader` with the same dump-only client stub used by `apply-orphan-decisions` (throws if any API fallback is attempted).
7. Build `downloadEnv` from `BASECAMP_USERNAME` / `BASECAMP_PASSWORD` / (`BASECAMP_USER_AGENT` or `BC2_USER_AGENT`).
8. **Per project loop.** For each `bc2_project_id` group:
   - `select local_project_id, name from import_map_projects ... where basecamp_project_id = $1` (join `projects.name`). If not mapped, log `project_not_mapped: <bc2_id>` for each attachment in the group, set exit 1, continue.
   - Read the project's `attachments.json` via the dump reader (one read per project).
   - **Per failed attachment loop:** For each `bc2_attachment_id` in the group:
     - Find the attachment object by `id` in the project's attachments array. If absent, log `attachment_not_in_dump: bc2_id=<bc2_id> att=<att_id>`, set exit 1, continue.
     - `const { threadId, commentId } = await resolveBc2AttachmentLinkage(q, attachment)`.
     - `const result = await importBc2FileFromAttachment({ q, jobId, attachment, project: { bc2Id, localId, name }, threadId, commentId, downloadEnv, personMap })`.
     - If thrown, catch, record `{ bc2Id, attId, error: e.message }`, set exit 1.
     - If `result.status === "ok"` or `"skipped_existing"`, count as `ok` (the file is now present).
     - Otherwise count as `failed`, capture `result.message` for the summary.
9. `finishJob(q, jobId, exit === 0 ? "completed" : "failed")` in `try/finally`.
10. Print summary table:
    ```
    [retry-failed-files] attempted=16 ok=12 failed=4
      14290875 / 303172579 Phytecs_DrMechoulam.m4v: Response failed with a 409 code
      14290875 / 303138802 CLIP0000014.mp4: Response failed with a 409 code
      14290875 / 303138801 CLIP0000044.mp4: Response failed with a 409 code
      19810220 / NNN production.tar.gz: Response failed with a 409 code
    ```
11. `await pool.end()`. `process.exit(exit)`.

## Error Handling

| Failure                                                  | Behavior                                                   |
|----------------------------------------------------------|------------------------------------------------------------|
| `--i-have-a-backup` missing                              | Exit 1 before opening pool.                                |
| Audit CSV missing or unreadable                          | Exit 1.                                                     |
| Zero retriable rows                                      | Print "nothing to retry", exit 0.                          |
| Project missing from `import_map_projects`               | Log per attachment, skip all of the project's files, exit 1.|
| Attachment ID not in dump's `attachments.json`           | Log + skip, exit 1.                                         |
| `resolveBc2AttachmentLinkage` returns null thread + comment | Result is passed through to the single-file path, which decides what to do — no special handling here. |
| `importBc2FileFromAttachment` throws                     | Catch, record, continue, exit 1.                            |
| `importBc2FileFromAttachment` returns non-ok status      | Record + continue, exit 1.                                  |
| Uncaught error                                           | `try/finally` calls `finishJob(jobId, "failed")` + `pool.end()`. |

**Exit codes:**
- `0` — every retriable attachment now resolves (mapped or already-present).
- `1` — any of: bad flags, unmapped project, attachment-not-in-dump, throw, non-ok return.

## Verification

The script does not run an inline verify pass. The operator runs `pnpm audit:bc2-dump` after the script and checks `tmp/audit/summary.csv` for the new `files.accounted_fail` count. The 16 should drop to whatever didn't recover (zero ideal; some 409s on the very large videos may persist).

## Test Plan

`tests/unit/retry-failed-files.test.ts` — unit tests with injected deps (mirror `apply-orphan-decisions`):

1. `parseFlags` rejects missing `--i-have-a-backup`.
2. `parseFlags` parses defaults + overrides + rejects unknown flags.
3. `pickRetriable(rows)` keeps only `fetch failed` / `Response failed with a 409 code` rows.
4. `pickRetriable` returns empty when no retriable rows; `runRetry` exits 0 with "nothing to retry".
5. Happy path: 2 retriable rows → 2 `importBc2FileFromAttachment` calls, both ok → summary `ok=2 failed=0`, exit 0.
6. Project unmapped → its attachments skipped, summary records `project_not_mapped`, exit 1.
7. Attachment not in dump → skipped, summary records `attachment_not_in_dump`, exit 1.
8. `importBc2FileFromAttachment` throws for one row → others run, exit 1, summary shows the new error message.
9. `importBc2FileFromAttachment` returns `{status:"failed", message:"…"}` for one row → counted as failed, exit 1.

Out of scope (covered elsewhere): the inner `importBc2FileFromAttachment`, `DumpReader`, audit CSV format, `resolveBc2AttachmentLinkage`.

## Operator Runbook

```bash
# 1. Verify backup (or skip if recent — use the orphan-recon backup if same day)
# 2. Re-run audit to refresh the input
pnpm audit:bc2-dump

# 3. Retry transient failures
pnpm retry:failed-files --i-have-a-backup

# 4. Cross-check via audit
pnpm audit:bc2-dump
head tmp/audit/summary.csv
# Expect files.fail dropped from 60 to ≤44 (and ideally exactly 44 — the unrecoverable Google Doc links).
```

## Self-Review

- **Placeholders:** none.
- **Internal consistency:** retriable reasons match the audit data we measured on 2026-05-08 (44 URL-parse + 12 fetch + 4 409 = 60 failed rows in `tmp/audit/files.csv`). The 16 retry candidates are exactly the non-URL-parse subset.
- **Scope:** single bucket subset (transient failures only). 44 Google-Doc-link URL failures are explicitly out of scope per operator decision (no binary to recover).
- **Ambiguity:** `RETRIABLE_REASONS` is hardcoded — operator cannot pass extra reasons via CLI. Intentional; the set is small and any additions deserve a code change + review.
- **Single-attempt-only:** the design is explicit that this script is the retry. If a file still fails, the operator either runs the script again or investigates the new error.
