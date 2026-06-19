import { requireUser } from "@/lib/auth";
import { badRequest, notFound, ok, serverError, unauthorized } from "@/lib/http";
import { PROJECT_STATUSES_ZOD, projectStatusTransitionError, resolveProjectStatus } from "@/lib/project-status";
import { getProject, setProjectStatus } from "@/lib/repositories";
import { z } from "zod";

const setProjectStatusSchema = z.object({
  status: z.enum(PROJECT_STATUSES_ZOD)
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const payload = setProjectStatusSchema.parse(await request.json());
    const project = await getProject(id, user.id);
    if (!project) {
      return notFound("Project not found");
    }

    const currentStatus = resolveProjectStatus(project.status);
    const transitionError = projectStatusTransitionError(currentStatus, payload.status, project.archived === true);
    if (transitionError) {
      return badRequest(transitionError);
    }

    const updatedProject = await setProjectStatus(id, payload.status);
    if (!updatedProject) {
      return notFound("Project not found");
    }
    return ok({ project: updatedProject });
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    if (error instanceof z.ZodError) {
      return badRequest(error.message);
    }
    return serverError();
  }
}
