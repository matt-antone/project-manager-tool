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
