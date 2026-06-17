import { ok } from "@/lib/http";
import { retryFailedImport } from "@/lib/imports/basecamp2-import";
import { withUser } from "@/lib/with-user";

type RouteContext = { params: Promise<{ jobId: string }> };

export const POST = withUser<RouteContext>(null, async (_request, _user, { params }) => {
  const { jobId } = await params;
  const result = await retryFailedImport(jobId);
  return ok(result);
});
