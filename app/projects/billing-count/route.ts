import { badRequest, ok } from "@/lib/http";
import { countBillingStageProjects } from "@/lib/billing-stage-count";
import { withUser } from "@/lib/with-user";
import { z } from "zod";

export const GET = withUser("projects_billing_count_failed", async (request) => {
  const url = new URL(request.url);

  const clientIdRaw = url.searchParams.get("clientId");
  const clientIdTrimmed = clientIdRaw?.trim() ?? "";
  let clientId: string | null = null;
  if (clientIdTrimmed.length > 0) {
    const parsed = z.string().uuid().safeParse(clientIdTrimmed);
    if (!parsed.success) {
      return badRequest("Invalid clientId");
    }
    clientId = parsed.data;
  }

  const search = (url.searchParams.get("search") ?? "").trim();
  const count = await countBillingStageProjects({
    clientId,
    search: search.length > 0 ? search : undefined
  });

  return ok({ count });
});
