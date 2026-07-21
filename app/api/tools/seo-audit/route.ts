import { requireUser } from "@/lib/auth";
import { badRequest, ok, serverError, unauthorized } from "@/lib/http";
import {
  createSeoAuditRun,
  listSeoAuditRunsForUser,
  reapStaleSeoAuditRuns,
  STALE_SEO_AUDIT_RUN_MINUTES
} from "@/lib/seo-audit-repository";
import { InvalidSeoAuditUrlError, normalizeSeoAuditUrl } from "@/lib/seo-audit-url";
import { withUser } from "@/lib/with-user";
import { z } from "zod";

/** Upstream hard-caps the crawl at 30 pages; enforce the same ceiling here. */
const MAX_PAGES_CAP = 30;
const DEFAULT_MAX_PAGES = 30;

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

const createSeoAuditRunSchema = z.object({
  url: z.string().min(1),
  maxPages: z.number().int().positive().max(MAX_PAGES_CAP).optional()
});

/**
 * Creates a queued run and returns immediately — it does NOT run the audit.
 * Netlify's 60s sync function cap means awaiting the audit here would risk
 * the container being killed before the client ever learns the runId,
 * stranding the row in 'running' with no way to reach it. The client
 * navigates to the run's page, which calls `POST /[runId]/run` to actually
 * start the audit and then polls `GET /[runId]` for status.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = createSeoAuditRunSchema.parse(await request.json());
    const url = normalizeSeoAuditUrl(payload.url);
    const maxPages = payload.maxPages ?? DEFAULT_MAX_PAGES;

    await reapStaleSeoAuditRuns(STALE_SEO_AUDIT_RUN_MINUTES);

    const run = await createSeoAuditRun({ url, maxPages, requestedBy: user.id });

    return ok({ runId: run.id }, 202);
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    if (error instanceof z.ZodError) {
      return badRequest(error.message);
    }
    if (error instanceof InvalidSeoAuditUrlError) {
      return badRequest(error.message);
    }
    if (error instanceof SyntaxError) {
      return badRequest("Invalid JSON payload");
    }
    console.error("seo_audit_create_failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return serverError();
  }
}

export const GET = withUser("seo_audit_list_failed", async (request, user) => {
  const url = new URL(request.url);
  const limitParam = Number(url.searchParams.get("limit"));
  const limit =
    Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;

  const runs = await listSeoAuditRunsForUser(user.id, limit);
  return ok({ runs });
});
