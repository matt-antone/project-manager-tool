// lib/imports/sync-prod-to-test/sync-orchestrator.ts
import type { Pool } from "pg";
import type { ProjectOutcome, SyncRunContext } from "./types";
import { createProdReader } from "./prod-reader";
import { ensureClientInTest } from "./clients-resolver";
import { upsertProjectInTest } from "./project-writer";
import { writeThread } from "./thread-writer";
import { writeComment } from "./comment-writer";
import { writeFile } from "./file-writer";
import { createDatedCsv } from "./csv-writer";
import { startSyncJob } from "./sync-job";
import { enqueueThumbnailJobAndNotifyBestEffort } from "../../thumbnail-enqueue-after-save";

export interface OrchestratorDeps {
  prod: Pool; // read-only
  test: Pool;
}

interface PendingThumbnail {
  test_file_id: string;
  test_project_id: string;
  project_archived: boolean;
}

export async function runSync(deps: OrchestratorDeps, ctx: SyncRunContext): Promise<ProjectOutcome[]> {
  const reader = createProdReader(deps.prod);
  const job = await startSyncJob(ctx.runId);
  const outcomes: ProjectOutcome[] = [];

  const projects = await reader.projectsWithPostCutoffActivity(ctx.cutoff);
  await job.log("info",
    `discovered ${projects.length} prod projects with post-cutoff activity`,
    { cutoff: ctx.cutoff.toISOString() });

  for (const p of projects) {
    const outcome: ProjectOutcome = {
      prod_project_id: p.id, prod_project_code: p.project_code, prod_name: p.name,
      action: "skip", test_project_id: null, test_padded_twin_id: null,
      threads_inserted: 0, threads_skipped_existing: 0,
      comments_inserted: 0, comments_skipped_existing: 0,
      files_inserted: 0, files_skipped_existing: 0,
      files_copied_dropbox: 0, files_failed_dropbox: 0,
      errors: [],
    };

    const pendingThumbnails: PendingThumbnail[] = [];
    const tx = await deps.test.connect();
    let committed = false;

    try {
      await tx.query("BEGIN");
      if (!ctx.dryRun) await ensureClientInTest(tx, p.client_code, p.client_name);
      const upsert = await upsertProjectInTest(tx, p, deps.prod);
      outcome.test_project_id = upsert.test_project_id;
      outcome.action = upsert.action;
      outcome.test_padded_twin_id = upsert.archived_padded_twin_id;

      const threads = await reader.threadsPostCutoff(p.id, ctx.cutoff);
      const threadMap = new Map<string, string | null>();
      for (const t of threads) {
        const r = await writeThread(tx, upsert.test_project_id, t);
        threadMap.set(t.id, r.test_thread_id);
        if (r.result === "inserted") outcome.threads_inserted++;
        else outcome.threads_skipped_existing++;
      }

      const comments = await reader.commentsPostCutoff(p.id, ctx.cutoff);
      const commentMap = new Map<string, string | null>();
      for (const c of comments) {
        const r = await writeComment(tx, upsert.test_project_id, threadMap, c, deps.prod);
        commentMap.set(c.id, r.test_comment_id);
        if (r.result === "inserted") outcome.comments_inserted++;
        else if (r.result === "skipped_existing") outcome.comments_skipped_existing++;
        else if (r.result === "error_missing_thread") {
          outcome.errors.push(r.error ?? `comment ${c.id} missing thread`);
        }
      }

      const files = await reader.filesPostCutoff(p.id, ctx.cutoff);
      for (const f of files) {
        const r = await writeFile(tx, upsert.test_project_id, threadMap, commentMap, f, {
          dryRun: ctx.dryRun, skipFiles: ctx.skipFiles,
        }, deps.prod);
        if (r.result === "inserted") outcome.files_inserted++;
        else if (r.result === "skipped_existing" || r.result === "skipped_dry_run") outcome.files_skipped_existing++;
        else if (r.result === "failed_copy") {
          outcome.files_failed_dropbox++;
          outcome.errors.push(`file ${f.id} copy failed: ${r.copy?.errorMessage}`);
        }
        if (r.copy?.ok) outcome.files_copied_dropbox++;
        if (r.result === "inserted" && r.test_file_id) {
          pendingThumbnails.push({
            test_file_id: r.test_file_id,
            test_project_id: upsert.test_project_id,
            project_archived: p.archived,
          });
        }
      }

      if (ctx.dryRun) {
        await tx.query("ROLLBACK");
      } else {
        await tx.query("COMMIT");
        committed = true;
      }

      await job.log(outcome.errors.length ? "warn" : "info",
        `project ${p.project_code} done`, {
          action: outcome.action,
          test_project_id: outcome.test_project_id,
          threads_inserted: outcome.threads_inserted,
          comments_inserted: outcome.comments_inserted,
          files_inserted: outcome.files_inserted,
        });
    } catch (e) {
      try { await tx.query("ROLLBACK"); } catch { /* ignore */ }
      outcome.errors.push((e as Error).message);
      await job.log("error", `project ${p.project_code} failed`, { error: (e as Error).message });
    } finally {
      tx.release();
    }

    // Post-commit: enqueue thumbnail jobs (separate connection, sees committed rows).
    // enqueueThumbnailJobAndNotifyBestEffort only needs fileRecord.id; no DB fetch required.
    if (committed && pendingThumbnails.length > 0 && !ctx.dryRun) {
      for (const pt of pendingThumbnails) {
        try {
          await enqueueThumbnailJobAndNotifyBestEffort({
            projectId: pt.test_project_id,
            fileRecord: { id: pt.test_file_id },
            projectArchived: pt.project_archived,
          });
        } catch (e) {
          await job.log("warn", `thumbnail enqueue failed for file ${pt.test_file_id}`, {
            error: (e as Error).message,
          });
        }
      }
    }

    outcomes.push(outcome);
  }

  // CSV emit
  createDatedCsv(ctx.extractDir, "projects.csv",
    ["prod_project_code","prod_name","action","test_project_id","test_padded_twin_id",
     "threads_inserted","threads_skipped","comments_inserted","comments_skipped",
     "files_inserted","files_skipped","files_copied_dropbox","files_failed_dropbox","errors"],
    outcomes.map((o) => ({
      prod_project_code: o.prod_project_code, prod_name: o.prod_name, action: o.action,
      test_project_id: o.test_project_id, test_padded_twin_id: o.test_padded_twin_id,
      threads_inserted: o.threads_inserted, threads_skipped: o.threads_skipped_existing,
      comments_inserted: o.comments_inserted, comments_skipped: o.comments_skipped_existing,
      files_inserted: o.files_inserted, files_skipped: o.files_skipped_existing,
      files_copied_dropbox: o.files_copied_dropbox, files_failed_dropbox: o.files_failed_dropbox,
      errors: o.errors.join(" | "),
    })));

  await job.finalize("completed", {
    run_id: ctx.runId, cutoff: ctx.cutoff.toISOString(),
    projects: outcomes.length, dry_run: ctx.dryRun, extract_dir: ctx.extractDir,
  });
  return outcomes;
}
