# BC2 Reconciliation — Stranded Comments Re-Import

**Status:** Draft
**Date:** 2026-05-11
**Related:** PR #36 (audit), PR #37 (orphans), PR #39 (retry-failed-files)
**Bucket:** Final recoverable BC2 reconciliation bucket — ~750 comments under successfully-migrated topics on 6 projects.

## Problem

The original BC2 migration (`migrate-from-dump.ts`, shipped via PR #34) produced ~750 comments that were never inserted into `discussion_comments` even though their parent topics imported successfully. Audit run `tmp/audit/comments.csv` flags them as `status=missing` and they cluster on 6 projects:

```
12579434, 12450051, 12450414, 12580070, 12450632, 12450066
```

Root cause is not yet known — the most likely pattern is the migration crashed mid-topic on those projects, but the failure mode is not confirmed. The tool below is designed to be safe regardless: it idempotently fills in the gap by reading the on-disk dump and inserting any comment whose `basecamp_comment_id` is missing from `import_map_comments`.

## Goals

- Recover the missing comments on the 6 listed projects from the on-disk BC2 dump.
- Idempotent: re-running the tool after a partial run produces no duplicates and no errors.
- Match the existing reconciliation tool conventions (`apply:orphan-decisions`, `retry:failed-files`):
  - backup gate (`--i-have-a-backup`)
  - `import_jobs` row + `logRecord` traceability
  - per-record exception isolation
  - environment variable convention (`BASECAMP_*`)

## Non-goals

- Re-migrating threads that never imported. Comments under un-mapped threads are logged and skipped — they belong to a separate bucket.
- Re-running file linkage. Newly inserted comments may reference attachments; running `backfill:bc2-file-linkage` afterward is the operator's responsibility.
- Hitting the BC2 API. The dump on disk is the source of truth.
- Dry-run mode. The tool is gated by `--i-have-a-backup` and is fully idempotent; an explicit dry-run mode is not provided.

## Architecture

Two files:

### `scripts/recon-stranded-comments.ts` (CLI entry point)

Thin wrapper:
1. Parse flags.
2. Validate backup gate (`--i-have-a-backup` required; absence → print refusal, exit 1).
3. Validate dump dir exists.
4. Open DB pool via existing `getPool()`.
5. Load `personMap: Map<number, string>` from `import_map_people`.
6. Insert one row into `import_jobs` (`kind='recon_stranded_comments'`) and grab its id.
7. Call `reconStrandedComments({...})`.
8. Print per-project summary + grand totals.
9. Exit 0 (run-level failures exit 1).

### `lib/imports/migration/stranded-comments.ts` (helper)

Exports:

```ts
export async function reconStrandedComments(args: {
  q: Query;
  jobId: string;
  dumpDir: string;
  projectIds: number[];
  personMap: Map<number, string>;
}): Promise<{
  perProject: Array<{
    bc2Id: number;
    localId: string | null;
    success: number;
    failed: number;
    skipped: { already_mapped: number; orphan_no_thread: number; unsupported_topicable: number };
  }>;
  totals: {
    success: number;
    failed: number;
    skipped_already_mapped: number;
    skipped_orphan_no_thread: number;
    skipped_unsupported_topicable: number;
    projects_skipped_unmapped: number;
  };
}>;
```

A small addition to `lib/imports/audit/reader.ts`:

```ts
export async function readCommentDetailsForTopic(
  dumpDir: string,
  projectId: number,
  topicableType: string,
  topicId: number,
): Promise<Array<{
  id: number;
  content?: string;
  creator?: { id: number; name?: string };
  created_at?: string;
}>>;
```

— same dump-file lookup as the existing `readCommentsForTopic`, but returns full BC2 payload rows rather than just `bc2CommentId`. Existing audit code path is unchanged.

## CLI

```
pnpm recon:stranded-comments --i-have-a-backup [--projects=<csv>] [--dump-dir=<path>]
```

| Flag | Default | Notes |
|------|---------|-------|
| `--i-have-a-backup` | (required) | Refuse to apply without it. |
| `--projects=<csv>` | `12579434,12450051,12450414,12580070,12450632,12450066` | Override only when investigating new buckets. |
| `--dump-dir=<path>` | `process.env.BASECAMP_DUMP_DIR` (fallback `/Volumes/Spare/basecamp-dump/` if present) | Hard fail if dir missing. |

## Data flow

Per project (sequential):

1. `import_map_projects[bc2Id]` → local UUID. Miss → log warning, increment `projects_skipped_unmapped`, continue.
2. `readTopicsForProject(dumpDir, bc2Id)` → list of summaries.
3. For each topic:
   - If `topicable.type` not in `{Message, Todolist, Upload, Document}`: increment `skipped_unsupported_topicable`, no `logRecord`, continue.
   - `import_map_threads[topic.id]` → `thread_local_id | null`.
   - `readCommentDetailsForTopic(dumpDir, bc2Id, topicable.type, topic.id)` — returns full comment payloads. Miss/IO error → `logRecord(thread, failed, "detail_read_failed: <err>")`, continue topic.
   - Sort `comments[]` ascending by `created_at`.
   - For each comment:
     - `basecamp_comment_id` already in `import_map_comments` → `skipped_already_mapped++`, no insert.
     - `thread_local_id` is null → `logRecord(comment, failed, "orphan_no_thread")`, `skipped_orphan_no_thread++`.
     - Else:
       - `authorUserId = personMap.get(creator.id) ?? \`dry_${creator.id ?? "unknown"}\``.
       - `createComment({ projectId: localProjectId, threadId: thread_local_id, bodyMarkdown: content ?? "", authorUserId, sourceCreatedAt: parseBc2IsoTimestamptz(created_at) })`.
       - `insert into import_map_comments (basecamp_comment_id, local_comment_id) values (...)`.
       - PG unique-violation (code `23505`) on the map insert → treat as `skipped_already_mapped`, no rethrow (idempotency safety net).
       - `logRecord(comment, success)`. `success++`.
     - Any other throw inside the comment block → `logRecord(comment, failed, message)`, `failed++`, continue.

## Error handling

Three failure scopes:

| Scope | Behavior |
|-------|----------|
| Run-level | Invalid flags, missing dump dir, pool/personMap init failure, missing `--i-have-a-backup` → print error, exit 1, no DB writes. |
| Project-level | `import_map_projects` lookup miss, or `topics.json` unreadable → warning, increment counter, continue with next project. |
| Topic/comment-level | Topic detail JSON missing → topic-level `failed` log + skip. `createComment` throws → per-comment catch + `failed` log, continue. Unique-violation on map insert → treat as already-mapped. |

Process exits 0 if the run completes, regardless of `failed` count. Non-zero `failed` is reported in the summary line and the `import_jobs` row.

## Logging

- One `import_jobs` row per run, created via `createImportJob(q, { kind: 'recon_stranded_comments', projectIds })`. Finalized via `finishJob(q, jobId, 'completed')` on a clean exit (counters surface failure detail). Run-level abort never reaches this line, so an interrupted row stays `running` — acceptable, matches existing tools.
- Each comment outcome → `logRecord(q, { jobId, recordType: 'comment', sourceId: bc2CommentId, status: 'success' | 'failed', message?, dataSource: 'dump' })`. `logRecord` only accepts `success | failed`, so `orphan_no_thread` outcomes are logged as `failed` with a message naming the reason — matches the threads-phase convention for `skipped_topicable_type`.
- `detail_read_failed` outcomes log `recordType: 'thread'` with the BC2 topic id as `sourceId` and `status: 'failed'`.
- `skipped_unsupported_topicable` is counted only, not logged — the audit tool already classifies these.

## Testing

`tests/unit/recon-stranded-comments.test.ts`. Mock the `q` Query function and the `createComment` import; use real filesystem fixtures under `tests/fixtures/bc2-dump-stranded/`.

| # | Case |
|---|------|
| 1 | Happy path — 1 project, 2 topics, 3 missing comments → 3 inserts + 3 map writes + 3 `success` logs. |
| 2 | Idempotency — comment already in `import_map_comments` → no `createComment` call. |
| 3 | Orphan-no-thread — topic in dump, no `import_map_threads` row → `failed` log, no insert. |
| 4 | Unsupported topicable — Calendar topic → counted, no `logRecord`, no insert. |
| 5 | Unmapped project — `import_map_projects` miss → project skipped, others continue. |
| 6 | Unmapped author — `creator.id` not in `personMap` → `authorUserId = "dry_<id>"`. |
| 7 | Missing `creator` — → `authorUserId = "dry_unknown"`. |
| 8 | Topic detail JSON missing → topic `failed` log, no crash. |
| 9 | Insert order — comments out of order in dump → `createComment` called in ascending `created_at`. |
| 10 | Unique-violation on map insert (PG `23505`) → counted as already-mapped, no rethrow. |
| 11 | CLI backup-gate refusal — script invoked without `--i-have-a-backup` → exits 1, zero DB writes. |

Out of scope: real Postgres round-trip (covered by manual test-DB run).

## Operator workflow

1. Take a fresh DB backup via the session-pooler `pg_dump -F c` convention. Save under `backups/`.
2. Run:
   ```
   pnpm recon:stranded-comments --i-have-a-backup
   ```
3. Cross-check via:
   ```
   pnpm audit:bc2-dump
   ```
   `comments.fail` should drop by roughly ~750. Residual `failed` rows are either `orphan_no_thread` (separate bucket) or `unsupported_topicable` (out of scope).
4. If newly-inserted comments reference attachments, run `pnpm backfill:bc2-file-linkage` to link them. (Optional.)

## Open follow-ups (not part of this spec)

- If `orphan_no_thread` counts are large after the run, scope a separate "stranded threads" recovery tool.
- Investigate root cause of the original mid-topic crash so the same failure cannot recur on a future migration.
