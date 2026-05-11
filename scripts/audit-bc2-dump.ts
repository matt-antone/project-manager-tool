// scripts/audit-bc2-dump.ts
import { config } from "dotenv";
import { resolve } from "path";
import { Pool } from "pg";
import {
  readPeople,
  readProjects,
  readTopicsForProject,
  readCommentsForTopic,
  readAttachmentsForProject,
  listProjectIds,
} from "../lib/imports/audit/reader";
import { classifyEntity, loadDbState, type Query } from "../lib/imports/audit/diff";
import { ensureOutDir, openCsv } from "../lib/imports/audit/csv-writer";
import type {
  EntityKind,
  SummaryByEntity,
  SummaryCounts,
} from "../lib/imports/audit/types";

config({ path: resolve(process.cwd(), ".env.local") });

interface CliFlags {
  dumpDir: string;
  outDir: string;
  verbose: boolean;
}

function parseFlags(): CliFlags {
  const args = process.argv.slice(2);
  const flags: CliFlags = {
    dumpDir: process.env.BASECAMP_DUMP_DIR ?? "/Volumes/Spare/basecamp-dump",
    outDir: "tmp/audit",
    verbose: false,
  };
  for (const a of args) {
    if (a.startsWith("--dump-dir=")) flags.dumpDir = a.slice("--dump-dir=".length);
    else if (a.startsWith("--out-dir=")) flags.outDir = a.slice("--out-dir=".length);
    else if (a === "--verbose") flags.verbose = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return flags;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function emptySummary(): SummaryByEntity {
  const fresh = (): SummaryCounts => ({
    expected: 0,
    mapped: 0,
    accountedSkip: 0,
    accountedFail: 0,
    unaccounted: 0,
  });
  return {
    people: fresh(),
    projects: fresh(),
    topics: fresh(),
    comments: fresh(),
    files: fresh(),
  };
}

function bumpSummary(summary: SummaryByEntity, kind: EntityKind, status: string): void {
  const c = summary[kind];
  c.expected++;
  switch (status) {
    case "mapped":
      c.mapped++;
      break;
    case "skipped_unsupported":
    case "skipped_existing":
      c.accountedSkip++;
      break;
    case "failed":
      c.accountedFail++;
      break;
    case "missing":
      c.unaccounted++;
      break;
  }
}

async function main(): Promise<void> {
  const flags = parseFlags();
  console.log(
    `[audit-bc2-dump] dumpDir=${flags.dumpDir} outDir=${flags.outDir}`,
  );

  await ensureOutDir(flags.outDir);

  const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });
  pool.on("error", (err) => {
    console.warn(`[audit-bc2-dump] pool client error (non-fatal): ${err.message}`);
  });
  const q: Query = (async <T>(text: string, values?: unknown[]) => {
    const r = await pool.query(text, values);
    return { rows: r.rows as T[] };
  }) as Query;

  try {
    console.log("[audit-bc2-dump] loading DB state...");
    const state = await loadDbState(q);
    console.log(
      `[audit-bc2-dump] db: people=${state.peopleMap.size} projects=${state.projectsMap.size} ` +
      `threads=${state.threadsMap.size} comments=${state.commentsMap.size} ` +
      `files=${state.filesMap.size} logs=${state.logs.size}`,
    );

    const summary = emptySummary();

    // people
    const peopleCsv = await openCsv(flags.outDir, "people.csv", [
      "bc2_id", "email", "name", "status", "local_user_profile_id", "reason",
    ]);
    for (const p of await readPeople(flags.dumpDir)) {
      const c = classifyEntity({ kind: "people", bc2Id: String(p.bc2Id), state });
      bumpSummary(summary, "people", c.status);
      peopleCsv.writeRow([p.bc2Id, p.email, p.name, c.status, c.localId, c.reason]);
    }
    await peopleCsv.close();

    // projects
    const projectsCsv = await openCsv(flags.outDir, "projects.csv", [
      "bc2_id", "name", "archived", "status", "local_project_id", "reason",
    ]);
    const projects = await readProjects(flags.dumpDir);
    for (const p of projects) {
      const c = classifyEntity({ kind: "projects", bc2Id: String(p.bc2Id), state });
      bumpSummary(summary, "projects", c.status);
      projectsCsv.writeRow([p.bc2Id, p.name, p.archived, c.status, c.localId, c.reason]);
    }
    await projectsCsv.close();

    // topics + comments + files (per project)
    const topicsCsv = await openCsv(flags.outDir, "topics.csv", [
      "bc2_project_id", "bc2_topic_id", "topicable_type", "title", "status", "local_thread_id", "reason",
    ]);
    const commentsCsv = await openCsv(flags.outDir, "comments.csv", [
      "bc2_project_id", "bc2_topic_id", "bc2_comment_id", "status", "local_comment_id", "reason",
    ]);
    const filesCsv = await openCsv(flags.outDir, "files.csv", [
      "bc2_project_id", "bc2_attachment_id", "filename", "byte_size", "status", "local_file_id", "reason",
    ]);

    const projectIds = await listProjectIds(flags.dumpDir);
    const total = projectIds.length;
    let pIdx = 0;
    const startMs = Date.now();

    for (const projectId of projectIds) {
      pIdx++;
      if (flags.verbose || pIdx % 100 === 0) {
        const elapsed = Math.round((Date.now() - startMs) / 1000);
        console.log(`[audit-bc2-dump] project ${pIdx}/${total} (${elapsed}s)`);
      }

      const topics = await readTopicsForProject(flags.dumpDir, projectId);
      for (const t of topics) {
        const c = classifyEntity({ kind: "topics", bc2Id: String(t.bc2TopicId), state });
        bumpSummary(summary, "topics", c.status);
        topicsCsv.writeRow([
          t.bc2ProjectId, t.bc2TopicId, t.topicableType, t.title, c.status, c.localId, c.reason,
        ]);

        const comments = await readCommentsForTopic(
          flags.dumpDir, t.bc2ProjectId, t.topicableType, t.bc2TopicId,
        );
        for (const com of comments) {
          const cc = classifyEntity({ kind: "comments", bc2Id: String(com.bc2CommentId), state });
          bumpSummary(summary, "comments", cc.status);
          commentsCsv.writeRow([
            com.bc2ProjectId, com.bc2TopicId, com.bc2CommentId, cc.status, cc.localId, cc.reason,
          ]);
        }
      }

      const attachments = await readAttachmentsForProject(flags.dumpDir, projectId);
      for (const a of attachments) {
        const c = classifyEntity({ kind: "files", bc2Id: String(a.bc2AttachmentId), state });
        bumpSummary(summary, "files", c.status);
        filesCsv.writeRow([
          a.bc2ProjectId, a.bc2AttachmentId, a.filename, a.byteSize ?? "", c.status, c.localId, c.reason,
        ]);
      }
    }

    await topicsCsv.close();
    await commentsCsv.close();
    await filesCsv.close();

    // summary
    const summaryCsv = await openCsv(flags.outDir, "summary.csv", [
      "entity", "expected", "mapped", "accounted_skip", "accounted_fail", "unaccounted",
    ]);
    const order: EntityKind[] = ["people", "projects", "topics", "comments", "files"];
    for (const kind of order) {
      const c = summary[kind];
      summaryCsv.writeRow([kind, c.expected, c.mapped, c.accountedSkip, c.accountedFail, c.unaccounted]);
    }
    await summaryCsv.close();

    console.log("[audit-bc2-dump] done.");
    for (const kind of order) {
      const c = summary[kind];
      console.log(
        `  ${kind.padEnd(9)} expected=${c.expected} mapped=${c.mapped} ` +
        `skip=${c.accountedSkip} fail=${c.accountedFail} unaccounted=${c.unaccounted}`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[audit-bc2-dump] fatal:", err);
  process.exit(1);
});
