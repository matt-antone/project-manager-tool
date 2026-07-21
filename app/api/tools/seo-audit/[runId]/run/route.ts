import { requireUser } from "@/lib/auth";
import { conflict, notFound, ok, serverError, unauthorized } from "@/lib/http";
import {
  completeSeoAuditRun,
  failSeoAuditRun,
  getSeoAuditRunForUser,
  markSeoAuditRunRunning
} from "@/lib/seo-audit-repository";
import { z } from "zod";
import { runApiAudit } from "@matt-antone/seo-audit/src/audit-api.js";

const runIdSchema = z.string().uuid();

/**
 * Actually executes the audit for a previously-created 'queued' row. Split
 * out from `POST /api/tools/seo-audit` so that endpoint can return 202
 * immediately instead of holding the connection open for the whole audit —
 * see that route's comment for why (Netlify's 60s sync function cap).
 *
 * The client calls this right after creating the run and navigating to its
 * results page, then polls `GET /[runId]` for status. If this function is
 * itself killed mid-audit, the row is left 'running' and addressable by id,
 * so the reaper (called from the status route) can mark it failed instead
 * of the runId being lost entirely.
 */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  let runId: string | undefined;
  try {
    const user = await requireUser(request);
    const { runId: rawRunId } = await params;
    const parsedRunId = runIdSchema.safeParse(rawRunId);
    if (!parsedRunId.success) {
      return notFound("SEO audit run not found");
    }
    runId = parsedRunId.data;

    const run = await getSeoAuditRunForUser(runId, user.id);
    if (!run) {
      return notFound("SEO audit run not found");
    }
    if (run.status !== "queued") {
      return conflict("SEO audit run has already been started");
    }

    // Atomic queued -> running transition: if another request (e.g. a page
    // refresh that re-triggered the run call) already claimed this row, we
    // get null back here even though the check above passed, and we treat
    // that as "someone else is already running it" rather than starting a
    // second audit.
    const running = await markSeoAuditRunRunning(runId);
    if (!running) {
      return conflict("SEO audit run has already been started");
    }

    try {
      const result = await runApiAudit({ url: run.url, maxPages: run.maxPages });
      const completed = await completeSeoAuditRun(runId, result);
      return ok({ run: completed });
    } catch (auditError) {
      const message = auditError instanceof Error ? auditError.message : String(auditError);
      console.error("seo_audit_run_execute_failed", { runId, error: message });
      // The row must always land in a terminal state, even though the
      // audit itself threw — the client is polling this row for the outcome.
      const failed = await failSeoAuditRun(runId, message);
      return ok({ run: failed });
    }
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    console.error("seo_audit_run_start_failed", {
      runId,
      error: error instanceof Error ? error.message : String(error)
    });
    return serverError();
  }
}
