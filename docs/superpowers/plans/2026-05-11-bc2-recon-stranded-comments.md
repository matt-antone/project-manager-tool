# BC2 Recon — Stranded Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `pnpm recon:stranded-comments` — a backup-gated, idempotent tool that recovers the ~750 BC2 comments under successfully-migrated topics on 6 known projects by reading the on-disk dump and inserting any comment missing from `import_map_comments`.

**Architecture:** Two new modules. `lib/imports/migration/stranded-comments.ts` is a pure helper that takes injected DB query + filesystem dump-reader functions and processes one project at a time. `scripts/recon-stranded-comments.ts` is a thin CLI that parses flags, opens the pool, loads `personMap`, creates one `import_jobs` row, and delegates. One small addition to `lib/imports/audit/reader.ts` exposes full comment payloads (the existing helper only returns IDs).

**Tech Stack:** TypeScript, Node 24, pg (Postgres), tsx, Vitest, existing repo conventions (`@/lib/repositories`, `lib/imports/migration/jobs`, `BASECAMP_DUMP_DIR` env var).

**Spec:** `docs/superpowers/specs/2026-05-11-bc2-recon-stranded-comments-design.md`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `lib/imports/audit/reader.ts` (modify) | Add `readCommentDetailsForTopic` returning full BC2 comment payloads from dump JSON. Existing `readCommentsForTopic` is left untouched. |
| `lib/imports/migration/stranded-comments.ts` (create) | Pure helper `reconStrandedComments(deps)` — per-project loop, per-topic comment walk, idempotent insert via injected `createComment`. Returns structured summary. No process/CLI concerns. No direct fs/pg access — all I/O is dependency-injected. |
| `scripts/recon-stranded-comments.ts` (create) | CLI entry point. Exports `parseFlags` + `runRecon(deps)` for testing; default-exports nothing. `main()` is guarded by `import.meta.url === pathToFileURL(process.argv[1]).href` so importing the file in tests does not auto-execute. |
| `tests/unit/audit-reader.test.ts` (modify) | Add cases for `readCommentDetailsForTopic`. |
| `tests/unit/recon-stranded-comments.test.ts` (create) | All 10 helper-level test cases against `reconStrandedComments`. |
| `tests/unit/recon-stranded-comments-cli.test.ts` (create) | CLI-level: `parseFlags` cases + backup-gate smoke test. |
| `tests/fixtures/bc2-dump-stranded/by-project/<bc2Id>/...` (create) | Real-on-disk JSON fixtures: `topics.json` summary + per-topic detail files. |
| `package.json` (modify) | Add `recon:stranded-comments` script. |

---

## Task 1: Add `readCommentDetailsForTopic` to the audit reader

**Files:**
- Modify: `lib/imports/audit/reader.ts` (after the existing `readCommentsForTopic` at lines 108–124)
- Test: `tests/unit/audit-reader.test.ts`
- Fixtures: `tests/fixtures/bc2-dump-stranded/by-project/100/topics.json`, `tests/fixtures/bc2-dump-stranded/by-project/100/messages/200.json`

- [ ] **Step 1: Create the fixture files**

`tests/fixtures/bc2-dump-stranded/by-project/100/topics.json`:
```json
[
  { "id": 200, "title": "Welcome", "topicable": { "id": 200, "type": "Message" } }
]
```

`tests/fixtures/bc2-dump-stranded/by-project/100/messages/200.json`:
```json
{
  "id": 200,
  "comments": [
    {
      "id": 5001,
      "content": "First comment body",
      "creator": { "id": 9001, "name": "Alice" },
      "created_at": "2025-01-15T10:00:00.000Z"
    },
    {
      "id": 5002,
      "content": "Second comment",
      "creator": { "id": 9002, "name": "Bob" },
      "created_at": "2025-01-15T11:00:00.000Z"
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Append to `tests/unit/audit-reader.test.ts`:
```ts
import { readCommentDetailsForTopic } from "@/lib/imports/audit/reader";
import { resolve } from "path";

describe("readCommentDetailsForTopic", () => {
  const dumpDir = resolve(__dirname, "../fixtures/bc2-dump-stranded");

  it("returns full comment payloads in dump order", async () => {
    const result = await readCommentDetailsForTopic(dumpDir, 100, "Message", 200);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 5001,
      content: "First comment body",
      creator: { id: 9001, name: "Alice" },
      created_at: "2025-01-15T10:00:00.000Z",
    });
    expect(result[1].id).toBe(5002);
  });

  it("returns [] for unsupported topicable types", async () => {
    const result = await readCommentDetailsForTopic(dumpDir, 100, "Calendar", 200);
    expect(result).toEqual([]);
  });

  it("returns [] when detail JSON is missing", async () => {
    const result = await readCommentDetailsForTopic(dumpDir, 100, "Message", 999);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/audit-reader.test.ts -t readCommentDetailsForTopic`
Expected: FAIL with "readCommentDetailsForTopic is not a function" (import unresolved).

- [ ] **Step 4: Add the implementation**

In `lib/imports/audit/reader.ts`, after the existing `readCommentsForTopic` function (around line 124):

```ts
export interface CommentDetail {
  id: number;
  content?: string;
  creator?: { id: number; name?: string };
  created_at?: string;
}

export async function readCommentDetailsForTopic(
  dumpDir: string,
  projectId: number,
  topicableType: string,
  topicId: number,
): Promise<CommentDetail[]> {
  const segment = TOPICABLE_TYPE_TO_SEGMENT[topicableType];
  if (!segment) return [];
  const data = (await readJson<{ comments?: CommentDetail[] }>(
    path.join(dumpDir, "by-project", String(projectId), segment, `${topicId}.json`),
  )) ?? {};
  return data.comments ?? [];
}
```

(`TOPICABLE_TYPE_TO_SEGMENT`, `readJson`, and `path` are already imported in the file — reuse them.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/audit-reader.test.ts -t readCommentDetailsForTopic`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/imports/audit/reader.ts tests/unit/audit-reader.test.ts tests/fixtures/bc2-dump-stranded
git commit -m "feat(audit): expose full comment payloads via readCommentDetailsForTopic"
```

---

## Task 2: Helper module skeleton + happy-path test

**Files:**
- Create: `lib/imports/migration/stranded-comments.ts`
- Create: `tests/unit/recon-stranded-comments.test.ts`

- [ ] **Step 1: Write the failing happy-path test**

Create `tests/unit/recon-stranded-comments.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { resolve } from "path";
import { reconStrandedComments } from "@/lib/imports/migration/stranded-comments";
import type { Query } from "@/lib/imports/migration/jobs";

const FIXTURE_DUMP = resolve(__dirname, "../fixtures/bc2-dump-stranded");

interface FakeRow { rows: unknown[]; rowCount: number }

function makeFakeQ(handlers: Array<(sql: string, params?: unknown[]) => FakeRow | null>): Query {
  return (async (sql: string, params?: unknown[]) => {
    for (const h of handlers) {
      const res = h(sql, params);
      if (res) return res as never;
    }
    return { rows: [], rowCount: 0 } as never;
  }) as Query;
}

describe("reconStrandedComments — happy path", () => {
  it("inserts the missing comment for one mapped thread", async () => {
    const q = makeFakeQ([
      (sql, p) => sql.includes("from import_map_projects")
        ? { rows: [{ local_project_id: "local-project-uuid" }], rowCount: 1 }
        : null,
      (sql, p) => sql.includes("from import_map_threads")
        ? { rows: [{ local_thread_id: "local-thread-uuid" }], rowCount: 1 }
        : null,
      (sql, p) => sql.includes("from import_map_comments")
        ? { rows: [], rowCount: 0 }
        : null,
      (sql) => sql.startsWith("insert into import_map_comments")
        ? { rows: [], rowCount: 1 }
        : null,
      (sql) => sql.startsWith("insert into import_logs")
        ? { rows: [], rowCount: 1 }
        : null,
    ]);

    const createComment = vi.fn().mockResolvedValue({ id: "local-comment-uuid" });

    const result = await reconStrandedComments({
      q,
      jobId: "job-1",
      dumpDir: FIXTURE_DUMP,
      projectIds: [100],
      personMap: new Map([[9001, "user-alice"], [9002, "user-bob"]]),
      createComment,
    });

    expect(createComment).toHaveBeenCalledTimes(2);
    expect(result.totals.success).toBe(2);
    expect(result.totals.failed).toBe(0);
    expect(result.totals.skipped_already_mapped).toBe(0);
    expect(result.perProject[0]).toMatchObject({
      bc2Id: 100,
      localId: "local-project-uuid",
      success: 2,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/recon-stranded-comments.test.ts`
Expected: FAIL with module-not-found error.

- [ ] **Step 3: Create the minimal helper module**

Create `lib/imports/migration/stranded-comments.ts`:
```ts
import { parseBc2IsoTimestamptz } from "../bc2-fetcher";
import { readTopicsForProject, readCommentDetailsForTopic } from "../audit/reader";
import { logRecord, type Query } from "./jobs";

const SUPPORTED_TOPICS = new Set(["Message", "Todolist", "Upload", "Document"]);

export interface ReconStrandedCommentsDeps {
  q: Query;
  jobId: string;
  dumpDir: string;
  projectIds: number[];
  personMap: Map<number, string>;
  createComment: (args: {
    projectId: string;
    threadId: string;
    bodyMarkdown: string;
    authorUserId: string;
    sourceCreatedAt?: Date;
  }) => Promise<{ id: string }>;
}

export interface PerProject {
  bc2Id: number;
  localId: string | null;
  success: number;
  failed: number;
  skipped: {
    already_mapped: number;
    orphan_no_thread: number;
    unsupported_topicable: number;
  };
}

export interface ReconResult {
  perProject: PerProject[];
  totals: {
    success: number;
    failed: number;
    skipped_already_mapped: number;
    skipped_orphan_no_thread: number;
    skipped_unsupported_topicable: number;
    projects_skipped_unmapped: number;
  };
}

export async function reconStrandedComments(deps: ReconStrandedCommentsDeps): Promise<ReconResult> {
  const { q, jobId, dumpDir, projectIds, personMap, createComment } = deps;

  const perProject: PerProject[] = [];
  let projects_skipped_unmapped = 0;

  for (const bc2Id of projectIds) {
    const projRes = await q<{ local_project_id: string }>(
      "select local_project_id from import_map_projects where basecamp_project_id = $1",
      [String(bc2Id)],
    );
    const localId = projRes.rows[0]?.local_project_id ?? null;
    if (!localId) {
      projects_skipped_unmapped++;
      perProject.push({
        bc2Id,
        localId: null,
        success: 0,
        failed: 0,
        skipped: { already_mapped: 0, orphan_no_thread: 0, unsupported_topicable: 0 },
      });
      continue;
    }

    const summary: PerProject = {
      bc2Id,
      localId,
      success: 0,
      failed: 0,
      skipped: { already_mapped: 0, orphan_no_thread: 0, unsupported_topicable: 0 },
    };

    const topics = await readTopicsForProject(dumpDir, bc2Id);
    for (const topic of topics) {
      if (!SUPPORTED_TOPICS.has(topic.topicableType)) {
        summary.skipped.unsupported_topicable++;
        continue;
      }

      const threadRes = await q<{ local_thread_id: string }>(
        "select local_thread_id from import_map_threads where basecamp_thread_id = $1",
        [String(topic.bc2TopicId)],
      );
      const threadLocalId = threadRes.rows[0]?.local_thread_id ?? null;

      const comments = await readCommentDetailsForTopic(
        dumpDir,
        bc2Id,
        topic.topicableType,
        topic.bc2TopicId,
      );

      const sorted = [...comments].sort((a, b) => {
        const ta = a.created_at ?? "";
        const tb = b.created_at ?? "";
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });

      for (const cmt of sorted) {
        const mapRes = await q<{ local_comment_id: string }>(
          "select local_comment_id from import_map_comments where basecamp_comment_id = $1",
          [String(cmt.id)],
        );
        if (mapRes.rows[0]) {
          summary.skipped.already_mapped++;
          continue;
        }

        if (!threadLocalId) {
          await logRecord(q, {
            jobId,
            recordType: "comment",
            sourceId: String(cmt.id),
            status: "failed",
            message: "orphan_no_thread",
            dataSource: "dump",
          });
          summary.skipped.orphan_no_thread++;
          continue;
        }

        const creatorId = cmt.creator?.id;
        const authorUserId = (creatorId != null ? personMap.get(creatorId) : undefined)
          ?? `dry_${creatorId ?? "unknown"}`;

        const created = await createComment({
          projectId: localId,
          threadId: threadLocalId,
          bodyMarkdown: cmt.content ?? "",
          authorUserId,
          sourceCreatedAt: parseBc2IsoTimestamptz(cmt.created_at) ?? undefined,
        });
        await q(
          "insert into import_map_comments (basecamp_comment_id, local_comment_id) values ($1, $2)",
          [String(cmt.id), created.id],
        );
        await logRecord(q, {
          jobId,
          recordType: "comment",
          sourceId: String(cmt.id),
          status: "success",
          dataSource: "dump",
        });
        summary.success++;
      }
    }

    perProject.push(summary);
  }

  const totals = {
    success: perProject.reduce((s, p) => s + p.success, 0),
    failed: perProject.reduce((s, p) => s + p.failed, 0),
    skipped_already_mapped: perProject.reduce((s, p) => s + p.skipped.already_mapped, 0),
    skipped_orphan_no_thread: perProject.reduce((s, p) => s + p.skipped.orphan_no_thread, 0),
    skipped_unsupported_topicable: perProject.reduce((s, p) => s + p.skipped.unsupported_topicable, 0),
    projects_skipped_unmapped,
  };
  return { perProject, totals };
}
```

- [ ] **Step 4: Run the happy-path test**

Run: `pnpm vitest run tests/unit/recon-stranded-comments.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add lib/imports/migration/stranded-comments.ts tests/unit/recon-stranded-comments.test.ts
git commit -m "feat(recon): stranded-comments helper skeleton + happy path test"
```

---

## Task 3: Idempotency test (already-mapped comments are skipped)

**Files:**
- Modify: `tests/unit/recon-stranded-comments.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/recon-stranded-comments.test.ts`:
```ts
describe("reconStrandedComments — idempotency", () => {
  it("skips comments already in import_map_comments without calling createComment", async () => {
    const q = makeFakeQ([
      (sql) => sql.includes("from import_map_projects")
        ? { rows: [{ local_project_id: "lp" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_threads")
        ? { rows: [{ local_thread_id: "lt" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_comments")
        ? { rows: [{ local_comment_id: "lc" }], rowCount: 1 } : null,
    ]);
    const createComment = vi.fn();

    const result = await reconStrandedComments({
      q, jobId: "j", dumpDir: FIXTURE_DUMP,
      projectIds: [100], personMap: new Map(), createComment,
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(result.totals.success).toBe(0);
    expect(result.totals.skipped_already_mapped).toBe(2);
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm vitest run tests/unit/recon-stranded-comments.test.ts -t idempotency`
Expected: PASS. (Behavior is already implemented in Task 2 — this test locks it in.)

- [ ] **Step 3: Commit**

```bash
git add tests/unit/recon-stranded-comments.test.ts
git commit -m "test(recon): stranded-comments idempotency case"
```

---

## Task 4: Orphan-no-thread skip + logRecord

**Files:**
- Modify: `tests/unit/recon-stranded-comments.test.ts`
- Fixtures: `tests/fixtures/bc2-dump-stranded/by-project/101/topics.json`, `tests/fixtures/bc2-dump-stranded/by-project/101/messages/300.json`

- [ ] **Step 1: Add fixtures**

`tests/fixtures/bc2-dump-stranded/by-project/101/topics.json`:
```json
[
  { "id": 300, "title": "Unmapped topic", "topicable": { "id": 300, "type": "Message" } }
]
```

`tests/fixtures/bc2-dump-stranded/by-project/101/messages/300.json`:
```json
{
  "id": 300,
  "comments": [
    { "id": 6001, "content": "orphan", "creator": { "id": 9001 }, "created_at": "2025-02-01T00:00:00.000Z" }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Append to `tests/unit/recon-stranded-comments.test.ts`:
```ts
describe("reconStrandedComments — orphan-no-thread", () => {
  it("logs failed and skips when import_map_threads has no row", async () => {
    const inserts: Array<{ sql: string; params: unknown[] }> = [];
    const q = makeFakeQ([
      (sql) => sql.includes("from import_map_projects")
        ? { rows: [{ local_project_id: "lp" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_threads")
        ? { rows: [], rowCount: 0 } : null,
      (sql) => sql.includes("from import_map_comments")
        ? { rows: [], rowCount: 0 } : null,
      (sql, p) => {
        if (sql.startsWith("insert into import_logs")) {
          inserts.push({ sql, params: p ?? [] });
          return { rows: [], rowCount: 1 };
        }
        return null;
      },
    ]);
    const createComment = vi.fn();

    const result = await reconStrandedComments({
      q, jobId: "j", dumpDir: FIXTURE_DUMP,
      projectIds: [101], personMap: new Map(), createComment,
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(result.totals.skipped_orphan_no_thread).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toEqual([
      "j", "comment", "6001", "failed", "orphan_no_thread", "dump",
    ]);
  });
});
```

- [ ] **Step 3: Run test**

Run: `pnpm vitest run tests/unit/recon-stranded-comments.test.ts -t orphan-no-thread`
Expected: PASS (already implemented).

- [ ] **Step 4: Commit**

```bash
git add tests/unit/recon-stranded-comments.test.ts tests/fixtures/bc2-dump-stranded/by-project/101
git commit -m "test(recon): orphan-no-thread skip path"
```

---

## Task 5: Unsupported-topicable silent skip

**Files:**
- Modify: `tests/unit/recon-stranded-comments.test.ts`
- Fixtures: `tests/fixtures/bc2-dump-stranded/by-project/102/topics.json`

- [ ] **Step 1: Add fixture**

`tests/fixtures/bc2-dump-stranded/by-project/102/topics.json`:
```json
[
  { "id": 400, "title": "A calendar event", "topicable": { "id": 400, "type": "Calendar" } }
]
```

- [ ] **Step 2: Write the failing test**

Append:
```ts
describe("reconStrandedComments — unsupported topicable", () => {
  it("silently counts Calendar topics without logRecord or createComment", async () => {
    let logInserts = 0;
    const q = makeFakeQ([
      (sql) => sql.includes("from import_map_projects")
        ? { rows: [{ local_project_id: "lp" }], rowCount: 1 } : null,
      (sql) => {
        if (sql.startsWith("insert into import_logs")) { logInserts++; return { rows: [], rowCount: 1 }; }
        return null;
      },
    ]);
    const createComment = vi.fn();

    const result = await reconStrandedComments({
      q, jobId: "j", dumpDir: FIXTURE_DUMP,
      projectIds: [102], personMap: new Map(), createComment,
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(logInserts).toBe(0);
    expect(result.totals.skipped_unsupported_topicable).toBe(1);
  });
});
```

- [ ] **Step 3: Run test**

Run: `pnpm vitest run tests/unit/recon-stranded-comments.test.ts -t "unsupported topicable"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/recon-stranded-comments.test.ts tests/fixtures/bc2-dump-stranded/by-project/102
git commit -m "test(recon): unsupported topicable silent skip"
```

---

## Task 6: Unmapped-project skip (project-level)

**Files:**
- Modify: `tests/unit/recon-stranded-comments.test.ts`

- [ ] **Step 1: Write the failing test**

Append:
```ts
describe("reconStrandedComments — unmapped project", () => {
  it("skips the project and continues to the next when import_map_projects misses", async () => {
    const q = makeFakeQ([
      (sql, p) => {
        if (sql.includes("from import_map_projects")) {
          const id = (p as string[])[0];
          return id === "999"
            ? { rows: [], rowCount: 0 }
            : { rows: [{ local_project_id: "lp" }], rowCount: 1 };
        }
        return null;
      },
      (sql) => sql.includes("from import_map_threads")
        ? { rows: [{ local_thread_id: "lt" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_comments")
        ? { rows: [], rowCount: 0 } : null,
      (sql) => sql.startsWith("insert into import_map_comments") ? { rows: [], rowCount: 1 } : null,
      (sql) => sql.startsWith("insert into import_logs") ? { rows: [], rowCount: 1 } : null,
    ]);
    const createComment = vi.fn().mockResolvedValue({ id: "lc" });

    const result = await reconStrandedComments({
      q, jobId: "j", dumpDir: FIXTURE_DUMP,
      projectIds: [999, 100], personMap: new Map([[9001, "u1"], [9002, "u2"]]), createComment,
    });

    expect(result.totals.projects_skipped_unmapped).toBe(1);
    expect(result.perProject[0]).toMatchObject({ bc2Id: 999, localId: null });
    expect(result.perProject[1].bc2Id).toBe(100);
    expect(result.totals.success).toBe(2);
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm vitest run tests/unit/recon-stranded-comments.test.ts -t "unmapped project"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/recon-stranded-comments.test.ts
git commit -m "test(recon): unmapped-project skip continues run"
```

---

## Task 7: Unmapped author + missing creator → `dry_<id>` / `dry_unknown`

**Files:**
- Modify: `tests/unit/recon-stranded-comments.test.ts`
- Fixtures: `tests/fixtures/bc2-dump-stranded/by-project/103/topics.json`, `tests/fixtures/bc2-dump-stranded/by-project/103/messages/500.json`

- [ ] **Step 1: Add fixture**

`tests/fixtures/bc2-dump-stranded/by-project/103/topics.json`:
```json
[{ "id": 500, "title": "T", "topicable": { "id": 500, "type": "Message" } }]
```

`tests/fixtures/bc2-dump-stranded/by-project/103/messages/500.json`:
```json
{
  "id": 500,
  "comments": [
    { "id": 7001, "content": "c1", "creator": { "id": 9999 }, "created_at": "2025-01-01T00:00:00.000Z" },
    { "id": 7002, "content": "c2", "created_at": "2025-01-01T00:01:00.000Z" }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Append:
```ts
describe("reconStrandedComments — author fallback", () => {
  it("uses dry_<id> for unmapped creator and dry_unknown when creator is absent", async () => {
    const q = makeFakeQ([
      (sql) => sql.includes("from import_map_projects")
        ? { rows: [{ local_project_id: "lp" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_threads")
        ? { rows: [{ local_thread_id: "lt" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_comments")
        ? { rows: [], rowCount: 0 } : null,
      (sql) => sql.startsWith("insert into import_map_comments") ? { rows: [], rowCount: 1 } : null,
      (sql) => sql.startsWith("insert into import_logs") ? { rows: [], rowCount: 1 } : null,
    ]);
    const createComment = vi.fn().mockResolvedValue({ id: "lc" });

    await reconStrandedComments({
      q, jobId: "j", dumpDir: FIXTURE_DUMP,
      projectIds: [103], personMap: new Map(), createComment,
    });

    expect(createComment.mock.calls.map((c) => c[0].authorUserId)).toEqual([
      "dry_9999",
      "dry_unknown",
    ]);
  });
});
```

- [ ] **Step 3: Run test**

Run: `pnpm vitest run tests/unit/recon-stranded-comments.test.ts -t "author fallback"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/recon-stranded-comments.test.ts tests/fixtures/bc2-dump-stranded/by-project/103
git commit -m "test(recon): unmapped-author and missing-creator fallbacks"
```

---

## Task 8: Missing topic detail JSON → no crash

**Files:**
- Modify: `tests/unit/recon-stranded-comments.test.ts`
- Fixtures: `tests/fixtures/bc2-dump-stranded/by-project/104/topics.json` (no detail JSON intentionally)

- [ ] **Step 1: Add fixture**

`tests/fixtures/bc2-dump-stranded/by-project/104/topics.json`:
```json
[{ "id": 600, "title": "Vanished", "topicable": { "id": 600, "type": "Message" } }]
```

(Do not create `messages/600.json`.)

- [ ] **Step 2: Write the failing test**

Append:
```ts
describe("reconStrandedComments — missing detail", () => {
  it("does not throw when topic detail JSON is missing and counts no work", async () => {
    const q = makeFakeQ([
      (sql) => sql.includes("from import_map_projects")
        ? { rows: [{ local_project_id: "lp" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_threads")
        ? { rows: [{ local_thread_id: "lt" }], rowCount: 1 } : null,
    ]);
    const createComment = vi.fn();

    const result = await reconStrandedComments({
      q, jobId: "j", dumpDir: FIXTURE_DUMP,
      projectIds: [104], personMap: new Map(), createComment,
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(result.totals.success).toBe(0);
    expect(result.totals.failed).toBe(0);
  });
});
```

- [ ] **Step 3: Run test**

Run: `pnpm vitest run tests/unit/recon-stranded-comments.test.ts -t "missing detail"`
Expected: PASS — `readCommentDetailsForTopic` already returns `[]` for a missing file (verified in Task 1, test 3).

- [ ] **Step 4: Commit**

```bash
git add tests/unit/recon-stranded-comments.test.ts tests/fixtures/bc2-dump-stranded/by-project/104
git commit -m "test(recon): missing topic detail JSON is non-fatal"
```

---

## Task 9: Insert order (sorted by `created_at` ascending)

**Files:**
- Modify: `tests/unit/recon-stranded-comments.test.ts`
- Fixtures: `tests/fixtures/bc2-dump-stranded/by-project/105/topics.json`, `tests/fixtures/bc2-dump-stranded/by-project/105/messages/700.json`

- [ ] **Step 1: Add fixture (intentionally out-of-order)**

`tests/fixtures/bc2-dump-stranded/by-project/105/topics.json`:
```json
[{ "id": 700, "title": "T", "topicable": { "id": 700, "type": "Message" } }]
```

`tests/fixtures/bc2-dump-stranded/by-project/105/messages/700.json`:
```json
{
  "id": 700,
  "comments": [
    { "id": 8003, "content": "third", "creator": { "id": 9001 }, "created_at": "2025-03-03T00:00:00.000Z" },
    { "id": 8001, "content": "first", "creator": { "id": 9001 }, "created_at": "2025-03-01T00:00:00.000Z" },
    { "id": 8002, "content": "second", "creator": { "id": 9001 }, "created_at": "2025-03-02T00:00:00.000Z" }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Append:
```ts
describe("reconStrandedComments — insert order", () => {
  it("invokes createComment in ascending created_at order", async () => {
    const q = makeFakeQ([
      (sql) => sql.includes("from import_map_projects")
        ? { rows: [{ local_project_id: "lp" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_threads")
        ? { rows: [{ local_thread_id: "lt" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_comments")
        ? { rows: [], rowCount: 0 } : null,
      (sql) => sql.startsWith("insert into import_map_comments") ? { rows: [], rowCount: 1 } : null,
      (sql) => sql.startsWith("insert into import_logs") ? { rows: [], rowCount: 1 } : null,
    ]);
    const createComment = vi.fn().mockResolvedValue({ id: "lc" });

    await reconStrandedComments({
      q, jobId: "j", dumpDir: FIXTURE_DUMP,
      projectIds: [105], personMap: new Map([[9001, "u1"]]), createComment,
    });

    expect(createComment.mock.calls.map((c) => c[0].bodyMarkdown)).toEqual([
      "first", "second", "third",
    ]);
  });
});
```

- [ ] **Step 3: Run test**

Run: `pnpm vitest run tests/unit/recon-stranded-comments.test.ts -t "insert order"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/recon-stranded-comments.test.ts tests/fixtures/bc2-dump-stranded/by-project/105
git commit -m "test(recon): comment insert order is created_at ascending"
```

---

## Task 10: Unique-violation safety net on the map insert

**Files:**
- Modify: `lib/imports/migration/stranded-comments.ts`
- Modify: `tests/unit/recon-stranded-comments.test.ts`

- [ ] **Step 1: Write the failing test**

Append:
```ts
describe("reconStrandedComments — unique-violation safety net", () => {
  it("treats PG 23505 on import_map_comments insert as already-mapped", async () => {
    const q = makeFakeQ([
      (sql) => sql.includes("from import_map_projects")
        ? { rows: [{ local_project_id: "lp" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_threads")
        ? { rows: [{ local_thread_id: "lt" }], rowCount: 1 } : null,
      (sql) => sql.includes("from import_map_comments")
        ? { rows: [], rowCount: 0 } : null,
      (sql) => {
        if (sql.startsWith("insert into import_map_comments")) {
          const err = new Error("duplicate key value violates unique constraint") as Error & { code?: string };
          err.code = "23505";
          throw err;
        }
        return null;
      },
      (sql) => sql.startsWith("insert into import_logs") ? { rows: [], rowCount: 1 } : null,
    ]);
    const createComment = vi.fn().mockResolvedValue({ id: "lc" });

    const result = await reconStrandedComments({
      q, jobId: "j", dumpDir: FIXTURE_DUMP,
      projectIds: [100], personMap: new Map([[9001, "u1"], [9002, "u2"]]), createComment,
    });

    expect(result.totals.failed).toBe(0);
    expect(result.totals.skipped_already_mapped).toBe(2);
    expect(result.totals.success).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/recon-stranded-comments.test.ts -t "unique-violation"`
Expected: FAIL — the helper currently rethrows.

- [ ] **Step 3: Add the safety net**

In `lib/imports/migration/stranded-comments.ts`, replace the success-path block inside the comment loop (currently the `await createComment(...)` … `summary.success++` section) with the guarded version:

```ts
        const creatorId = cmt.creator?.id;
        const authorUserId = (creatorId != null ? personMap.get(creatorId) : undefined)
          ?? `dry_${creatorId ?? "unknown"}`;

        try {
          const created = await createComment({
            projectId: localId,
            threadId: threadLocalId,
            bodyMarkdown: cmt.content ?? "",
            authorUserId,
            sourceCreatedAt: parseBc2IsoTimestamptz(cmt.created_at) ?? undefined,
          });
          try {
            await q(
              "insert into import_map_comments (basecamp_comment_id, local_comment_id) values ($1, $2)",
              [String(cmt.id), created.id],
            );
          } catch (mapErr) {
            const code = (mapErr as { code?: string }).code;
            if (code === "23505") {
              summary.skipped.already_mapped++;
              continue;
            }
            throw mapErr;
          }
          await logRecord(q, {
            jobId, recordType: "comment", sourceId: String(cmt.id),
            status: "success", dataSource: "dump",
          });
          summary.success++;
        } catch (err) {
          await logRecord(q, {
            jobId, recordType: "comment", sourceId: String(cmt.id),
            status: "failed",
            message: err instanceof Error ? err.message : String(err),
            dataSource: "dump",
          });
          summary.failed++;
        }
```

- [ ] **Step 4: Run all helper tests**

Run: `pnpm vitest run tests/unit/recon-stranded-comments.test.ts`
Expected: all PASS (Tasks 2–10 cases).

- [ ] **Step 5: Commit**

```bash
git add lib/imports/migration/stranded-comments.ts tests/unit/recon-stranded-comments.test.ts
git commit -m "feat(recon): unique-violation safety net + generic per-comment catch"
```

---

## Task 11: CLI `parseFlags` + backup gate

**Files:**
- Create: `scripts/recon-stranded-comments.ts`
- Create: `tests/unit/recon-stranded-comments-cli.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/recon-stranded-comments-cli.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseFlags, DEFAULT_PROJECT_IDS } from "@/scripts/recon-stranded-comments";

describe("parseFlags", () => {
  it("requires --i-have-a-backup", () => {
    expect(() => parseFlags([])).toThrow(/--i-have-a-backup/);
  });

  it("parses defaults", () => {
    const f = parseFlags(["--i-have-a-backup"]);
    expect(f).toEqual({
      hasBackup: true,
      projectIds: DEFAULT_PROJECT_IDS,
      dumpDir: process.env.BASECAMP_DUMP_DIR ?? "/Volumes/Spare/basecamp-dump",
    });
  });

  it("parses --projects=<csv>", () => {
    const f = parseFlags(["--i-have-a-backup", "--projects=111,222,333"]);
    expect(f.projectIds).toEqual([111, 222, 333]);
  });

  it("parses --dump-dir=<path>", () => {
    const f = parseFlags(["--i-have-a-backup", "--dump-dir=/tmp/d"]);
    expect(f.dumpDir).toBe("/tmp/d");
  });

  it("rejects unknown flags", () => {
    expect(() => parseFlags(["--i-have-a-backup", "--bogus"])).toThrow(/Unknown flag/);
  });

  it("rejects non-numeric project ids", () => {
    expect(() => parseFlags(["--i-have-a-backup", "--projects=abc"])).toThrow(/invalid project id/i);
  });
});

describe("DEFAULT_PROJECT_IDS", () => {
  it("matches the six known stranded-comment projects", () => {
    expect(DEFAULT_PROJECT_IDS).toEqual([
      12579434, 12450051, 12450414, 12580070, 12450632, 12450066,
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/recon-stranded-comments-cli.test.ts`
Expected: FAIL (module-not-found).

- [ ] **Step 3: Create the CLI module**

Create `scripts/recon-stranded-comments.ts`:
```ts
import { resolve } from "path";
import { pathToFileURL } from "url";
import { config } from "dotenv";

config({ path: resolve(process.cwd(), ".env.local") });

export const DEFAULT_PROJECT_IDS = [
  12579434, 12450051, 12450414, 12580070, 12450632, 12450066,
];

export interface CliFlags {
  hasBackup: boolean;
  projectIds: number[];
  dumpDir: string;
}

export function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    hasBackup: false,
    projectIds: DEFAULT_PROJECT_IDS,
    dumpDir: process.env.BASECAMP_DUMP_DIR ?? "/Volumes/Spare/basecamp-dump",
  };
  for (const a of argv) {
    if (a === "--i-have-a-backup") flags.hasBackup = true;
    else if (a.startsWith("--projects=")) {
      const raw = a.slice("--projects=".length);
      const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
      const parsed = ids.map((s) => {
        const n = Number(s);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`invalid project id: ${s}`);
        }
        return n;
      });
      flags.projectIds = parsed;
    } else if (a.startsWith("--dump-dir=")) {
      flags.dumpDir = a.slice("--dump-dir=".length);
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  if (!flags.hasBackup) {
    throw new Error(
      "Missing --i-have-a-backup. Verify a recent DB backup before running this script.",
    );
  }
  return flags;
}

async function main() {
  // Wired up in Task 12.
  throw new Error("main() not yet implemented");
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test**

Run: `pnpm vitest run tests/unit/recon-stranded-comments-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/recon-stranded-comments.ts tests/unit/recon-stranded-comments-cli.test.ts
git commit -m "feat(recon): stranded-comments CLI flags + backup gate"
```

---

## Task 12: Wire `main()` — pool, personMap, job row, summary

**Files:**
- Modify: `scripts/recon-stranded-comments.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the `recon:stranded-comments` script to package.json**

In `package.json` `scripts` block, after `retry:failed-files`:
```json
    "recon:stranded-comments": "npx tsx scripts/recon-stranded-comments.ts",
```

- [ ] **Step 2: Replace the placeholder `main()` with the real implementation**

In `scripts/recon-stranded-comments.ts`, replace the `async function main()` body and add the supporting imports at the top of the file.

Add to the imports:
```ts
import { Pool } from "pg";
import { createImportJob, finishJob, type Query } from "@/lib/imports/migration/jobs";
import { createComment } from "@/lib/repositories";
import { reconStrandedComments } from "@/lib/imports/migration/stranded-comments";
import { promises as fs } from "fs";
```

Replace `main()`:
```ts
async function main() {
  const flags = parseFlags(process.argv.slice(2));

  try {
    await fs.stat(flags.dumpDir);
  } catch {
    throw new Error(`dump dir not found: ${flags.dumpDir}`);
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q: Query = (async (sql: string, params?: unknown[]) => {
    const result = await pool.query(sql, params);
    return result as never;
  }) as Query;

  let jobId: string | null = null;
  try {
    const peopleRes = await q<{ basecamp_person_id: string; local_user_id: string }>(
      "select basecamp_person_id, local_user_id from import_map_people",
    );
    const personMap = new Map<number, string>(
      peopleRes.rows.map((r) => [Number(r.basecamp_person_id), r.local_user_id]),
    );

    jobId = await createImportJob(q, {
      kind: "recon_stranded_comments",
      projectIds: flags.projectIds,
      dumpDir: flags.dumpDir,
    });

    const result = await reconStrandedComments({
      q,
      jobId,
      dumpDir: flags.dumpDir,
      projectIds: flags.projectIds,
      personMap,
      createComment,
    });

    console.log("== recon:stranded-comments summary ==");
    for (const p of result.perProject) {
      console.log(
        `  bc2=${p.bc2Id} local=${p.localId ?? "(unmapped)"} ` +
        `success=${p.success} failed=${p.failed} ` +
        `already=${p.skipped.already_mapped} ` +
        `orphan=${p.skipped.orphan_no_thread} ` +
        `unsupported=${p.skipped.unsupported_topicable}`,
      );
    }
    console.log(
      `TOTALS success=${result.totals.success} failed=${result.totals.failed} ` +
      `already=${result.totals.skipped_already_mapped} ` +
      `orphan=${result.totals.skipped_orphan_no_thread} ` +
      `unsupported=${result.totals.skipped_unsupported_topicable} ` +
      `unmapped_projects=${result.totals.projects_skipped_unmapped}`,
    );

    await finishJob(q, jobId, "completed");
  } finally {
    await pool.end();
  }
}
```

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Run the full unit suite**

Run: `pnpm vitest run`
Expected: all tests pass (including the existing ~644 + new recon tests).

- [ ] **Step 5: Verify backup gate via CLI**

Run: `pnpm recon:stranded-comments`
Expected: exits non-zero with the `Missing --i-have-a-backup` message.

- [ ] **Step 6: Commit**

```bash
git add scripts/recon-stranded-comments.ts package.json
git commit -m "feat(recon): stranded-comments CLI runs the helper end-to-end"
```

---

## Task 13: Fallow + lint clean, then open the PR

- [ ] **Step 1: Run dead-code check**

Run: `pnpm exec fallow dead-code`
Expected: 0 issues. (If anything new flags, drop the unused export and re-run.)

- [ ] **Step 2: Run lint**

Run: `pnpm lint`
Expected: 0 errors.

- [ ] **Step 3: Final commit if anything was tweaked**

```bash
git add -A
git diff --cached --quiet || git commit -m "chore(recon): fallow/lint cleanup"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/recon-stranded-comments
gh pr create --base main --title "feat: BC2 recon — stranded comments re-import" --body "$(cat <<'EOF'
## Summary
- New script `pnpm recon:stranded-comments` — recovers the ~750 BC2 comments stranded under successfully-migrated topics on 6 projects (`12579434, 12450051, 12450414, 12580070, 12450632, 12450066`).
- Disk-only: reads on-disk dump JSON, inserts via existing `createComment` repository call, writes to `import_map_comments`.
- Idempotent: skips any `basecamp_comment_id` already mapped; PG `23505` unique-violation on the map insert is treated as already-mapped.
- Backup-gated (`--i-have-a-backup`); creates one `import_jobs` row + per-comment `logRecord` entries.
- Per-comment exception isolation. Unmapped projects/threads, missing detail JSON, unmapped authors, and unsupported topicable types are all non-fatal.

## Spec / plan
- `docs/superpowers/specs/2026-05-11-bc2-recon-stranded-comments-design.md`
- `docs/superpowers/plans/2026-05-11-bc2-recon-stranded-comments.md`

## Test plan
- [x] `pnpm vitest run` (existing suite + new helper + CLI tests)
- [x] `pnpm tsc --noEmit`
- [x] `pnpm exec fallow dead-code`
- [ ] `pnpm recon:stranded-comments --i-have-a-backup` against test DB
- [ ] `pnpm audit:bc2-dump` cross-check — `comments.fail` drops by ~750

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

- All 11 spec test cases mapped: happy path (Task 2), idempotency (3), orphan-no-thread (4), unsupported topicable (5), unmapped project (6), unmapped author + missing creator (7), missing topic detail (8), insert order (9), unique-violation (10), CLI backup-gate refusal (11).
- Method signatures consistent: `reconStrandedComments({ q, jobId, dumpDir, projectIds, personMap, createComment })` used identically in every task.
- No placeholders, no "similar to Task N" references.
- File paths exact.
- The CLI's `main()` is intentionally a placeholder in Task 11 (CLI flag tests only) and gets its real body in Task 12. Tests don't exercise `main()` directly; the file's `isDirect` guard keeps tests safe.
