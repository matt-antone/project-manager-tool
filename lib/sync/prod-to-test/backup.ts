import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

class BackupError extends Error {}

export function toPoolerUrl(databaseUrl: string): string {
  return databaseUrl.replace(/:6543\b/, ":5432");
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

export function buildBackupPath(dir: string, now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const HH = pad(now.getUTCHours());
  const MM = pad(now.getUTCMinutes());
  const SS = pad(now.getUTCSeconds());
  return path.posix.join(dir, `sync-prod-${yyyy}${mm}${dd}-${HH}${MM}${SS}.dump`);
}

export interface RunBackupOptions {
  databaseUrl: string;
  backupDir: string;
  now?: Date;
  log?: (msg: string) => void;
}

export interface BackupResult {
  path: string;
  bytes: number;
}

export async function runBackup(opts: RunBackupOptions): Promise<BackupResult> {
  const log = opts.log ?? ((m: string) => process.stdout.write(m + "\n"));
  await fs.mkdir(opts.backupDir, { recursive: true });
  const outPath = buildBackupPath(opts.backupDir, opts.now);
  const pgUrl = toPoolerUrl(opts.databaseUrl);

  log(`[backup] running pg_dump → ${outPath}`);
  await new Promise<void>((resolveP, rejectP) => {
    const child = spawn("pg_dump", ["-F", "c", "-d", pgUrl, "-f", outPath], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", (e) =>
      rejectP(new BackupError(`pg_dump failed to start: ${e.message}`))
    );
    child.on("exit", (code) => {
      if (code === 0) resolveP();
      else rejectP(new BackupError(`pg_dump exited with code ${code}`));
    });
  });

  const stat = await fs.stat(outPath).catch(() => null);
  if (!stat || stat.size === 0) {
    throw new BackupError(`pg_dump output missing or empty: ${outPath}`);
  }
  log(`[backup] wrote ${stat.size} bytes`);
  return { path: outPath, bytes: stat.size };
}
