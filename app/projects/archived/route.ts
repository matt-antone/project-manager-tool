import { badRequest, ok } from "@/lib/http";
import { listArchivedProjectsPaginated } from "@/lib/repositories";
import { withUser } from "@/lib/with-user";
import { z } from "zod";

export const GET = withUser("archived_projects_fetch_failed", async (request) => {
  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? "";
  const status = url.searchParams.get("status") ?? "all";
  const page = parseInt(url.searchParams.get("page") ?? "1", 10);
  const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);

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

  const result = await listArchivedProjectsPaginated({ search, status, page, limit, clientId });
  return ok(result);
});
