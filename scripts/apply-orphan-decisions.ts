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
import { createDumpReader } from "@/lib/imports/dump-reader";
import { Bc2Client } from "@/lib/imports/bc2-client";
import { migrateThreadsAndComments } from "@/lib/imports/migration/threads";
import { migrateFiles } from "@/lib/imports/migration/files";

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

// Single dump-only client stub. Throws if anything ever tries the API
// fallback — we expect the dump to be self-contained for orphan recon.
const DUMP_ONLY_CLIENT = {
  get: async () => {
    throw new Error("apply-orphan-decisions: API fallback not supported");
  },
} as unknown as Bc2Client;

async function readDumpProjects(dumpDir: string): Promise<Map<string, DumpProjectShape>> {
  const reader = createDumpReader({ dumpDir, client: DUMP_ONLY_CLIENT, errors: new Set() });
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
      runPhasesForProjects: async ({ jobId, mapped }) => {
        if (mapped.length === 0) return { ok: 0, failed: 0 };

        const personMapRows = await q<{ basecamp_person_id: string; local_user_profile_id: string }>(
          "select basecamp_person_id, local_user_profile_id from import_map_people",
        );
        const personMap = new Map<number, string>();
        for (const row of personMapRows.rows) {
          personMap.set(Number(row.basecamp_person_id), row.local_user_profile_id);
        }

        const reader = createDumpReader({
          dumpDir: flags.dumpDir,
          client: DUMP_ONLY_CLIENT,
          errors: new Set(),
        });
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
            // Treat any internal phase failure as a project-level failure so
            // the exit code reflects unfinished work, not just thrown errors.
            if (t.threads.failed > 0 || f.files.failed > 0) {
              failed++;
            } else {
              ok++;
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`phases ${m.bc2Id}: ${msg}`);
            failed++;
          }
        }
        return { ok, failed };
      },
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
