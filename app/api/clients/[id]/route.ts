import { requireUser } from "@/lib/auth";
import { badRequest, notFound, ok, serverError, unauthorized } from "@/lib/http";
import { getClientById, getClientWithStats, updateClient } from "@/lib/repositories";
import { z } from "zod";

const clientStringListSchema = z.array(z.string().trim().min(1));

const patchClientSchema = z.object({
  name: z.string().min(1),
  github_repos: clientStringListSchema.optional(),
  domains: clientStringListSchema.optional()
});

function pickErrorField(error: unknown, key: string) {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  let clientId = "unknown";
  let actorUserId: string | null = null;

  try {
    const user = await requireUser(request);
    actorUserId = user.id;

    const { id } = await params;
    clientId = id;

    const payload = patchClientSchema.parse(await request.json());
    const client = await updateClient(id, {
      name: payload.name,
      githubRepos: payload.github_repos,
      domains: payload.domains
    });
    if (!client) {
      return notFound("Client not found");
    }
    return ok({ client });
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    if (error instanceof z.ZodError) {
      return badRequest(error.message);
    }
    if (error instanceof SyntaxError) {
      return badRequest("Invalid JSON body");
    }

    console.error("client_patch_failed", {
      requestId,
      route: "PATCH /clients/:id",
      clientId,
      actorUserId,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      pgCode: pickErrorField(error, "code"),
      pgDetail: pickErrorField(error, "detail"),
      pgHint: pickErrorField(error, "hint"),
      pgWhere: pickErrorField(error, "where"),
      pgTable: pickErrorField(error, "table"),
      pgColumn: pickErrorField(error, "column"),
      pgConstraint: pickErrorField(error, "constraint")
    });

    return serverError(`Internal server error (ref: ${requestId})`);
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser(request);
    const { id } = await params;
    const url = new URL(request.url);
    if (url.searchParams.get("stats") === "1") {
      const result = await getClientWithStats(id);
      if (!result) return notFound("Client not found");
      return ok(result);
    }
    const client = await getClientById(id);
    if (!client) return notFound("Client not found");
    return ok({ client });
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    return serverError();
  }
}
