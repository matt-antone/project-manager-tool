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
