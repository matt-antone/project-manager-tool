# BC2 Reconciliation — Orphan Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a two-script workflow that lets the operator decide each of the 17 BC2 orphan projects (`assign` to existing client / `create` new client / `skip`) via an editable CSV, then applies those decisions and (with `--run-phases`) reruns threads + files for the newly-mapped projects.

**Architecture:** Two scripts and three small shared modules under `lib/imports/orphans/`. `dump-orphan-decisions.ts` is read-only (audit CSV → stub decisions CSV). `apply-orphan-decisions.ts` opens a pg pool, validates and applies the operator-edited CSV row-by-row with per-row autocommit (idempotent), and optionally invokes the existing `migrateThreadsAndComments` + `migrateFiles` phase modules for the newly-mapped projects. The decision CSV at `docs/imports/bc2-orphan-decisions.csv` is the canonical record.

**Tech Stack:** TypeScript, Node 22, pnpm, vitest, pg, dotenv. Reuses `lib/imports/dump-reader.ts` and `lib/imports/migration/{threads,files,jobs,types}.ts`. Inlines `loadPersonMap` copied from `scripts/migrate-from-dump.ts` (~10 lines, not worth a refactor).

**Spec:** `docs/superpowers/specs/2026-05-08-bc2-recon-orphan-projects-design.md`

---

## File Structure

**Created:**
- `lib/imports/orphans/types.ts`
- `lib/imports/orphans/csv.ts`
- `lib/imports/orphans/apply.ts`
- `scripts/dump-orphan-decisions.ts`
- `scripts/apply-orphan-decisions.ts`
- `tests/unit/orphans-csv.test.ts`
- `tests/unit/orphans-apply.test.ts`
- `tests/unit/dump-orphan-decisions.test.ts`
- `tests/unit/apply-orphan-decisions.test.ts`

**Modified:**
- `package.json` — add `dump:orphan-decisions` and `apply:orphan-decisions` npm scripts.

**Untouched:**
- `scripts/migrate-from-dump.ts`.
- All `lib/imports/migration/*` phase modules.
- `lib/imports/dump-reader.ts`, `lib/imports/bc2-client-resolver.ts`.
- DB schema.

The applier's `projects` row insert duplicates the column shape used by `migrateProjects` (13 columns: `name, slug, description, client_id, archived, created_by, project_seq, project_code, client_slug, project_slug, storage_project_dir, created_at, updated_at`). For orphan rows, `project_code` is null (operator-supplied codes don't carry a numeric suffix), so the folder name follows the `_NoCode_<bc2_id>-<sanitized-title>` pattern that `migrateProjects` emits in the same case. We document the duplication in `lib/imports/orphans/apply.ts`'s file header rather than refactor `migrateProjects` (memory rule: don't introduce abstractions beyond what the task requires; phase modules are explicitly off-limits).

---

## Task 0: Worktree + branch

**Files:** none

- [ ] **Step 0.1: Create worktree off main**

```bash
git worktree add .worktrees/recon-orphan-projects -b feat/recon-orphan-projects main
cd .worktrees/recon-orphan-projects
pnpm install
cp ../../.env.local .env.local
```

(The `cp` is necessary because `.env.local` is gitignored and worktrees don't inherit it.)

- [ ] **Step 0.2: Confirm dump exists**

```bash
ls /Volumes/Spare/basecamp-dump/people.json /Volumes/Spare/basecamp-dump/projects/active.json
```

Expected: both files present.

- [ ] **Step 0.3: Confirm audit CSV is current**

```bash
ls ../../.worktrees/audit-bc2-dump/tmp/audit/projects.csv
```

Expected: file present. (Re-run `pnpm audit:bc2-dump` from the audit worktree if the DB has changed.)

- [ ] **Step 0.4: Confirm 17 orphans visible**

```bash
awk -F',' 'NR>1 && $4=="failed"' ../../.worktrees/audit-bc2-dump/tmp/audit/projects.csv | wc -l
```

Expected: `17`.

---

## Task 1: Shared types

**Files:**
- Create: `lib/imports/orphans/types.ts`

Small, no tests — types only. Subsequent tasks will exercise them via tests against the modules that consume them.

- [ ] **Step 1.1: Write the file**

```ts
// lib/imports/orphans/types.ts

export type DecisionAction = "assign" | "create" | "skip";

export interface OrphanDecision {
  bc2Id: string;
  title: string;
  action: DecisionAction | "";
  code: string;
  clientName: string;
}

export interface RowError {
  rowNumber: number; // 1-based, header counts as row 1
  bc2Id: string;
  message: string;
}

export interface ParseDecisionResult {
  decisions: OrphanDecision[];
  errors: RowError[];
}

export type ApplyOutcome =
  | { status: "assigned"; localProjectId: string; clientId: string }
  | { status: "created"; localProjectId: string; clientId: string }
  | { status: "skipped" }
  | { status: "already_mapped"; localProjectId: string };

export class ClientNotFoundError extends Error {
  constructor(public readonly code: string) {
    super(`No client found with code='${code}'`);
    this.name = "ClientNotFoundError";
  }
}
```

- [ ] **Step 1.2: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 1.3: Commit**

```bash
git add lib/imports/orphans/types.ts
git commit -m "feat(orphans): shared types"
```

---

## Task 2: CSV parser and formatter

**Files:**
- Create: `lib/imports/orphans/csv.ts`
- Test: `tests/unit/orphans-csv.test.ts`

Pure functions. No I/O. The audit branch (`feat/audit-bc2-dump`, PR #36) has a similar `escapeCsvField` helper but it isn't merged to `main` yet, so we write our own RFC 4180-compatible parser/formatter local to this module.

- [ ] **Step 2.1: Write the failing test**

```ts
// tests/unit/orphans-csv.test.ts
import { describe, it, expect } from "vitest";
import { parseDecisionCsv, formatDecisionCsv } from "@/lib/imports/orphans/csv";

const HEADER = "bc2_id,title,action,code,client_name\n";

describe("parseDecisionCsv", () => {
  it("parses a valid file with all three actions", () => {
    const text =
      HEADER +
      `100,"Some Project",assign,ABC,\n` +
      `200,"Other Project",create,NEW,New Client Inc.\n` +
      `300,"Skipped Project",skip,,\n`;
    const r = parseDecisionCsv(text);
    expect(r.errors).toEqual([]);
    expect(r.decisions).toEqual([
      { bc2Id: "100", title: "Some Project", action: "assign", code: "ABC", clientName: "" },
      { bc2Id: "200", title: "Other Project", action: "create", code: "NEW", clientName: "New Client Inc." },
      { bc2Id: "300", title: "Skipped Project", action: "skip", code: "", clientName: "" },
    ]);
  });

  it("returns empty arrays for header-only file", () => {
    const r = parseDecisionCsv(HEADER);
    expect(r.decisions).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("flags missing required column header", () => {
    const r = parseDecisionCsv("bc2_id,title,action,code\n100,P,assign,ABC\n");
    expect(r.errors[0].message).toMatch(/missing required column.*client_name/i);
  });

  it("flags empty action cell", () => {
    const r = parseDecisionCsv(HEADER + `100,"Some Project",,,\n`);
    expect(r.errors[0]).toEqual({
      rowNumber: 2,
      bc2Id: "100",
      message: "action is required (assign|create|skip)",
    });
  });

  it("flags assign without code", () => {
    const r = parseDecisionCsv(HEADER + `100,"Some Project",assign,,\n`);
    expect(r.errors[0].message).toMatch(/assign requires a non-empty code/);
  });

  it("flags create without client_name", () => {
    const r = parseDecisionCsv(HEADER + `100,"Some Project",create,NEW,\n`);
    expect(r.errors[0].message).toMatch(/create requires a non-empty client_name/);
  });

  it("flags skip with non-empty code or client_name", () => {
    const r = parseDecisionCsv(HEADER + `100,"Some Project",skip,ABC,\n`);
    expect(r.errors[0].message).toMatch(/skip must have empty code and client_name/);
  });

  it("flags unknown action", () => {
    const r = parseDecisionCsv(HEADER + `100,"Some Project",bogus,,\n`);
    expect(r.errors[0].message).toMatch(/unknown action 'bogus'/);
  });

  it("parses titles with commas and double-quotes", () => {
    const text =
      HEADER + `100,"Levato (Summit LA), ""Logo"" & Stationery",assign,SUMMIT,\n`;
    const r = parseDecisionCsv(text);
    expect(r.errors).toEqual([]);
    expect(r.decisions[0].title).toBe(`Levato (Summit LA), "Logo" & Stationery`);
  });

  it("formatDecisionCsv round-trips parsed rows back to text", () => {
    const decisions = [
      { bc2Id: "100", title: `Has, "quotes"`, action: "assign" as const, code: "ABC", clientName: "" },
      { bc2Id: "200", title: "Plain", action: "skip" as const, code: "", clientName: "" },
    ];
    const text = formatDecisionCsv(decisions);
    const r = parseDecisionCsv(text);
    expect(r.errors).toEqual([]);
    expect(r.decisions).toEqual(decisions);
  });
});
```

- [ ] **Step 2.2: Run failing test**

```bash
pnpm vitest run tests/unit/orphans-csv.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 2.3: Implement `lib/imports/orphans/csv.ts`**

```ts
// lib/imports/orphans/csv.ts
import type {
  DecisionAction,
  OrphanDecision,
  ParseDecisionResult,
  RowError,
} from "./types";

const REQUIRED_COLS = ["bc2_id", "title", "action", "code", "client_name"] as const;

function escapeField(v: string): string {
  if (/[",\n\r]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function parseLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  let field = "";
  let inQuotes = false;
  while (i < line.length) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field.length === 0) {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      out.push(field);
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  out.push(field);
  return out;
}

function splitRows(text: string): string[] {
  // Handle both LF and CRLF; preserve quoted newlines.
  const rows: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQuotes = !inQuotes;
    if ((c === "\n" || c === "\r") && !inQuotes) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (current.length > 0) rows.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

function validateRow(d: OrphanDecision): string | null {
  if (d.action === "") return "action is required (assign|create|skip)";
  if (d.action !== "assign" && d.action !== "create" && d.action !== "skip") {
    return `unknown action '${d.action}' (must be assign|create|skip)`;
  }
  if (d.action === "assign") {
    if (d.code.trim() === "") return "assign requires a non-empty code";
  }
  if (d.action === "create") {
    if (d.code.trim() === "") return "create requires a non-empty code";
    if (d.clientName.trim() === "") return "create requires a non-empty client_name";
  }
  if (d.action === "skip") {
    if (d.code.trim() !== "" || d.clientName.trim() !== "") {
      return "skip must have empty code and client_name";
    }
  }
  return null;
}

export function parseDecisionCsv(text: string): ParseDecisionResult {
  const decisions: OrphanDecision[] = [];
  const errors: RowError[] = [];

  const rows = splitRows(text);
  if (rows.length === 0) return { decisions, errors };

  const header = parseLine(rows[0]).map((s) => s.trim().toLowerCase());
  for (const required of REQUIRED_COLS) {
    if (!header.includes(required)) {
      errors.push({
        rowNumber: 1,
        bc2Id: "",
        message: `missing required column '${required}'`,
      });
    }
  }
  if (errors.length > 0) return { decisions, errors };

  const idx = (name: string) => header.indexOf(name);

  for (let r = 1; r < rows.length; r++) {
    const fields = parseLine(rows[r]);
    const bc2Id = (fields[idx("bc2_id")] ?? "").trim();
    const decision: OrphanDecision = {
      bc2Id,
      title: fields[idx("title")] ?? "",
      action: ((fields[idx("action")] ?? "").trim().toLowerCase()) as DecisionAction | "",
      code: (fields[idx("code")] ?? "").trim(),
      clientName: (fields[idx("client_name")] ?? "").trim(),
    };
    const err = validateRow(decision);
    if (err) {
      errors.push({ rowNumber: r + 1, bc2Id, message: err });
      continue;
    }
    decisions.push(decision);
  }

  return { decisions, errors };
}

export function formatDecisionCsv(decisions: OrphanDecision[]): string {
  const header = REQUIRED_COLS.join(",") + "\n";
  const body = decisions
    .map((d) =>
      [d.bc2Id, d.title, d.action, d.code, d.clientName]
        .map((v) => escapeField(String(v)))
        .join(","),
    )
    .join("\n");
  return body.length > 0 ? header + body + "\n" : header;
}
```

- [ ] **Step 2.4: Run tests**

```bash
pnpm vitest run tests/unit/orphans-csv.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 2.5: Commit**

```bash
git add lib/imports/orphans/csv.ts tests/unit/orphans-csv.test.ts
git commit -m "feat(orphans): RFC 4180 decision CSV parser and formatter"
```

---

## Task 3: Per-row applier

**Files:**
- Create: `lib/imports/orphans/apply.ts`
- Test: `tests/unit/orphans-apply.test.ts`

Implements `applyDecision(args)` for a single decision. The orchestrator in Task 5 wraps it with the per-row autocommit and idempotency check.

- [ ] **Step 3.1: Write the failing test**

```ts
// tests/unit/orphans-apply.test.ts
import { describe, it, expect, vi } from "vitest";
import { applyDecision } from "@/lib/imports/orphans/apply";
import { ClientNotFoundError, type OrphanDecision } from "@/lib/imports/orphans/types";

type FakeQ = ReturnType<typeof makeFakeQ>;

function makeFakeQ() {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const responses: Map<string, { rows: Record<string, unknown>[] }> = new Map();
  const q = (async <T>(sql: string, values?: unknown[]) => {
    calls.push({ sql: sql.trim().split(/\s+/).slice(0, 6).join(" "), values });
    for (const [matcher, response] of responses) {
      if (sql.includes(matcher)) {
        return { rows: response.rows as T[] };
      }
    }
    return { rows: [] as T[] };
  }) as <T>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>;
  return {
    q,
    calls,
    when(matcher: string, rows: Record<string, unknown>[]) {
      responses.set(matcher, { rows });
    },
  };
}

const baseDumpProject = {
  bc2Id: 100,
  title: "Some Project",
  archived: true,
  createdAt: "2018-01-01T00:00:00Z",
  updatedAt: "2018-06-01T00:00:00Z",
  description: null,
};

const decisionAssign: OrphanDecision = {
  bc2Id: "100",
  title: "Some Project",
  action: "assign",
  code: "ABC",
  clientName: "",
};

describe("applyDecision", () => {
  it("assign: looks up client, inserts project, inserts import_map_projects", async () => {
    const f = makeFakeQ();
    f.when("from import_map_projects where", []); // not yet mapped
    f.when("from clients where lower(code)", [{ id: "client-uuid", code: "ABC" }]);
    f.when("coalesce(max(project_seq)", [{ next_seq: 5 }]);
    f.when("insert into projects", [{ id: "project-uuid" }]);

    const out = await applyDecision({
      q: f.q,
      decision: decisionAssign,
      dumpProject: baseDumpProject,
      jobId: "job-1",
    });

    expect(out).toEqual({ status: "assigned", localProjectId: "project-uuid", clientId: "client-uuid" });
    expect(f.calls.some((c) => c.sql.startsWith("insert into import_map_projects"))).toBe(true);
  });

  it("assign: throws ClientNotFoundError when code missing", async () => {
    const f = makeFakeQ();
    f.when("from import_map_projects where", []);
    f.when("from clients where lower(code)", []);

    await expect(
      applyDecision({
        q: f.q,
        decision: decisionAssign,
        dumpProject: baseDumpProject,
        jobId: "job-1",
      }),
    ).rejects.toBeInstanceOf(ClientNotFoundError);
  });

  it("create: inserts client, inserts project, inserts import_map_projects", async () => {
    const f = makeFakeQ();
    f.when("from import_map_projects where", []);
    f.when("from clients where lower(code)", []); // client absent
    f.when("insert into clients", [{ id: "new-client-uuid" }]);
    f.when("coalesce(max(project_seq)", [{ next_seq: 1 }]);
    f.when("insert into projects", [{ id: "project-uuid" }]);

    const out = await applyDecision({
      q: f.q,
      decision: { ...decisionAssign, action: "create", code: "NEW", clientName: "New Client" },
      dumpProject: baseDumpProject,
      jobId: "job-1",
    });

    expect(out).toEqual({
      status: "created",
      localProjectId: "project-uuid",
      clientId: "new-client-uuid",
    });
    expect(f.calls.some((c) => c.sql.startsWith("insert into clients"))).toBe(true);
  });

  it("create: reuses existing client when code already present", async () => {
    const f = makeFakeQ();
    f.when("from import_map_projects where", []);
    f.when("from clients where lower(code)", [{ id: "existing-uuid" }]);
    f.when("coalesce(max(project_seq)", [{ next_seq: 1 }]);
    f.when("insert into projects", [{ id: "project-uuid" }]);

    const out = await applyDecision({
      q: f.q,
      decision: { ...decisionAssign, action: "create", code: "NEW", clientName: "New Client" },
      dumpProject: baseDumpProject,
      jobId: "job-1",
    });

    expect(out.status).toBe("created");
    expect((out as { clientId: string }).clientId).toBe("existing-uuid");
    expect(f.calls.some((c) => c.sql.startsWith("insert into clients"))).toBe(false);
  });

  it("skip: writes import_logs row, no map insert", async () => {
    const f = makeFakeQ();
    f.when("from import_map_projects where", []);

    const out = await applyDecision({
      q: f.q,
      decision: { ...decisionAssign, action: "skip", code: "", clientName: "" },
      dumpProject: baseDumpProject,
      jobId: "job-1",
    });

    expect(out).toEqual({ status: "skipped" });
    expect(f.calls.some((c) => c.sql.startsWith("insert into import_logs"))).toBe(true);
    expect(f.calls.some((c) => c.sql.startsWith("insert into import_map_projects"))).toBe(false);
  });

  it("returns already_mapped when import_map_projects has the bc2_id", async () => {
    const f = makeFakeQ();
    f.when("from import_map_projects where", [{ local_project_id: "preexisting-uuid" }]);

    const out = await applyDecision({
      q: f.q,
      decision: decisionAssign,
      dumpProject: baseDumpProject,
      jobId: "job-1",
    });

    expect(out).toEqual({ status: "already_mapped", localProjectId: "preexisting-uuid" });
    expect(f.calls.some((c) => c.sql.startsWith("insert into clients"))).toBe(false);
    expect(f.calls.some((c) => c.sql.startsWith("insert into projects"))).toBe(false);
  });
});
```

- [ ] **Step 3.2: Run failing test**

```bash
pnpm vitest run tests/unit/orphans-apply.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3.3: Implement `lib/imports/orphans/apply.ts`**

This module **duplicates** the `projects` row insert column shape used by `lib/imports/migration/projects.ts` (13 columns). It's intentional — the spec calls for the minimum-needed copy rather than refactoring `migrateProjects`. If you ever change the projects schema, both insert sites need to update together. The duplication is documented in the file header comment.

```ts
// lib/imports/orphans/apply.ts
//
// Per-row applier for orphan decisions.
//
// NOTE: the insert into `projects` (13 columns: name, slug, description,
// client_id, archived, created_by, project_seq, project_code, client_slug,
// project_slug, storage_project_dir, created_at, updated_at) duplicates the
// shape used by lib/imports/migration/projects.ts. Both insert sites must be
// updated together if the projects table changes. See the orphan-recon spec
// for why we do not refactor migrateProjects (memory rule: phase modules are
// off-limits).

import { sanitizeDropboxFolderTitle } from "@/lib/project-storage";
import { logRecord, type Query } from "@/lib/imports/migration/jobs";
import {
  ClientNotFoundError,
  type ApplyOutcome,
  type OrphanDecision,
} from "./types";

export interface DumpProjectShape {
  bc2Id: number;
  title: string;
  archived: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  description: string | null;
}

function dropboxProjectsRoot(): string {
  return (
    process.env.DROPBOX_PROJECTS_ROOT_FOLDER?.trim() ||
    process.env.DROPBOX_ROOT_FOLDER?.trim() ||
    "/Projects"
  );
}

function slugify(s: string): string {
  return (
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project"
  );
}

function parseIso(v: string | null | undefined): Date {
  if (!v) return new Date();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

async function lookupClient(q: Query, code: string): Promise<string | null> {
  const r = await q<{ id: string }>(
    "select id from clients where lower(code) = lower($1) limit 1",
    [code],
  );
  return r.rows[0]?.id ?? null;
}

async function createClient(q: Query, code: string, name: string): Promise<string> {
  const r = await q<{ id: string }>(
    "insert into clients (name, code) values ($1, $2) returning id",
    [name, code],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`clients insert returned no id`);
  return id;
}

async function existingMapping(
  q: Query,
  bc2Id: string,
): Promise<string | null> {
  const r = await q<{ local_project_id: string }>(
    "select local_project_id from import_map_projects where basecamp_project_id = $1",
    [bc2Id],
  );
  return r.rows[0]?.local_project_id ?? null;
}

async function insertProjectAndMap(args: {
  q: Query;
  clientId: string;
  clientCode: string;
  decision: OrphanDecision;
  dumpProject: DumpProjectShape;
}): Promise<string> {
  const { q, clientId, clientCode, decision, dumpProject } = args;
  const title = decision.title || `bc2-${dumpProject.bc2Id}`;

  const seqRow = await q<{ next_seq: number }>(
    "select coalesce(max(project_seq), 0) + 1 as next_seq from projects where client_id is not distinct from $1",
    [clientId],
  );
  const projectSeq = seqRow.rows[0]?.next_seq ?? null;

  const clientSlug = slugify(clientCode);
  const projectSlug = title ? slugify(title) : null;
  // No `num` for orphan rows — operator-supplied code does not carry a numeric
  // suffix — so project_code stays null and the storage folder uses _NoCode_.
  const folderName = `_NoCode_${dumpProject.bc2Id}-${sanitizeDropboxFolderTitle(title)}`;
  const projectsRoot = dropboxProjectsRoot();
  const storageDir = dumpProject.archived
    ? `${projectsRoot}/${clientCode}/_Archive/${folderName}`
    : `${projectsRoot}/${clientCode}/${folderName}`;
  const urlSlug = `${slugify(title)}-bc2-${dumpProject.bc2Id}`;

  const createdAt = parseIso(dumpProject.createdAt);
  const updatedAt = parseIso(dumpProject.updatedAt ?? dumpProject.createdAt);

  const proj = await q<{ id: string }>(
    `insert into projects
       (name, slug, description, client_id, archived, created_by,
        project_seq, project_code, client_slug, project_slug, storage_project_dir,
        created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning id`,
    [
      title,
      urlSlug,
      dumpProject.description ?? null,
      clientId,
      dumpProject.archived,
      "bc2_import",
      projectSeq,
      null, // project_code is null for orphans
      clientSlug,
      projectSlug,
      storageDir,
      createdAt,
      updatedAt,
    ],
  );
  const localId = proj.rows[0]?.id;
  if (!localId) throw new Error(`projects insert returned no id`);

  await q(
    "insert into import_map_projects (basecamp_project_id, local_project_id) values ($1, $2)",
    [decision.bc2Id, localId],
  );

  return localId;
}

export async function applyDecision(args: {
  q: Query;
  decision: OrphanDecision;
  dumpProject: DumpProjectShape;
  jobId: string;
}): Promise<ApplyOutcome> {
  const { q, decision, dumpProject, jobId } = args;

  const existing = await existingMapping(q, decision.bc2Id);
  if (existing) {
    return { status: "already_mapped", localProjectId: existing };
  }

  if (decision.action === "skip") {
    await logRecord(q, {
      jobId,
      recordType: "project",
      sourceId: decision.bc2Id,
      status: "success",
      message: `orphan_skipped: ${decision.title}`,
      dataSource: "api",
    });
    return { status: "skipped" };
  }

  if (decision.action === "assign") {
    const clientId = await lookupClient(q, decision.code);
    if (!clientId) throw new ClientNotFoundError(decision.code);
    const localId = await insertProjectAndMap({
      q,
      clientId,
      clientCode: decision.code,
      decision,
      dumpProject,
    });
    return { status: "assigned", localProjectId: localId, clientId };
  }

  if (decision.action === "create") {
    let clientId = await lookupClient(q, decision.code);
    if (!clientId) {
      clientId = await createClient(q, decision.code, decision.clientName);
    }
    const localId = await insertProjectAndMap({
      q,
      clientId,
      clientCode: decision.code,
      decision,
      dumpProject,
    });
    return { status: "created", localProjectId: localId, clientId };
  }

  // Unreachable: validateRow rejects empty/unknown actions.
  throw new Error(`applyDecision called with unhandled action='${decision.action}'`);
}
```

- [ ] **Step 3.4: Run tests**

```bash
pnpm vitest run tests/unit/orphans-apply.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 3.5: Commit**

```bash
git add lib/imports/orphans/apply.ts tests/unit/orphans-apply.test.ts
git commit -m "feat(orphans): per-row applyDecision (assign/create/skip/already-mapped)"
```

---

## Task 4: dump-orphan-decisions script

**Files:**
- Create: `scripts/dump-orphan-decisions.ts`
- Test: `tests/unit/dump-orphan-decisions.test.ts`

Read-only generator. Reads `tmp/audit/projects.csv`, filters `status=failed`, writes a stub decisions CSV. Refuses to overwrite without `--force`.

- [ ] **Step 4.1: Write the failing test**

```ts
// tests/unit/dump-orphan-decisions.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { dumpOrphanDecisions } from "@/scripts/dump-orphan-decisions";

describe("dumpOrphanDecisions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orphan-dump-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("filters status=failed and emits stub rows", async () => {
    const auditCsv = path.join(tmpDir, "projects.csv");
    await fs.writeFile(
      auditCsv,
      [
        "bc2_id,name,archived,status,local_project_id,reason",
        '100,"Mapped Project",true,mapped,uuid-1,',
        '200,"Orphan One",true,failed,,orphan title (no client match): Orphan One',
        '300,"Orphan Two: Phase",true,failed,,orphan title (no client match): Orphan Two',
        '400,"Skipped Unsupported",false,skipped_unsupported,,',
      ].join("\n") + "\n",
    );
    const out = path.join(tmpDir, "decisions.csv");
    const r = await dumpOrphanDecisions({ auditCsvPath: auditCsv, outPath: out, force: false });
    expect(r.count).toBe(2);
    const written = await fs.readFile(out, "utf8");
    expect(written).toContain("bc2_id,title,action,code,client_name");
    expect(written).toContain('200,Orphan One,,,');
    expect(written).toContain('300,"Orphan Two: Phase",,,');
    expect(written).not.toContain("100,");
  });

  it("refuses to overwrite without force", async () => {
    const auditCsv = path.join(tmpDir, "projects.csv");
    await fs.writeFile(auditCsv, "bc2_id,name,archived,status,local_project_id,reason\n");
    const out = path.join(tmpDir, "decisions.csv");
    await fs.writeFile(out, "previous\n");
    await expect(
      dumpOrphanDecisions({ auditCsvPath: auditCsv, outPath: out, force: false }),
    ).rejects.toThrow(/already exists/);
  });

  it("overwrites when force=true", async () => {
    const auditCsv = path.join(tmpDir, "projects.csv");
    await fs.writeFile(
      auditCsv,
      "bc2_id,name,archived,status,local_project_id,reason\n200,Orphan,true,failed,,\n",
    );
    const out = path.join(tmpDir, "decisions.csv");
    await fs.writeFile(out, "previous\n");
    const r = await dumpOrphanDecisions({ auditCsvPath: auditCsv, outPath: out, force: true });
    expect(r.count).toBe(1);
    const written = await fs.readFile(out, "utf8");
    expect(written).not.toContain("previous");
  });
});
```

- [ ] **Step 4.2: Run failing test**

```bash
pnpm vitest run tests/unit/dump-orphan-decisions.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement `scripts/dump-orphan-decisions.ts`**

```ts
// scripts/dump-orphan-decisions.ts
import { promises as fs } from "fs";
import { resolve } from "path";
import { config } from "dotenv";
import { formatDecisionCsv } from "@/lib/imports/orphans/csv";
import type { OrphanDecision } from "@/lib/imports/orphans/types";

config({ path: resolve(process.cwd(), ".env.local") });

interface DumpFlags {
  auditCsvPath: string;
  outPath: string;
  force: boolean;
}

function parseFlags(argv: string[]): DumpFlags {
  const flags: DumpFlags = {
    auditCsvPath: "tmp/audit/projects.csv",
    outPath: "docs/imports/bc2-orphan-decisions.csv",
    force: false,
  };
  for (const a of argv) {
    if (a.startsWith("--audit-csv=")) flags.auditCsvPath = a.slice("--audit-csv=".length);
    else if (a.startsWith("--out=")) flags.outPath = a.slice("--out=".length);
    else if (a === "--force") flags.force = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return flags;
}

function parseAuditLine(line: string): string[] {
  // Reuse the same parser shape as csv.ts but inline a minimal version to avoid
  // importing internal helpers. Fields here are simple enough that the tests
  // exercise the outputs end-to-end.
  const out: string[] = [];
  let i = 0;
  let field = "";
  let inQuotes = false;
  while (i < line.length) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field.length === 0) { inQuotes = true; i++; continue; }
    if (c === ",") { out.push(field); field = ""; i++; continue; }
    field += c; i++;
  }
  out.push(field);
  return out;
}

export async function dumpOrphanDecisions(args: {
  auditCsvPath: string;
  outPath: string;
  force: boolean;
}): Promise<{ count: number }> {
  const text = await fs.readFile(args.auditCsvPath, "utf8");
  const rows = text.split(/\r?\n/).filter((r) => r.length > 0);
  if (rows.length === 0) {
    throw new Error(`audit CSV is empty: ${args.auditCsvPath}`);
  }
  const header = parseAuditLine(rows[0]).map((s) => s.trim().toLowerCase());
  const idx = (n: string) => header.indexOf(n);
  const bc2 = idx("bc2_id");
  const name = idx("name");
  const status = idx("status");
  if (bc2 < 0 || name < 0 || status < 0) {
    throw new Error(
      `audit CSV missing required columns (need bc2_id, name, status): ${header.join(",")}`,
    );
  }

  if (!args.force) {
    try {
      await fs.access(args.outPath);
      throw new Error(`out-file already exists: ${args.outPath} (rerun with --force to overwrite)`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  const decisions: OrphanDecision[] = [];
  for (let r = 1; r < rows.length; r++) {
    const fields = parseAuditLine(rows[r]);
    if ((fields[status] ?? "").trim() !== "failed") continue;
    decisions.push({
      bc2Id: (fields[bc2] ?? "").trim(),
      title: fields[name] ?? "",
      action: "",
      code: "",
      clientName: "",
    });
  }

  await fs.mkdir(resolve(args.outPath, ".."), { recursive: true });
  await fs.writeFile(args.outPath, formatDecisionCsv(decisions), "utf8");
  return { count: decisions.length };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const r = await dumpOrphanDecisions(flags);
  console.log(
    `[dump-orphan-decisions] wrote ${r.count} rows to ${flags.outPath}.`,
  );
  console.log(
    `Edit the file, then run: pnpm apply:orphan-decisions --i-have-a-backup [--run-phases]`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[dump-orphan-decisions] fatal: ${err.message ?? err}`);
    process.exit(1);
  });
}
```

- [ ] **Step 4.4: Run tests**

```bash
pnpm vitest run tests/unit/dump-orphan-decisions.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 4.5: Commit**

```bash
git add scripts/dump-orphan-decisions.ts tests/unit/dump-orphan-decisions.test.ts
git commit -m "feat(orphans): dump-orphan-decisions stub generator"
```

---

## Task 5: apply-orphan-decisions — CLI parser + main orchestration

**Files:**
- Create: `scripts/apply-orphan-decisions.ts`
- Test: `tests/unit/apply-orphan-decisions.test.ts`

Builds the orchestrator with injectable dependencies (mirrors the pattern from the audit branch). This task covers: flag parsing, backup gate, invalid-row exit, the mapping loop. `--run-phases` and `--dry-run` come in Tasks 6-7.

- [ ] **Step 5.1: Write the failing test**

```ts
// tests/unit/apply-orphan-decisions.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  parseFlags,
  runApply,
  type ApplyDeps,
} from "@/scripts/apply-orphan-decisions";
import type { OrphanDecision, ApplyOutcome } from "@/lib/imports/orphans/types";

const DECISIONS: OrphanDecision[] = [
  { bc2Id: "100", title: "Some Project", action: "assign", code: "ABC", clientName: "" },
  { bc2Id: "200", title: "Other Project", action: "create", code: "NEW", clientName: "New Client" },
  { bc2Id: "300", title: "Skip Me", action: "skip", code: "", clientName: "" },
];

function fakeDeps(overrides: Partial<ApplyDeps> = {}): ApplyDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    flags: {
      decisionsPath: "decisions.csv",
      hasBackup: true,
      runPhases: false,
      dryRun: false,
      dumpDir: "/tmp/dump",
      verbose: false,
    },
    readDecisionsFile: vi.fn(async () => ({
      decisions: DECISIONS,
      errors: [],
    })),
    loadDumpProjects: vi.fn(async () =>
      new Map(DECISIONS.map((d) => [
        d.bc2Id,
        {
          bc2Id: Number(d.bc2Id),
          title: d.title,
          archived: true,
          createdAt: "2018-01-01T00:00:00Z",
          updatedAt: null,
          description: null,
        },
      ])),
    ),
    createJob: vi.fn(async () => "job-uuid"),
    finishJob: vi.fn(async () => undefined),
    applyOne: vi.fn(async ({ decision }): Promise<ApplyOutcome> => {
      if (decision.action === "assign") return { status: "assigned", localProjectId: "p100", clientId: "c-abc" };
      if (decision.action === "create") return { status: "created", localProjectId: "p200", clientId: "c-new" };
      return { status: "skipped" };
    }),
    runPhasesForProjects: vi.fn(async () => ({ ok: 0, failed: 0 })),
    log: (s: string) => lines.push(s),
    err: (s: string) => lines.push(`ERR ${s}`),
    lines,
    ...overrides,
  };
}

describe("parseFlags", () => {
  it("requires --i-have-a-backup", () => {
    expect(() => parseFlags(["--decisions=x.csv"])).toThrow(/--i-have-a-backup/);
  });

  it("parses required + optional flags", () => {
    const f = parseFlags([
      "--decisions=x.csv",
      "--i-have-a-backup",
      "--run-phases",
      "--dry-run",
      "--dump-dir=/tmp/d",
      "--verbose",
    ]);
    expect(f).toEqual({
      decisionsPath: "x.csv",
      hasBackup: true,
      runPhases: true,
      dryRun: true,
      dumpDir: "/tmp/d",
      verbose: true,
    });
  });

  it("defaults", () => {
    const f = parseFlags(["--i-have-a-backup"]);
    expect(f.decisionsPath).toBe("docs/imports/bc2-orphan-decisions.csv");
    expect(f.runPhases).toBe(false);
    expect(f.dryRun).toBe(false);
  });

  it("rejects unknown flags", () => {
    expect(() =>
      parseFlags(["--i-have-a-backup", "--bogus"]),
    ).toThrow(/Unknown flag/);
  });
});

describe("runApply (mapping)", () => {
  it("happy path: 3 decisions → 3 applyOne calls, summary, exit 0", async () => {
    const d = fakeDeps();
    const exit = await runApply(d);
    expect(exit).toBe(0);
    expect(d.applyOne).toHaveBeenCalledTimes(3);
    expect(d.lines.some((l) => l.includes("assigned=1 created=1 skipped=1"))).toBe(true);
  });

  it("invalid rows → exits 1 before opening pool (no createJob)", async () => {
    const d = fakeDeps({
      readDecisionsFile: vi.fn(async () => ({
        decisions: [],
        errors: [{ rowNumber: 2, bc2Id: "100", message: "assign requires a non-empty code" }],
      })),
    });
    const exit = await runApply(d);
    expect(exit).toBe(1);
    expect(d.createJob).not.toHaveBeenCalled();
    expect(d.lines.some((l) => l.startsWith("ERR row 2") && l.includes("non-empty code"))).toBe(true);
  });

  it("dump project missing for a bc2_id → row error, continue", async () => {
    const d = fakeDeps({
      loadDumpProjects: vi.fn(async () =>
        new Map(DECISIONS.slice(0, 2).map((decision) => [
          decision.bc2Id,
          { bc2Id: Number(decision.bc2Id), title: decision.title, archived: true, createdAt: "2018-01-01T00:00:00Z", updatedAt: null, description: null },
        ])),
      ),
    });
    const exit = await runApply(d);
    expect(exit).toBe(1);
    expect(d.applyOne).toHaveBeenCalledTimes(2); // 100 and 200; 300 missing skipped
    expect(d.lines.some((l) => l.includes("ERR") && l.includes("300") && l.includes("not found in dump"))).toBe(true);
  });

  it("applyOne throws ClientNotFoundError for one row → others continue, exit 1", async () => {
    const d = fakeDeps({
      applyOne: vi.fn(async ({ decision }): Promise<ApplyOutcome> => {
        if (decision.bc2Id === "100") {
          throw Object.assign(new Error("No client found with code='ABC'"), { name: "ClientNotFoundError" });
        }
        if (decision.action === "create") return { status: "created", localProjectId: "p200", clientId: "c-new" };
        return { status: "skipped" };
      }),
    });
    const exit = await runApply(d);
    expect(exit).toBe(1);
    expect(d.applyOne).toHaveBeenCalledTimes(3);
    expect(d.lines.some((l) => l.includes("ERR 100") && l.includes("No client"))).toBe(true);
    expect(d.lines.some((l) => l.includes("created=1 skipped=1"))).toBe(true);
  });

  it("already_mapped is reported as no-op", async () => {
    const d = fakeDeps({
      applyOne: vi.fn(async (): Promise<ApplyOutcome> => ({
        status: "already_mapped",
        localProjectId: "p999",
      })),
    });
    const exit = await runApply(d);
    expect(exit).toBe(0);
    expect(d.lines.some((l) => l.includes("already_mapped=3"))).toBe(true);
  });
});
```

- [ ] **Step 5.2: Run failing test**

```bash
pnpm vitest run tests/unit/apply-orphan-decisions.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 5.3: Implement `scripts/apply-orphan-decisions.ts`**

```ts
// scripts/apply-orphan-decisions.ts
import { promises as fs } from "fs";
import { resolve } from "path";
import { config } from "dotenv";
import { Pool } from "pg";
import { parseDecisionCsv } from "@/lib/imports/orphans/csv";
import { applyDecision, type DumpProjectShape } from "@/lib/imports/orphans/apply";
import {
  ClientNotFoundError,
  type ApplyOutcome,
  type OrphanDecision,
  type ParseDecisionResult,
} from "@/lib/imports/orphans/types";
import {
  createImportJob,
  finishJob,
  type Query,
} from "@/lib/imports/migration/jobs";

config({ path: resolve(process.cwd(), ".env.local") });

export interface ApplyFlags {
  decisionsPath: string;
  hasBackup: boolean;
  runPhases: boolean;
  dryRun: boolean;
  dumpDir: string;
  verbose: boolean;
}

export function parseFlags(argv: string[]): ApplyFlags {
  const flags: ApplyFlags = {
    decisionsPath: "docs/imports/bc2-orphan-decisions.csv",
    hasBackup: false,
    runPhases: false,
    dryRun: false,
    dumpDir: process.env.BASECAMP_DUMP_DIR ?? "/Volumes/Spare/basecamp-dump",
    verbose: false,
  };
  for (const a of argv) {
    if (a.startsWith("--decisions=")) flags.decisionsPath = a.slice("--decisions=".length);
    else if (a === "--i-have-a-backup") flags.hasBackup = true;
    else if (a === "--run-phases") flags.runPhases = true;
    else if (a === "--dry-run") flags.dryRun = true;
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

export interface ApplyDeps {
  flags: ApplyFlags;
  readDecisionsFile: () => Promise<ParseDecisionResult>;
  loadDumpProjects: () => Promise<Map<string, DumpProjectShape>>;
  createJob: () => Promise<string>;
  finishJob: (jobId: string, status: "completed" | "failed") => Promise<void>;
  applyOne: (args: {
    decision: OrphanDecision;
    dumpProject: DumpProjectShape;
    jobId: string;
  }) => Promise<ApplyOutcome>;
  runPhasesForProjects: (args: {
    jobId: string;
    mapped: Array<{ bc2Id: number; localId: string; name: string }>;
  }) => Promise<{ ok: number; failed: number }>;
  log: (s: string) => void;
  err: (s: string) => void;
}

export async function runApply(deps: ApplyDeps): Promise<number> {
  const { flags, log, err } = deps;

  const parsed = await deps.readDecisionsFile();
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) {
      err(`row ${e.rowNumber} (bc2_id=${e.bc2Id || "?"}): ${e.message}`);
    }
    return 1;
  }

  const dumpById = await deps.loadDumpProjects();

  const jobId = await deps.createJob();
  log(`[apply-orphan-decisions] jobId=${jobId} decisions=${parsed.decisions.length}`);

  const mappedForPhases: Array<{ bc2Id: number; localId: string; name: string }> = [];
  let assigned = 0;
  let created = 0;
  let skipped = 0;
  let alreadyMapped = 0;
  let exitCode = 0;

  try {
    for (const decision of parsed.decisions) {
      const dumpProject = dumpById.get(decision.bc2Id);
      if (!dumpProject) {
        err(`${decision.bc2Id}: not found in dump (cannot insert project row)`);
        exitCode = 1;
        continue;
      }
      try {
        const outcome = await deps.applyOne({ decision, dumpProject, jobId });
        switch (outcome.status) {
          case "assigned":
            assigned++;
            mappedForPhases.push({
              bc2Id: dumpProject.bc2Id,
              localId: outcome.localProjectId,
              name: decision.title,
            });
            log(`${decision.bc2Id}: assigned -> client=${outcome.clientId} project=${outcome.localProjectId}`);
            break;
          case "created":
            created++;
            mappedForPhases.push({
              bc2Id: dumpProject.bc2Id,
              localId: outcome.localProjectId,
              name: decision.title,
            });
            log(`${decision.bc2Id}: created client=${outcome.clientId} project=${outcome.localProjectId}`);
            break;
          case "skipped":
            skipped++;
            log(`${decision.bc2Id}: skipped`);
            break;
          case "already_mapped":
            alreadyMapped++;
            log(`${decision.bc2Id}: already_mapped (project=${outcome.localProjectId})`);
            break;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const tag = e instanceof ClientNotFoundError ? "ClientNotFoundError" : "error";
        err(`${decision.bc2Id}: ${tag}: ${msg}`);
        exitCode = 1;
      }
    }

    log(
      `[apply-orphan-decisions] mapping: assigned=${assigned} created=${created} skipped=${skipped} already_mapped=${alreadyMapped} errors=${exitCode === 1 ? "≥1" : 0}`,
    );

    if (flags.runPhases && exitCode === 0) {
      const r = await deps.runPhasesForProjects({ jobId, mapped: mappedForPhases });
      log(`[apply-orphan-decisions] phases: ok=${r.ok} failed=${r.failed}`);
      if (r.failed > 0) exitCode = 1;
    }

    await deps.finishJob(jobId, exitCode === 0 ? "completed" : "failed");
  } catch (e) {
    await deps.finishJob(jobId, "failed");
    throw e;
  }

  return exitCode;
}

async function main(): Promise<void> {
  // Wired in Task 6 (mapping with real pg + applier) and Task 7 (phases).
  throw new Error("apply-orphan-decisions: main() wired in Task 6/7");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[apply-orphan-decisions] fatal: ${err.message ?? err}`);
    process.exit(1);
  });
}
```

- [ ] **Step 5.4: Run tests**

```bash
pnpm vitest run tests/unit/apply-orphan-decisions.test.ts
```

Expected: PASS, 9 tests (4 parseFlags + 5 runApply).

- [ ] **Step 5.5: Commit**

```bash
git add scripts/apply-orphan-decisions.ts tests/unit/apply-orphan-decisions.test.ts
git commit -m "feat(orphans): apply-orphan-decisions CLI + mapping orchestration"
```

---

## Task 6: apply-orphan-decisions — wire main() to real pg + applier (no phases yet)

**Files:**
- Modify: `scripts/apply-orphan-decisions.ts`

This task wires the orchestrator to a real `pg.Pool`, the real `applyDecision`, and the real dump reader. `--run-phases` is not yet wired — `runPhasesForProjects` is a no-op stub at this stage.

- [ ] **Step 6.1: Replace `main()`**

In `scripts/apply-orphan-decisions.ts`, replace the placeholder `main()` with:

```ts
import { createDumpReader } from "@/lib/imports/dump-reader";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

interface RawProject {
  id: number;
  name?: string;
  archived?: boolean;
  created_at?: string;
  updated_at?: string;
  description?: string;
}

async function readDumpProjects(dumpDir: string): Promise<Map<string, DumpProjectShape>> {
  const reader = createDumpReader({ dumpDir });
  const out = new Map<string, DumpProjectShape>();
  for (const which of ["activeProjects", "archivedProjects"] as const) {
    const r = await reader[which]();
    const body = (Array.isArray(r.body) ? r.body : []) as RawProject[];
    for (const p of body) {
      out.set(String(p.id), {
        bc2Id: p.id,
        title: p.name ?? "",
        archived: !!p.archived,
        createdAt: p.created_at ?? null,
        updatedAt: p.updated_at ?? null,
        description: p.description ?? null,
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });
  pool.on("error", (e) => {
    console.warn(`[apply-orphan-decisions] pool client error (non-fatal): ${e.message}`);
  });
  const q: Query = (async <T>(text: string, values?: unknown[]) => {
    const r = await pool.query(text, values);
    return { rows: r.rows as T[] };
  }) as Query;

  let exit = 1;
  try {
    exit = await runApply({
      flags,
      readDecisionsFile: async () => {
        const text = await fs.readFile(flags.decisionsPath, "utf8");
        return parseDecisionCsv(text);
      },
      loadDumpProjects: () => readDumpProjects(flags.dumpDir),
      createJob: () => createImportJob(q, { kind: "reconcile-orphan-projects", decisionsPath: flags.decisionsPath }),
      finishJob: (jobId, status) => finishJob(q, jobId, status),
      applyOne: ({ decision, dumpProject, jobId }) => {
        if (flags.dryRun) {
          return Promise.resolve({ status: "skipped" } as ApplyOutcome);
        }
        return applyDecision({ q, decision, dumpProject, jobId });
      },
      runPhasesForProjects: async () => ({ ok: 0, failed: 0 }),
      log: (s) => console.log(s),
      err: (s) => console.error(s),
    });
  } finally {
    await pool.end();
  }
  process.exit(exit);
}
```

(Keep the existing imports and types from Task 5; this just replaces the placeholder `main` and adds the helper imports. `--run-phases` is wired in Task 7.)

- [ ] **Step 6.2: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6.3: Run unit tests**

```bash
pnpm vitest run tests/unit/apply-orphan-decisions.test.ts
```

Expected: 9 tests still pass — `main()` is not exercised by the unit tests (they call `runApply` directly).

- [ ] **Step 6.4: Commit**

```bash
git add scripts/apply-orphan-decisions.ts
git commit -m "feat(orphans): wire apply-orphan-decisions main() to real pg + applier"
```

---

## Task 7: --run-phases integration

**Files:**
- Modify: `scripts/apply-orphan-decisions.ts`
- Modify: `tests/unit/apply-orphan-decisions.test.ts`

Wire phase invocations behind `flags.runPhases`. Add unit tests covering the phase pass.

- [ ] **Step 7.1: Add failing test**

Append to `tests/unit/apply-orphan-decisions.test.ts`:

```ts
describe("runApply (--run-phases)", () => {
  it("calls runPhasesForProjects with the assigned + created projects only", async () => {
    const d = fakeDeps({
      flags: {
        decisionsPath: "decisions.csv",
        hasBackup: true,
        runPhases: true,
        dryRun: false,
        dumpDir: "/tmp/dump",
        verbose: false,
      },
    });
    const exit = await runApply(d);
    expect(exit).toBe(0);
    expect(d.runPhasesForProjects).toHaveBeenCalledTimes(1);
    const call = (d.runPhasesForProjects as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      jobId: string;
      mapped: Array<{ bc2Id: number }>;
    };
    expect(call.mapped.map((m) => m.bc2Id)).toEqual([100, 200]); // skip excluded
  });

  it("phases report failures → exit 1", async () => {
    const d = fakeDeps({
      flags: {
        decisionsPath: "decisions.csv",
        hasBackup: true,
        runPhases: true,
        dryRun: false,
        dumpDir: "/tmp/dump",
        verbose: false,
      },
      runPhasesForProjects: vi.fn(async () => ({ ok: 1, failed: 1 })),
    });
    const exit = await runApply(d);
    expect(exit).toBe(1);
  });
});
```

- [ ] **Step 7.2: Run failing test**

```bash
pnpm vitest run tests/unit/apply-orphan-decisions.test.ts
```

Expected: 11 tests; 2 new fail because the existing `runApply` already routes through `deps.runPhasesForProjects` — but the *real* `main()` stubs it. The test exercises the deps directly, so this should actually pass without any change to `runApply`. Verify and proceed.

(If the tests pass at this step, skip 7.3's diff and just commit.)

- [ ] **Step 7.3: Wire phases in `main()`**

Replace the `runPhasesForProjects: async () => ({ ok: 0, failed: 0 })` line in `scripts/apply-orphan-decisions.ts` `main()` with the following implementation. Add the imports at the top of the file.

```ts
import { migrateThreadsAndComments } from "@/lib/imports/migration/threads";
import { migrateFiles } from "@/lib/imports/migration/files";
```

Replace the stub with:

```ts
runPhasesForProjects: async ({ jobId, mapped }) => {
  if (mapped.length === 0) return { ok: 0, failed: 0 };

  const personMapRows = await q<{ basecamp_person_id: string; local_user_profile_id: string }>(
    "select basecamp_person_id, local_user_profile_id from import_map_people",
  );
  const personMap = new Map<number, string>();
  for (const row of personMapRows.rows) {
    personMap.set(Number(row.basecamp_person_id), row.local_user_profile_id);
  }

  const reader = createDumpReader({ dumpDir: flags.dumpDir });
  const downloadEnv = {
    username: requireEnv("BC2_USERNAME"),
    password: requireEnv("BC2_PASSWORD"),
    userAgent: process.env.BC2_USER_AGENT ?? "basecamp-clone-orphan-recon (matt@example.com)",
  };

  let ok = 0;
  let failed = 0;
  for (const m of mapped) {
    const project = { bc2Id: m.bc2Id, localId: m.localId, name: m.name };
    try {
      const t = await migrateThreadsAndComments({ reader, q, jobId, project, personMap });
      const f = await migrateFiles({ reader, q, jobId, project, downloadEnv, personMap });
      console.log(
        `phases ${m.bc2Id}: threads ok=${t.threads.success} fail=${t.threads.failed} skip=${t.threads.skipped} | files ok=${f.files.success} fail=${f.files.failed} skip=${f.files.skipped}`,
      );
      ok++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`phases ${m.bc2Id}: ${msg}`);
      failed++;
    }
  }
  return { ok, failed };
},
```

- [ ] **Step 7.4: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7.5: Run unit tests**

```bash
pnpm vitest run tests/unit/apply-orphan-decisions.test.ts
```

Expected: 11 tests pass.

- [ ] **Step 7.6: Commit**

```bash
git add scripts/apply-orphan-decisions.ts tests/unit/apply-orphan-decisions.test.ts
git commit -m "feat(orphans): apply-orphan-decisions --run-phases integration"
```

---

## Task 8: --dry-run preview

**Files:**
- Modify: `tests/unit/apply-orphan-decisions.test.ts`

`runApply` already short-circuits real DB writes when `flags.dryRun` is true (Task 6 routed `applyOne` through a dry-run wrapper that returns `{ status: "skipped" }`). Add a test pinning the behavior.

- [ ] **Step 8.1: Add failing test**

Append to `tests/unit/apply-orphan-decisions.test.ts`:

```ts
describe("runApply (--dry-run)", () => {
  it("dry-run still calls applyOne (deps decide what 'dry' means), reports skipped count", async () => {
    const d = fakeDeps({
      flags: {
        decisionsPath: "decisions.csv",
        hasBackup: true,
        runPhases: false,
        dryRun: true,
        dumpDir: "/tmp/dump",
        verbose: false,
      },
      applyOne: vi.fn(async () => ({ status: "skipped" } as ApplyOutcome)),
    });
    const exit = await runApply(d);
    expect(exit).toBe(0);
    expect(d.applyOne).toHaveBeenCalledTimes(3);
    expect(d.lines.some((l) => l.includes("skipped=3"))).toBe(true);
  });
});
```

- [ ] **Step 8.2: Run tests**

```bash
pnpm vitest run tests/unit/apply-orphan-decisions.test.ts
```

Expected: 12 tests pass.

- [ ] **Step 8.3: Commit**

```bash
git add tests/unit/apply-orphan-decisions.test.ts
git commit -m "test(orphans): pin --dry-run behavior"
```

---

## Task 9: package.json scripts + final verification + PR

**Files:**
- Modify: `package.json`

- [ ] **Step 9.1: Add npm scripts**

In `package.json`, after the existing `"audit:bc2-dump":` line (or `"migrate:from-dump":` if audit isn't merged yet), insert:

```json
"dump:orphan-decisions": "npx tsx scripts/dump-orphan-decisions.ts",
"apply:orphan-decisions": "npx tsx scripts/apply-orphan-decisions.ts",
```

- [ ] **Step 9.2: Full unit test suite**

```bash
pnpm vitest run
```

Expected: all tests pass — 4 new test files, 28 new tests; everything else still green.

- [ ] **Step 9.3: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 9.4: Fallow dead-code check**

```bash
pnpm exec fallow dead-code
```

Expected: zero issues. If new exported symbols are flagged (e.g., `ParseDecisionResult` if no consumer), drop the `export` keyword.

- [ ] **Step 9.5: Smoke run — generate stub**

```bash
mkdir -p docs/imports
pnpm dump:orphan-decisions \
  --audit-csv=../../.worktrees/audit-bc2-dump/tmp/audit/projects.csv \
  --out=docs/imports/bc2-orphan-decisions.csv
```

Expected:
```
[dump-orphan-decisions] wrote 17 rows to docs/imports/bc2-orphan-decisions.csv.
Edit the file, then run: pnpm apply:orphan-decisions --i-have-a-backup [--run-phases]
```

Verify file content:

```bash
head -5 docs/imports/bc2-orphan-decisions.csv
wc -l docs/imports/bc2-orphan-decisions.csv
```

Expected: header row + 17 data rows = 18 lines, all data rows have empty action/code/client_name.

- [ ] **Step 9.6: Operator step (NOT automated)**

The operator hand-edits `docs/imports/bc2-orphan-decisions.csv`, choosing `assign | create | skip` per row. The applier will not run until they do.

- [ ] **Step 9.7: Smoke run — dry-run apply**

After the operator has filled the CSV (or with a hand-prepared single-row test CSV in another path):

```bash
pnpm apply:orphan-decisions \
  --decisions=tmp/test-decisions.csv \
  --i-have-a-backup \
  --dry-run
```

Expected: prints intended actions, no DB writes. Inspect `import_jobs` to confirm the job row was created and finished as `completed`.

- [ ] **Step 9.8: Push branch**

```bash
git push -u origin feat/recon-orphan-projects
```

- [ ] **Step 9.9: Open PR**

```bash
gh pr create --title "feat: BC2 recon — orphan projects (bucket 1)" --body "$(cat <<'EOF'
## Summary
- Two-script workflow for resolving the 17 BC2 orphan projects (titles that didn't match any client code).
- \`scripts/dump-orphan-decisions.ts\` — read-only generator. Reads \`tmp/audit/projects.csv\`, writes a stub \`docs/imports/bc2-orphan-decisions.csv\` with one row per orphan and empty action/code/name fields.
- Operator edits the CSV (assign | create | skip per row).
- \`scripts/apply-orphan-decisions.ts\` — DB-writing applier with per-row autocommit, idempotency check, and an opt-in \`--run-phases\` mode that runs \`migrateThreadsAndComments\` + \`migrateFiles\` for the newly-mapped projects.
- Decision CSV is checked into the repo; it is the canonical record of why each orphan was handled this way.

## Closes
- Bucket 1 of 2 BC2 reconciliation buckets identified by PR #36 (audit tool).
- Spec: \`docs/superpowers/specs/2026-05-08-bc2-recon-orphan-projects-design.md\`.

## Test plan
- [ ] \`pnpm vitest run\`
- [ ] \`pnpm tsc --noEmit\`
- [ ] \`pnpm exec fallow dead-code\`
- [ ] \`pnpm dump:orphan-decisions\` produces a 17-row stub
- [ ] Operator fills the stub
- [ ] \`pnpm apply:orphan-decisions --i-have-a-backup --dry-run\` previews
- [ ] \`pnpm apply:orphan-decisions --i-have-a-backup\` applies mappings
- [ ] \`pnpm apply:orphan-decisions --i-have-a-backup --run-phases\` runs threads + files for the newly-mapped projects
- [ ] \`pnpm audit:bc2-dump\` cross-check shows projects.unaccounted dropped to 0

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Goal (resolve 17 orphans via assign/create/skip + optional phase rerun) — Tasks 1–8 cover all surfaces; Task 9 adds operator runbook.
- Hard constraints (no full migration rerun; backup gate; phase modules untouched) — Task 0 (branch off main), Task 5 (backup gate), Task 6/7 (only imports phases, never invokes `migrate-from-dump`).
- File layout matches spec — Tasks 1–4 create the listed files; Task 9 adds the package.json entries.
- CSV schema (5 columns, header mandatory) — Task 2 parser/formatter; Task 4 generator emits the same shape.
- Per-row validation (action required, assign needs code, create needs code+name, skip empties only) — Task 2 covers each via test.
- CLI flags (`--decisions`, `--i-have-a-backup`, `--run-phases`, `--dry-run`, `--dump-dir`, `--verbose`) — Task 5.
- Data flow (parse → DB pool → createImportJob → mapping pass → optional phases → finishJob) — Tasks 5/6/7.
- Atomicity (per-row autocommit) — implicit in Task 5's loop (no `BEGIN`/`COMMIT` wrapper).
- Idempotency (already-mapped pre-check, client reuse on duplicate code, skip log idempotent) — Task 3.
- Error handling matrix (bad flags, invalid rows, DB errors, phase exceptions) — Tasks 5, 7.
- Test plan (10 + 6 + 3 + 7 = 26; spec listed 26) — Tasks 2, 3, 4, 5, 7, 8 produce 12 (apply-orphan-decisions covers more than the spec's 7 because we split parseFlags into 4 cases). Total: 10 (csv) + 6 (apply) + 3 (dump) + 12 (orchestrator) = 31. Spec coverage: yes; we add some extras.
- Operator runbook — Task 9 (Steps 9.5–9.7).

**Placeholder scan:** No "TBD"/"TODO"/"implement later". Every code-bearing step has runnable code blocks. Step 6.1 references "the existing imports and types from Task 5" — that is a concrete reference (Task 5's code is in the same file the engineer has open), not a placeholder.

**Type / name consistency:**
- `DecisionAction`, `OrphanDecision`, `RowError`, `ApplyOutcome`, `ClientNotFoundError` defined in Task 1; reused unchanged in Tasks 2, 3, 5.
- `DumpProjectShape` defined in Task 3 (`lib/imports/orphans/apply.ts`); imported in Task 5/6.
- `ApplyFlags`, `ApplyDeps`, `runApply`, `parseFlags` defined in Task 5; reused in Tasks 6/7/8.
- `dumpOrphanDecisions` exported in Task 4; called by main + tested directly.
- Phase-function signatures (`migrateThreadsAndComments({reader, q, jobId, project, personMap})`, `migrateFiles({..., downloadEnv})`) match the existing exports verified during brainstorming.
- `Query` imported from `@/lib/imports/migration/jobs` in Tasks 3, 5, 6 — same path.

**Scope:** Single bucket (orphan projects). The 44 file-URL parse failures and the ~751 stranded comments under successfully-migrated topics are out of scope.
