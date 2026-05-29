import { requireUser } from "@/lib/auth";
import { badRequest, ok, serverError, unauthorized } from "@/lib/http";
import {
  createClient,
  listClients,
  listClientsWithStats,
  getClientTabCounts
} from "@/lib/repositories";
import { z } from "zod";

const clientStringListSchema = z.array(z.string().trim().min(1));

const createClientSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1).max(16).regex(/^[A-Za-z0-9_-]+$/),
  github_repos: clientStringListSchema.optional().default([]),
  domains: clientStringListSchema.optional().default([])
});

export async function GET(request: Request) {
  try {
    await requireUser(request);
    const url = new URL(request.url);
    if (url.searchParams.get("stats") === "1") {
      const [active, archived, counts] = await Promise.all([
        listClientsWithStats("active"),
        listClientsWithStats("archived"),
        getClientTabCounts()
      ]);
      return ok({ active, archived, counts });
    }
    const clients = await listClients();
    return ok({ clients });
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    return serverError();
  }
}

export async function POST(request: Request) {
  try {
    await requireUser(request);
    const payload = createClientSchema.parse(await request.json());
    const client = await createClient({
      name: payload.name,
      code: payload.code,
      githubRepos: payload.github_repos,
      domains: payload.domains
    });
    return ok({ client }, 201);
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    if (error instanceof z.ZodError) {
      return badRequest(error.message);
    }
    if (error instanceof Error && /duplicate key|unique/i.test(error.message)) {
      return badRequest("Client code already exists");
    }
    return serverError();
  }
}
