import { requireUser } from "@/lib/auth";
import { badRequest, ok, serverError, unauthorized } from "@/lib/http";
import { listClientProjects } from "@/lib/repositories";
import { z } from "zod";

const filterSchema = z.enum(["active", "archived"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireUser(request);
    const { id } = await params;
    const url = new URL(request.url);
    const filter = filterSchema.parse(url.searchParams.get("filter"));
    const projects = await listClientProjects(id, filter);
    return ok({ projects });
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    if (error instanceof z.ZodError) {
      return badRequest("filter must be 'active' or 'archived'");
    }
    return serverError();
  }
}
