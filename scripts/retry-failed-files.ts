import { promises as fs } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { config } from "dotenv";
import { parseCsvLine, splitCsvRows } from "@/lib/imports/orphans/csv";
import { Pool } from "pg";
import { createDumpReader } from "@/lib/imports/dump-reader";
import { Bc2Client } from "@/lib/imports/bc2-client";
import { importBc2FileFromAttachment } from "@/lib/imports/bc2-migrate-single-file";
import { resolveBc2AttachmentLinkage } from "@/lib/imports/bc2-attachment-linkage";
import { createImportJob, finishJob, type Query } from "@/lib/imports/migration/jobs";
import { DropboxStorageAdapter } from "@/lib/storage/dropbox-adapter";
import { createFileMetadata } from "@/lib/repositories";

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

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const DUMP_ONLY_CLIENT = {
  get: async () => {
    throw new Error("retry-failed-files: API fallback not supported");
  },
} as unknown as Bc2Client;

async function noopLogRecord(): Promise<void> {
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

const isEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  main().catch((err) => {
    console.error(`[retry-failed-files] fatal: ${err.message ?? err}`);
    process.exit(1);
  });
}
