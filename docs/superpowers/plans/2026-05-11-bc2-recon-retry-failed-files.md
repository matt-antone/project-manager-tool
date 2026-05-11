# BC2 Reconciliation — Retry Transient File Failures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scripts/retry-failed-files.ts` that re-invokes `importBc2FileFromAttachment` for the 16 BC2 attachments whose original migration failed with a transient reason (`fetch failed` or `Response failed with a 409 code`), reusing the existing single-file import path with no changes.

**Architecture:** Thin orchestrator. Reads `tmp/audit/files.csv`, filters to retriable reasons, groups by project, hydrates `import_map_projects` + dump attachments once per project, calls `importBc2FileFromAttachment` per failed attachment, aggregates results, prints summary. One attempt per attachment (the inner function already retries 5× internally). No DB writes outside what the single-file path already performs.

**Tech Stack:** TypeScript, Node 22, pnpm, vitest, pg, dotenv. Reuses `lib/imports/dump-reader.ts`, `lib/imports/bc2-migrate-single-file.ts`, `lib/imports/bc2-attachment-linkage.ts`, `lib/imports/migration/jobs.ts`, `lib/storage/dropbox-adapter.ts`, `lib/repositories`.

**Spec:** `docs/superpowers/specs/2026-05-11-bc2-recon-retry-failed-files-design.md`

---

## File Structure

**Created:**
- `scripts/retry-failed-files.ts` (~200 lines).
- `tests/unit/retry-failed-files.test.ts`.

**Modified:**
- `package.json` (add `retry:failed-files` script).

**Untouched:**
- `scripts/migrate-from-dump.ts`, `scripts/apply-orphan-decisions.ts`.
- `lib/imports/bc2-migrate-single-file.ts`, `lib/imports/bc2-attachment-linkage.ts`, `lib/imports/dump-reader.ts`, `lib/imports/migration/*`.
- `lib/storage/dropbox-adapter.ts`, `lib/repositories`.
- DB schema.

Pattern follows `scripts/apply-orphan-decisions.ts` (orchestrator with injectable `Deps` for testability; thin `main()` wires real implementations).

---

## Task 0: Worktree + branch

**Files:** none

- [ ] **Step 0.1: Create worktree off main**

```bash
git worktree add .worktrees/recon-retry-failed-files -b feat/recon-retry-failed-files main
cd .worktrees/recon-retry-failed-files
pnpm install
cp ../../.env.local .env.local
```

(`.env.local` is gitignored; worktrees don't inherit it.)

- [ ] **Step 0.2: Confirm dump exists**

```bash
ls /Volumes/Spare/basecamp-dump/people.json /Volumes/Spare/basecamp-dump/projects/active.json
```

Expected: both files present.

- [ ] **Step 0.3: Confirm audit CSV has the expected retriable rows**

```bash
awk -F',' 'NR>1 && $5=="failed" && ($7=="fetch failed" || $7=="Response failed with a 409 code")' ../audit-bc2-dump/tmp/audit/files.csv | wc -l
```

Expected: `16`. If the audit was re-run and the count changed, that's fine — the script auto-derives from the CSV.

- [ ] **Step 0.4: Confirm Dropbox + DB env vars are present**

```bash
set -a; source .env.local; set +a
echo "DATABASE_URL set: ${DATABASE_URL:+yes}"
echo "BASECAMP_USERNAME set: ${BASECAMP_USERNAME:+yes}"
echo "BASECAMP_PASSWORD set: ${BASECAMP_PASSWORD:+yes}"
echo "DROPBOX_REFRESH_TOKEN set: ${DROPBOX_REFRESH_TOKEN:+yes}"
echo "DROPBOX_APP_KEY set: ${DROPBOX_APP_KEY:+yes}"
```

Expected: all `yes`. (Dropbox vars are required by `DropboxStorageAdapter` internally.)

---

## Task 1: CLI parser + retriable filter

**Files:**
- Create: `scripts/retry-failed-files.ts` (parser + filter only at this stage)
- Test: `tests/unit/retry-failed-files.test.ts`

Build the file in slices. This task introduces `parseFlags`, `pickRetriable`, supporting types, and a stub `main()` that throws (Task 3 replaces it). Orchestration is added in Task 2.

- [ ] **Step 1.1: Write the failing test**

```ts
// tests/unit/retry-failed-files.test.ts
import { describe, it, expect } from "vitest";
import {
  parseFlags,
  pickRetriable,
  RETRIABLE_REASONS,
  type FailedFileRow,
} from "@/scripts/retry-failed-files";

describe("parseFlags", () => {
  it("requires --i-have-a-backup", () => {
    expect(() => parseFlags([])).toThrow(/--i-have-a-backup/);
  });

  it("parses defaults", () => {
    const f = parseFlags(["--i-have-a-backup"]);
    expect(f).toEqual({
      hasBackup: true,
      auditCsvPath: "tmp/audit/files.csv",
      dumpDir: process.env.BASECAMP_DUMP_DIR ?? "/Volumes/Spare/basecamp-dump",
      verbose: false,
    });
  });

  it("parses overrides", () => {
    const f = parseFlags([
      "--i-have-a-backup",
      "--audit-csv=/tmp/a.csv",
      "--dump-dir=/tmp/d",
      "--verbose",
    ]);
    expect(f.auditCsvPath).toBe("/tmp/a.csv");
    expect(f.dumpDir).toBe("/tmp/d");
    expect(f.verbose).toBe(true);
  });

  it("rejects unknown flags", () => {
    expect(() =>
      parseFlags(["--i-have-a-backup", "--bogus"]),
    ).toThrow(/Unknown flag/);
  });
});

describe("RETRIABLE_REASONS", () => {
  it("contains exactly the two transient reasons", () => {
    expect(RETRIABLE_REASONS.size).toBe(2);
    expect(RETRIABLE_REASONS.has("fetch failed")).toBe(true);
    expect(RETRIABLE_REASONS.has("Response failed with a 409 code")).toBe(true);
  });
});

describe("pickRetriable", () => {
  const sample: FailedFileRow[] = [
    { bc2ProjectId: "100", bc2AttachmentId: "1000", filename: "A", reason: "fetch failed" },
    { bc2ProjectId: "100", bc2AttachmentId: "1001", filename: "B", reason: "Response failed with a 409 code" },
    { bc2ProjectId: "200", bc2AttachmentId: "2000", filename: "C", reason: "Failed to parse URL from undefined" },
    { bc2ProjectId: "300", bc2AttachmentId: "3000", filename: "D", reason: "some other failure" },
  ];

  it("keeps only fetch-failed and 409 rows", () => {
    const r = pickRetriable(sample);
    expect(r.map((x) => x.bc2AttachmentId)).toEqual(["1000", "1001"]);
  });

  it("returns empty when nothing matches", () => {
    const r = pickRetriable([sample[2], sample[3]]);
    expect(r).toEqual([]);
  });
});
```

- [ ] **Step 1.2: Run failing test**

```bash
pnpm vitest run tests/unit/retry-failed-files.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 1.3: Implement the script (parser + filter + types only)**

```ts
// scripts/retry-failed-files.ts
import { promises as fs } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { config } from "dotenv";
import { parseCsvLine, splitCsvRows } from "@/lib/imports/orphans/csv";

config({ path: resolve(process.cwd(), ".env.local") });

export interface RetryFlags {
  hasBackup: boolean;
  auditCsvPath: string;
  dumpDir: string;
  verbose: boolean;
}

export interface FailedFileRow {
  bc2ProjectId: string;
  bc2AttachmentId: string;
  filename: string;
  reason: string;
}

export const RETRIABLE_REASONS = new Set<string>([
  "fetch failed",
  "Response failed with a 409 code",
]);

export function parseFlags(argv: string[]): RetryFlags {
  const flags: RetryFlags = {
    hasBackup: false,
    auditCsvPath: "tmp/audit/files.csv",
    dumpDir: process.env.BASECAMP_DUMP_DIR ?? "/Volumes/Spare/basecamp-dump",
    verbose: false,
  };
  for (const a of argv) {
    if (a === "--i-have-a-backup") flags.hasBackup = true;
    else if (a.startsWith("--audit-csv=")) flags.auditCsvPath = a.slice("--audit-csv=".length);
    else if (a.startsWith("--dump-dir=")) flags.dumpDir = a.slice("--dump-dir=".length);
    else if (a === "--verbose") flags.verbose = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  if (!flags.hasBackup) {
    throw new Error(
      "Missing --i-have-a-backup. Verify a recent DB backup before running this script.",
    );
  }
  return flags;
}

export function pickRetriable(rows: FailedFileRow[]): FailedFileRow[] {
  return rows.filter((r) => RETRIABLE_REASONS.has(r.reason));
}

export async function readFailedFiles(csvPath: string): Promise<FailedFileRow[]> {
  const text = await fs.readFile(csvPath, "utf8");
  const rows = splitCsvRows(text);
  if (rows.length === 0) return [];
  const header = parseCsvLine(rows[0]).map((s) => s.trim().toLowerCase());
  const idx = (n: string) => header.indexOf(n);
  const pid = idx("bc2_project_id");
  const aid = idx("bc2_attachment_id");
  const name = idx("filename");
  const status = idx("status");
  const reason = idx("reason");
  if ([pid, aid, name, status, reason].some((i) => i < 0)) {
    throw new Error(
      `audit CSV missing required columns (need bc2_project_id, bc2_attachment_id, filename, status, reason): ${header.join(",")}`,
    );
  }
  const out: FailedFileRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const fields = parseCsvLine(rows[i]);
    if ((fields[status] ?? "").trim() !== "failed") continue;
    out.push({
      bc2ProjectId: (fields[pid] ?? "").trim(),
      bc2AttachmentId: (fields[aid] ?? "").trim(),
      filename: fields[name] ?? "",
      reason: (fields[reason] ?? "").trim(),
    });
  }
  return out;
}

async function main(): Promise<void> {
  // Wired in Task 3 (real pg + dump reader + dropbox adapter).
  throw new Error("retry-failed-files: main() wired in Task 3");
}

const isEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  main().catch((err) => {
    console.error(`[retry-failed-files] fatal: ${err.message ?? err}`);
    process.exit(1);
  });
}
```

- [ ] **Step 1.4: Run tests**

```bash
pnpm vitest run tests/unit/retry-failed-files.test.ts
```

Expected: PASS, 7 tests (4 parseFlags + 1 RETRIABLE_REASONS + 2 pickRetriable).

- [ ] **Step 1.5: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 1.6: Commit**

```bash
git add scripts/retry-failed-files.ts tests/unit/retry-failed-files.test.ts
git commit -m "feat(retry): CLI parser + retriable-reason filter for failed-file retry"
```

---

## Task 2: Orchestrator with injectable deps

**Files:**
- Modify: `scripts/retry-failed-files.ts` (add `RetryDeps`, `runRetry`, per-attempt result types)
- Modify: `tests/unit/retry-failed-files.test.ts`

Extract a `runRetry` function that takes all I/O behind a `RetryDeps` interface. Unit tests inject fakes; `main()` in Task 3 wires real implementations.

- [ ] **Step 2.1: Append failing tests**

Append to `tests/unit/retry-failed-files.test.ts`:

```ts
import { vi } from "vitest";
import { runRetry, type RetryDeps } from "@/scripts/retry-failed-files";
import type { Bc2Attachment } from "@/lib/imports/bc2-fetcher";

const ATT_100_1000 = { id: 1000, name: "A.png", byte_size: 1, url: "u1" } as unknown as Bc2Attachment;
const ATT_100_1001 = { id: 1001, name: "B.png", byte_size: 1, url: "u2" } as unknown as Bc2Attachment;
const ATT_200_2000 = { id: 2000, name: "C.png", byte_size: 1, url: "u3" } as unknown as Bc2Attachment;

const ROWS: FailedFileRow[] = [
  { bc2ProjectId: "100", bc2AttachmentId: "1000", filename: "A.png", reason: "fetch failed" },
  { bc2ProjectId: "100", bc2AttachmentId: "1001", filename: "B.png", reason: "Response failed with a 409 code" },
  { bc2ProjectId: "200", bc2AttachmentId: "2000", filename: "C.png", reason: "fetch failed" },
];

function fakeDeps(overrides: Partial<RetryDeps> = {}): RetryDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    flags: {
      hasBackup: true,
      auditCsvPath: "ignored.csv",
      dumpDir: "/tmp/dump",
      verbose: false,
    },
    readFailedFileRows: vi.fn(async () => ROWS),
    loadProjectInfo: vi.fn(async (bc2ProjectId: string) => ({
      bc2Id: Number(bc2ProjectId),
      localId: `local-${bc2ProjectId}`,
      name: `proj-${bc2ProjectId}`,
      storageDir: `/Projects/X/proj-${bc2ProjectId}`,
      archived: false,
    })),
    loadProjectAttachments: vi.fn(async (bc2ProjectId: string) =>
      bc2ProjectId === "100"
        ? [ATT_100_1000, ATT_100_1001]
        : [ATT_200_2000],
    ),
    loadPersonMap: vi.fn(async () => new Map<number, string>()),
    createJob: vi.fn(async () => "job-uuid"),
    finishJob: vi.fn(async () => undefined),
    importOne: vi.fn(async () => ({ status: "imported", localFileId: "fid" })),
    log: (s) => lines.push(s),
    err: (s) => lines.push(`ERR ${s}`),
    lines,
    ...overrides,
  };
}

describe("runRetry", () => {
  it("happy path: 3 retriable rows → 3 importOne calls, summary ok=3 failed=0, exit 0", async () => {
    const d = fakeDeps();
    const exit = await runRetry(d);
    expect(exit).toBe(0);
    expect(d.importOne).toHaveBeenCalledTimes(3);
    expect(d.lines.some((l) => l.includes("ok=3 failed=0"))).toBe(true);
  });

  it("zero retriable rows → 'nothing to retry', exit 0, no createJob", async () => {
    const d = fakeDeps({
      readFailedFileRows: vi.fn(async () => [
        { bc2ProjectId: "999", bc2AttachmentId: "9999", filename: "G.doc", reason: "Failed to parse URL from undefined" },
      ]),
    });
    const exit = await runRetry(d);
    expect(exit).toBe(0);
    expect(d.createJob).not.toHaveBeenCalled();
    expect(d.lines.some((l) => l.includes("nothing to retry"))).toBe(true);
  });

  it("project not in import_map_projects → logs per attachment, exit 1", async () => {
    const d = fakeDeps({
      loadProjectInfo: vi.fn(async (bc2ProjectId: string) =>
        bc2ProjectId === "200" ? null : {
          bc2Id: Number(bc2ProjectId),
          localId: `local-${bc2ProjectId}`,
          name: `proj-${bc2ProjectId}`,
          storageDir: "/Projects/X/proj",
          archived: false,
        },
      ),
    });
    const exit = await runRetry(d);
    expect(exit).toBe(1);
    expect(d.importOne).toHaveBeenCalledTimes(2); // 100's two
    expect(d.lines.some((l) => l.includes("ERR") && l.includes("200") && l.includes("project_not_mapped"))).toBe(true);
  });

  it("attachment not in dump → logged, exit 1", async () => {
    const d = fakeDeps({
      loadProjectAttachments: vi.fn(async (bc2ProjectId: string) =>
        bc2ProjectId === "100" ? [ATT_100_1000] : [ATT_200_2000], // 1001 missing
      ),
    });
    const exit = await runRetry(d);
    expect(exit).toBe(1);
    expect(d.importOne).toHaveBeenCalledTimes(2); // 1000 + 2000
    expect(d.lines.some((l) => l.includes("ERR") && l.includes("1001") && l.includes("attachment_not_in_dump"))).toBe(true);
  });

  it("importOne throws for one → others run, exit 1, error in summary", async () => {
    const d = fakeDeps({
      importOne: vi.fn(async ({ attachment }: { attachment: Bc2Attachment }) => {
        if (attachment.id === 1001) throw new Error("download blew up");
        return { status: "imported", localFileId: "fid" };
      }),
    });
    const exit = await runRetry(d);
    expect(exit).toBe(1);
    expect(d.importOne).toHaveBeenCalledTimes(3);
    expect(d.lines.some((l) => l.includes("ERR") && l.includes("1001") && l.includes("download blew up"))).toBe(true);
  });

  it("importOne returns {status:'failed',error:...} → counted as failed, exit 1", async () => {
    const d = fakeDeps({
      importOne: vi.fn(async ({ attachment }: { attachment: Bc2Attachment }) => {
        if (attachment.id === 1000) return { status: "failed", error: "still 409" };
        return { status: "imported", localFileId: "fid" };
      }),
    });
    const exit = await runRetry(d);
    expect(exit).toBe(1);
    expect(d.lines.some((l) => l.includes("ok=2 failed=1"))).toBe(true);
    expect(d.lines.some((l) => l.includes("still 409"))).toBe(true);
  });

  it("importOne returns skipped_existing → counted as ok", async () => {
    const d = fakeDeps({
      importOne: vi.fn(async () => ({ status: "skipped_existing", localFileId: "fid" })),
    });
    const exit = await runRetry(d);
    expect(exit).toBe(0);
    expect(d.lines.some((l) => l.includes("ok=3 failed=0"))).toBe(true);
  });
});
```

- [ ] **Step 2.2: Run failing tests**

```bash
pnpm vitest run tests/unit/retry-failed-files.test.ts
```

Expected: 7 new failing tests (10 total: 7 from Task 1 + 7 here … wait: 4 parseFlags + 1 RETRIABLE_REASONS + 2 pickRetriable + 7 runRetry = 14 total). 7 pass from Task 1, 7 fail.

- [ ] **Step 2.3: Add `RetryDeps` + `runRetry` to `scripts/retry-failed-files.ts`**

Append (above `main`) to `scripts/retry-failed-files.ts`:

```ts
import type { Bc2Attachment } from "@/lib/imports/bc2-fetcher";

export interface ProjectInfo {
  bc2Id: number;
  localId: string;
  name: string;
  storageDir: string;
  archived: boolean;
}

export type ImportOneResult =
  | { status: "imported"; localFileId: string }
  | { status: "skipped_existing"; localFileId: string }
  | { status: "failed"; error: string };

export interface RetryDeps {
  flags: RetryFlags;
  readFailedFileRows: () => Promise<FailedFileRow[]>;
  loadProjectInfo: (bc2ProjectId: string) => Promise<ProjectInfo | null>;
  loadProjectAttachments: (bc2ProjectId: string) => Promise<Bc2Attachment[]>;
  loadPersonMap: () => Promise<Map<number, string>>;
  createJob: (attemptCount: number) => Promise<string>;
  finishJob: (jobId: string, status: "completed" | "failed") => Promise<void>;
  importOne: (args: {
    project: ProjectInfo;
    attachment: Bc2Attachment;
    personMap: Map<number, string>;
    jobId: string;
  }) => Promise<ImportOneResult>;
  log: (s: string) => void;
  err: (s: string) => void;
}

function groupByProject(rows: FailedFileRow[]): Map<string, FailedFileRow[]> {
  const out = new Map<string, FailedFileRow[]>();
  for (const row of rows) {
    const list = out.get(row.bc2ProjectId) ?? [];
    list.push(row);
    out.set(row.bc2ProjectId, list);
  }
  return out;
}

export async function runRetry(deps: RetryDeps): Promise<number> {
  const { log, err } = deps;

  const all = await deps.readFailedFileRows();
  const retriable = pickRetriable(all);
  if (retriable.length === 0) {
    log(`[retry-failed-files] nothing to retry (no rows match retriable reasons).`);
    return 0;
  }

  const grouped = groupByProject(retriable);
  log(
    `[retry-failed-files] attachments=${retriable.length} projects=${grouped.size}`,
  );

  const jobId = await deps.createJob(retriable.length);
  log(`[retry-failed-files] jobId=${jobId}`);

  const personMap = await deps.loadPersonMap();

  interface Result {
    bc2ProjectId: string;
    bc2AttachmentId: string;
    filename: string;
    outcome: "ok" | "failed" | "project_not_mapped" | "attachment_not_in_dump";
    message?: string;
  }
  const results: Result[] = [];
  let exitCode = 0;

  try {
    for (const [bc2ProjectId, rowsForProject] of grouped) {
      const project = await deps.loadProjectInfo(bc2ProjectId);
      if (!project) {
        for (const row of rowsForProject) {
          err(`${row.bc2ProjectId}/${row.bc2AttachmentId} project_not_mapped`);
          results.push({ ...row, outcome: "project_not_mapped" });
        }
        exitCode = 1;
        continue;
      }
      const attachments = await deps.loadProjectAttachments(bc2ProjectId);
      const byId = new Map<number, Bc2Attachment>();
      for (const a of attachments) byId.set(a.id, a);

      for (const row of rowsForProject) {
        const attachment = byId.get(Number(row.bc2AttachmentId));
        if (!attachment) {
          err(`${row.bc2ProjectId}/${row.bc2AttachmentId} attachment_not_in_dump`);
          results.push({ ...row, outcome: "attachment_not_in_dump" });
          exitCode = 1;
          continue;
        }
        try {
          const r = await deps.importOne({ project, attachment, personMap, jobId });
          if (r.status === "imported" || r.status === "skipped_existing") {
            log(`${row.bc2ProjectId}/${row.bc2AttachmentId} ok (${r.status})`);
            results.push({ ...row, outcome: "ok" });
          } else {
            err(`${row.bc2ProjectId}/${row.bc2AttachmentId} failed: ${r.error}`);
            results.push({ ...row, outcome: "failed", message: r.error });
            exitCode = 1;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          err(`${row.bc2ProjectId}/${row.bc2AttachmentId} threw: ${msg}`);
          results.push({ ...row, outcome: "failed", message: msg });
          exitCode = 1;
        }
      }
    }

    const ok = results.filter((r) => r.outcome === "ok").length;
    const failed = results.length - ok;
    log(`[retry-failed-files] attempted=${results.length} ok=${ok} failed=${failed}`);
    for (const r of results) {
      if (r.outcome !== "ok") {
        log(
          `  ${r.bc2ProjectId} / ${r.bc2AttachmentId} ${r.filename}: ${r.outcome}${r.message ? ` — ${r.message}` : ""}`,
        );
      }
    }

    await deps.finishJob(jobId, exitCode === 0 ? "completed" : "failed");
  } catch (e) {
    try {
      await deps.finishJob(jobId, "failed");
    } catch {
      // Preserve the original error.
    }
    throw e;
  }

  return exitCode;
}
```

- [ ] **Step 2.4: Run tests**

```bash
pnpm vitest run tests/unit/retry-failed-files.test.ts
```

Expected: 14 tests pass.

- [ ] **Step 2.5: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2.6: Commit**

```bash
git add scripts/retry-failed-files.ts tests/unit/retry-failed-files.test.ts
git commit -m "feat(retry): runRetry orchestration with injectable deps"
```

---

## Task 3: Wire `main()` to real pg + dump reader + Dropbox adapter

**Files:**
- Modify: `scripts/retry-failed-files.ts`

Replace the stub `main()` with one that constructs real dependencies and calls `runRetry`.

- [ ] **Step 3.1: Replace `main()`**

In `scripts/retry-failed-files.ts`, replace the placeholder `main()` (the one that throws) with the implementation below. Also add the new imports at the top of the file.

Add these imports (preserve existing imports):

```ts
import { Pool } from "pg";
import { createDumpReader } from "@/lib/imports/dump-reader";
import { Bc2Client } from "@/lib/imports/bc2-client";
import { importBc2FileFromAttachment } from "@/lib/imports/bc2-migrate-single-file";
import { resolveBc2AttachmentLinkage } from "@/lib/imports/bc2-attachment-linkage";
import { createImportJob, finishJob, type Query } from "@/lib/imports/migration/jobs";
import { DropboxStorageAdapter } from "@/lib/storage/dropbox-adapter";
import { createFileMetadata } from "@/lib/repositories";
```

Add the helper + new `main`:

```ts
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Single dump-only client stub. Throws if anything ever tries the API
// fallback — we expect the dump to be self-contained for retry recon.
const DUMP_ONLY_CLIENT = {
  get: async () => {
    throw new Error("retry-failed-files: API fallback not supported");
  },
} as unknown as Bc2Client;

async function noopLogRecord(): Promise<void> {
  // The inner single-file path already writes import_logs via the supplied
  // logRecord, but we already log our own outcomes — pass a no-op so we do not
  // double-log.
  return;
}

async function noopIncrementCounters(): Promise<void> {
  return;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });
  pool.on("error", (e) => {
    console.warn(`[retry-failed-files] pool client error (non-fatal): ${e.message}`);
  });
  const q: Query = (async <T>(text: string, values?: unknown[]) => {
    const r = await pool.query(text, values);
    return { rows: r.rows as T[] };
  }) as Query;

  const adapter = new DropboxStorageAdapter();
  const downloadEnv = {
    username: requireEnv("BASECAMP_USERNAME"),
    password: requireEnv("BASECAMP_PASSWORD"),
    userAgent: process.env.BASECAMP_USER_AGENT ?? requireEnv("BC2_USER_AGENT"),
  };

  const reader = createDumpReader({
    dumpDir: flags.dumpDir,
    client: DUMP_ONLY_CLIENT,
    errors: new Set(),
  });

  let exit = 1;
  try {
    exit = await runRetry({
      flags,
      readFailedFileRows: () => readFailedFiles(flags.auditCsvPath),
      loadProjectInfo: async (bc2ProjectId) => {
        const r = await q<{
          local_project_id: string;
          name: string;
          storage_project_dir: string | null;
          archived: boolean | null;
        }>(
          `select m.local_project_id, p.name, p.storage_project_dir, p.archived
             from import_map_projects m
             join projects p on p.id = m.local_project_id
            where m.basecamp_project_id = $1`,
          [bc2ProjectId],
        );
        const row = r.rows[0];
        if (!row) return null;
        return {
          bc2Id: Number(bc2ProjectId),
          localId: row.local_project_id,
          name: row.name,
          storageDir: row.storage_project_dir ?? "",
          archived: !!row.archived,
        };
      },
      loadProjectAttachments: async (bc2ProjectId) => {
        const res = await reader.attachments(Number(bc2ProjectId));
        const body = (Array.isArray(res.body) ? res.body : []) as Bc2Attachment[];
        return body;
      },
      loadPersonMap: async () => {
        const r = await q<{ basecamp_person_id: string; local_user_profile_id: string }>(
          "select basecamp_person_id, local_user_profile_id from import_map_people",
        );
        const m = new Map<number, string>();
        for (const row of r.rows) m.set(Number(row.basecamp_person_id), row.local_user_profile_id);
        return m;
      },
      createJob: (attemptCount) =>
        createImportJob(q, {
          kind: "retry-failed-files",
          count: attemptCount,
          auditCsvPath: flags.auditCsvPath,
        }),
      finishJob: (jobId, status) => finishJob(q, jobId, status),
      importOne: async ({ project, attachment, personMap, jobId }) => {
        const { threadId, commentId } = await resolveBc2AttachmentLinkage(q, attachment);
        const result = await importBc2FileFromAttachment({
          query: q,
          jobId,
          projectLocalId: project.localId,
          storageDir: project.storageDir,
          personMap,
          attachment,
          threadId,
          commentId,
          downloadEnv,
          adapter,
          createFileMetadata,
          logRecord: noopLogRecord,
          incrementCounters: noopIncrementCounters,
          projectArchived: project.archived,
        });
        if (result.status === "imported") {
          return { status: "imported", localFileId: result.localFileId };
        }
        if (result.status === "skipped_existing") {
          return { status: "skipped_existing", localFileId: result.localFileId };
        }
        return { status: "failed", error: result.error };
      },
      log: (s) => console.log(s),
      err: (s) => console.error(s),
    });
  } finally {
    await pool.end();
  }
  process.exit(exit);
}
```

- [ ] **Step 3.2: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3.3: Run unit tests**

```bash
pnpm vitest run tests/unit/retry-failed-files.test.ts
```

Expected: 14 tests still pass (unit tests exercise `runRetry` directly, not `main()`).

- [ ] **Step 3.4: Commit**

```bash
git add scripts/retry-failed-files.ts
git commit -m "feat(retry): wire retry-failed-files main() to real pg + dump + dropbox"
```

---

## Task 4: package.json script + final verification + push + PR

**Files:**
- Modify: `package.json`

- [ ] **Step 4.1: Add npm script**

After the existing `"apply:orphan-decisions":` line (or `"migrate:from-dump":` if orphan-recon isn't merged yet), insert:

```json
"retry:failed-files": "npx tsx scripts/retry-failed-files.ts",
```

- [ ] **Step 4.2: Full unit test suite**

```bash
pnpm vitest run
```

Expected: all tests pass.

- [ ] **Step 4.3: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4.4: Fallow dead-code check**

```bash
pnpm exec fallow dead-code
```

Expected: zero issues. If new exported symbols are flagged (e.g., `ProjectInfo` if no external consumer), drop the `export` keyword on internal-only declarations.

- [ ] **Step 4.5: Operator smoke check (read-only verification of inputs)**

```bash
awk -F',' 'NR>1 && $5=="failed" && ($7=="fetch failed" || $7=="Response failed with a 409 code")' ../audit-bc2-dump/tmp/audit/files.csv | wc -l
```

Expected: positive integer (16 at the time of writing). If zero, the audit has been re-run since the orphan recon and there's nothing to retry — script will exit 0 cleanly.

- [ ] **Step 4.6: Push branch**

```bash
git push -u origin feat/recon-retry-failed-files
```

- [ ] **Step 4.7: Open PR**

```bash
gh pr create --title "feat: BC2 recon — retry transient file failures" --body "$(cat <<'EOF'
## Summary
- New script: \`scripts/retry-failed-files.ts\`.
- Re-invokes the existing \`importBc2FileFromAttachment\` path for the 16 BC2 attachments whose original migration failed with a transient error (\`fetch failed\` or \`Response failed with a 409 code\`).
- Auto-derives the input list from \`tmp/audit/files.csv\` — no hardcoded IDs.
- One attempt per attachment (the inner single-file function already retries 5× internally).
- Backup-gated via \`--i-have-a-backup\`.
- 44 Google-Doc-link "Failed to parse URL from undefined" rows are explicitly out of scope — they are not BC2-hosted binaries and have no recovery path.

## Closes
- Subset of the file-failure bucket originally surfaced by PR #36 (audit tool).
- Spec: \`docs/superpowers/specs/2026-05-11-bc2-recon-retry-failed-files-design.md\`.

## Test plan
- [ ] \`pnpm vitest run\`
- [ ] \`pnpm tsc --noEmit\`
- [ ] \`pnpm exec fallow dead-code\`
- [ ] \`pnpm retry:failed-files --i-have-a-backup\`
- [ ] \`pnpm audit:bc2-dump\` cross-check: \`files.fail\` count drops by the recovered amount (ideally 16 → 0, leaving only the 44 Google-Doc links residual)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Goal (retry the 16 transient file failures) — Tasks 1-3 implement; Task 4.5 operator smoke.
- Hard constraints (no migrate-from-dump rerun; backup gate; single-file path untouched) — Task 0 branch off main, Task 1 backup gate, Task 3 imports `importBc2FileFromAttachment` without modifying it.
- File layout matches spec — Tasks 1, 2, 3 create the listed files; Task 4 adds the npm script.
- `RETRIABLE_REASONS` hardcoded — Task 1.
- CLI flags (`--i-have-a-backup`, `--audit-csv`, `--dump-dir`, `--verbose`) — Task 1.
- Data flow (parse → filter → group → createJob → per-project hydrate → per-attachment importOne → finishJob → summary) — Tasks 2, 3.
- Per-project / per-attachment error matrix — Task 2 tests cover unmapped project, missing attachment, throw, non-ok return.
- One-attempt-only (no script-level retry loop) — Task 2 implementation has no retry loop; relies on `importBc2FileFromAttachment` internal retry.
- Test plan (9 unit cases in spec) — Tasks 1 + 2 produce 14 tests covering all 9 (parseFlags split into 4 sub-tests for granularity).

**Placeholder scan:** No "TBD"/"TODO"/"implement later". Every step has runnable code or commands.

**Type / name consistency:**
- `RetryFlags`, `FailedFileRow`, `RETRIABLE_REASONS`, `parseFlags`, `pickRetriable`, `readFailedFiles` defined in Task 1; reused unchanged in Tasks 2 + 3.
- `RetryDeps`, `ProjectInfo`, `ImportOneResult`, `runRetry` defined in Task 2; reused unchanged in Task 3.
- `parseCsvLine` + `splitCsvRows` imported from `@/lib/imports/orphans/csv` (already merged to the orphan-recon branch; this branch is off main, so the imports resolve once orphan-recon merges — note for the implementer below).
- `importBc2FileFromAttachment` signature fields (`query`, `jobId`, `projectLocalId`, `storageDir`, `personMap`, `attachment`, `threadId`, `commentId`, `downloadEnv`, `adapter`, `createFileMetadata`, `logRecord`, `incrementCounters`, `projectArchived`) match the existing export.

**Dependency on orphan-recon branch:** Task 1 imports `parseCsvLine` + `splitCsvRows` from `lib/imports/orphans/csv.ts`. That module was added in PR #37 (`feat/recon-orphan-projects`) and is **not yet merged to main** at the time this plan is written. Two options:
1. **Wait for PR #37 to merge before starting this branch** (recommended — keeps the diff focused).
2. **Branch this off `feat/recon-orphan-projects` instead of `main`** — the imports resolve immediately but the eventual PR shows the union of both diffs.

The plan assumes option (1). If the implementer hits "module not found" on the orphan/csv imports at Step 1.4, either rebase onto the orphan-recon branch or copy the two parsers inline (the helpers are ~30 lines combined).

**Scope:** Single bucket subset. 44 Google-Doc URL failures are explicitly out of scope.
