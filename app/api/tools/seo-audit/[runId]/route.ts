import { requireUser } from "@/lib/auth";
import { notFound, ok, serverError, unauthorized } from "@/lib/http";
import {
  getSeoAuditRunForUser,
  reapStaleSeoAuditRuns,
  STALE_SEO_AUDIT_RUN_MINUTES
} from "@/lib/seo-audit-repository";
import { z } from "zod";

const runIdSchema = z.string().uuid();

const STALE_RUN_MS = STALE_SEO_AUDIT_RUN_MINUTES * 60_000;

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  let runId: string | undefined;
  try {
    const user = await requireUser(request);
    const { runId: rawRunId } = await params;
    const parsedRunId = runIdSchema.safeParse(rawRunId);
    if (!parsedRunId.success) {
      return notFound("SEO audit run not found");
    }
    runId = parsedRunId.data;

    let run = await getSeoAuditRunForUser(runId, user.id);
    if (!run) {
      return notFound("SEO audit run not found");
    }

    // This is the polling endpoint, so avoid sweeping every stale row on
    // every 3s poll. Only pay for a reap when the run being polled is
    // itself non-terminal and old enough to be orphaned (e.g. the function
    // that was supposed to run it was killed by Netlify's 60s cap) — then
    // refetch so the client immediately sees the resulting 'failed' status
    // instead of polling a dead run forever.
    if (run.status === "queued" || run.status === "running") {
      const ageMs = Date.now() - new Date(run.createdAt).getTime();
      if (ageMs > STALE_RUN_MS) {
        await reapStaleSeoAuditRuns(STALE_SEO_AUDIT_RUN_MINUTES);
        run = (await getSeoAuditRunForUser(runId, user.id)) ?? run;
      }
    }

    return ok({ run });
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    console.error("seo_audit_status_failed", {
      runId,
      error: error instanceof Error ? error.message : String(error)
    });
    return serverError();
  }
}
