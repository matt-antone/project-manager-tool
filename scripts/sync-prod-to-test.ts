// scripts/sync-prod-to-test.ts
import { config } from "dotenv";
import { resolve } from "path";
import { promises as fs } from "node:fs";
import * as path from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { assertEnvSafe } from "@/lib/sync/prod-to-test/safety";
import { runBackup } from "@/lib/sync/prod-to-test/backup";
import { buildContext } from "@/lib/sync/prod-to-test/context";
import { saveWatermark, ENTITY_NAMES, type EntityName } from "@/lib/sync/prod-to-test/watermarks";
import { runClientsPhase, runClientsPhaseRefresh } from "@/lib/sync/prod-to-test/phases/clients";
import { runUsersPhase, runUsersPhaseRefresh } from "@/lib/sync/prod-to-test/phases/users";
import { runProjectsPhase, runProjectsPhaseRefresh } from "@/lib/sync/prod-to-test/phases/projects";
import { runThreadsPhase, runThreadsPhaseRefresh } from "@/lib/sync/prod-to-test/phases/threads";
import { runCommentsPhase } from "@/lib/sync/prod-to-test/phases/comments";
import { runFilesPhase, runFilesPhaseRefresh } from "@/lib/sync/prod-to-test/phases/files";
import type { CliFlags, PhaseResult, RunPhase } from "@/lib/sync/prod-to-test/phases/types";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    process.stderr.write(`Missing required env var: ${name}\n`);
    process.exit(1);
  }
  return v;
}

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = {
    phase: null,
    limitPerPhase: null,
    noBackup: false,
    iKnowWhatImDoing: false,
  };
  for (const a of argv) {
    if (a.startsWith("--phase=")) {
      const v = a.slice("--phase=".length) as EntityName;
      if (!(ENTITY_NAMES as readonly string[]).includes(v)) {
        process.stderr.write(`Unknown phase: ${v}\n`);
        process.exit(1);
      }
      out.phase = v;
    } else if (a.startsWith("--limit-per-phase=")) {
      const n = parseInt(a.slice("--limit-per-phase=".length), 10);
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write(`Invalid --limit-per-phase value\n`);
        process.exit(1);
      }
      out.limitPerPhase = n;
    } else if (a === "--no-backup") {
      out.noBackup = true;
    } else if (a === "--i-know-what-im-doing") {
      out.iKnowWhatImDoing = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      process.stderr.write(`Unknown flag: ${a}\n`);
      process.exit(1);
    }
  }
  if (out.noBackup && !out.iKnowWhatImDoing) {
    process.stderr.write("--no-backup requires --i-know-what-im-doing\n");
    process.exit(1);
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(
    `Usage: pnpm sync:prod-to-test [flags]\n` +
      `  --phase=<name>          run only one phase (${ENTITY_NAMES.join("|")})\n` +
      `  --limit-per-phase=<n>   cap rows scanned per phase\n` +
      `  --no-backup             skip pg_dump (requires --i-know-what-im-doing)\n` +
      `  --i-know-what-im-doing  acknowledge no-backup risk\n` +
      `\nMetadata refresh runs unconditionally after insert phase.\n`
  );
}

const PHASES: Record<EntityName, RunPhase> = {
  clients: runClientsPhase,
  users: runUsersPhase,
  projects: runProjectsPhase,
  threads: runThreadsPhase,
  comments: runCommentsPhase,
  files: runFilesPhase,
};

// Comments intentionally excluded — body fields not edited often; edited_at captured at insert.
const REFRESH_PHASES: Partial<Record<EntityName, RunPhase>> = {
  clients: runClientsPhaseRefresh,
  users: runUsersPhaseRefresh,
  projects: runProjectsPhaseRefresh,
  threads: runThreadsPhaseRefresh,
  files: runFilesPhaseRefresh,
};

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const log = (m: string) => process.stdout.write(m + "\n");

  const prodUrl = requireEnv("PROD_DATABASE_URL");
  const testUrl = requireEnv("DATABASE_URL");
  assertEnvSafe({
    prodUrl,
    testUrl,
    prodHostHint: process.env.PROD_HOST_HINT,
  });

  if (!flags.noBackup) {
    await runBackup({ databaseUrl: testUrl, backupDir: "backups", log });
  } else {
    log("[backup] SKIPPED (--no-backup --i-know-what-im-doing)");
  }

  const ctx = await buildContext({
    prodUrl,
    testUrl,
    prodSupabaseUrl: requireEnv("PROD_SUPABASE_URL"),
    prodServiceRoleKey: requireEnv("PROD_SUPABASE_SERVICE_ROLE_KEY"),
    testSupabaseUrl: requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    testServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    flags,
    log,
  });

  const order: EntityName[] = flags.phase ? [flags.phase] : [...ENTITY_NAMES];
  const results: PhaseResult[] = [];
  let exitCode = 0;
  try {
    for (const name of order) {
      const result = await PHASES[name](ctx);
      results.push(result);
      if (result.failed === 0 && result.newWatermark.getTime() > 0) {
        await saveWatermark(ctx.test, name, result.newWatermark);
      } else if (result.failed > 0) {
        log(`[${name}] watermark HELD (failed=${result.failed})`);
        exitCode = 1;
      }
    }

    for (const name of order) {
      const refreshFn = REFRESH_PHASES[name];
      if (!refreshFn) {
        log(`[${name}:refresh] skipped (no refresh defined for this phase)`);
        continue;
      }
      const result = await refreshFn(ctx);
      results.push(result);
      if (result.failed > 0) {
        log(`[${name}:refresh] ${result.failed} row(s) failed`);
        exitCode = 1;
      }
    }
  } finally {
    const outDir = "tmp/sync-prod";
    await fs.mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(outDir, `run-${stamp}.json`);
    await fs.writeFile(outPath, JSON.stringify(results, null, 2));
    log(`[summary] wrote ${outPath}`);
    await ctx.prod.end().catch(() => {});
    await ctx.test.end().catch(() => {});
  }
  process.exit(exitCode);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).stack ?? (e as Error).message}\n`);
  process.exit(1);
});
