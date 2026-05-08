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
import { createDumpReader, type DumpReader } from "@/lib/imports/dump-reader";
import { Bc2Client } from "@/lib/imports/bc2-client";

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
    try {
      await deps.finishJob(jobId, "failed");
    } catch {
      // Don't mask the original error if finishJob also fails.
    }
    throw e;
  }

  return exitCode;
}

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
  // Stub client for dump-only reading (no API fallback).
  const stubClient = {
    get: async () => {
      throw new Error("apply-orphan-decisions: API fallback not supported");
    },
  } as unknown as Bc2Client;

  const reader = createDumpReader({ dumpDir, client: stubClient, errors: new Set() });
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

if (require.main === module) {
  main().catch((err) => {
    console.error(`[apply-orphan-decisions] fatal: ${err.message ?? err}`);
    process.exit(1);
  });
}
