import { resolve } from "path";
import { pathToFileURL } from "url";
import { config } from "dotenv";
import { Pool } from "pg";
import { createImportJob, finishJob, type Query } from "@/lib/imports/migration/jobs";
import { createComment } from "@/lib/repositories";
import { reconStrandedComments } from "@/lib/imports/migration/stranded-comments";
import { promises as fs } from "fs";

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
    const peopleRes = await q<{ basecamp_person_id: string; local_user_profile_id: string }>(
      "select basecamp_person_id, local_user_profile_id from import_map_people",
    );
    const personMap = new Map<number, string>(
      peopleRes.rows.map((r) => [Number(r.basecamp_person_id), r.local_user_profile_id]),
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
      createComment: async (args) => {
        const row = await createComment(args);
        return row as { id: string };
      },
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

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
