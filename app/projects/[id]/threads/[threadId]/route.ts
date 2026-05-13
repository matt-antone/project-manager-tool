import { requireUser } from "@/lib/auth";
import { badRequest, forbidden, notFound, ok, serverError, unauthorized } from "@/lib/http";
import { countNonAuthorComments, deleteThread, editThread, getProject, getThread } from "@/lib/repositories";
import { z, ZodError } from "zod";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; threadId: string }> }
) {
  try {
    await requireUser(request);
    const { id, threadId } = await params;
    const thread = await getThread(id, threadId);
    if (!thread) {
      return notFound("Thread not found");
    }
    return ok({ thread });
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    return serverError();
  }
}

const editThreadSchema = z.object({
  title: z.string().min(1),
  bodyMarkdown: z.string().min(1)
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; threadId: string }> }
) {
  try {
    const user = await requireUser(request);
    const { id, threadId } = await params;
    const project = await getProject(id);
    if (!project) return notFound("Project not found");
    const thread = await getThread(id, threadId);
    if (!thread) return notFound("Thread not found");
    const authorUserId = (thread as unknown as { author_user_id?: unknown }).author_user_id;
    if (typeof authorUserId !== "string" || authorUserId !== user.id) {
      return forbidden("Only the author can edit this discussion");
    }
    const payload = editThreadSchema.parse(await request.json());
    const updated = await editThread({ projectId: id, threadId, title: payload.title, bodyMarkdown: payload.bodyMarkdown });
    return ok({ thread: updated });
  } catch (error) {
    if (error instanceof ZodError) return badRequest("Invalid payload");
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    return serverError();
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; threadId: string }> }
) {
  try {
    const user = await requireUser(request);
    const { id, threadId } = await params;
    const project = await getProject(id);
    if (!project) return notFound("Project not found");
    const thread = await getThread(id, threadId);
    if (!thread) return notFound("Thread not found");
    const authorUserId = (thread as unknown as { author_user_id?: unknown }).author_user_id;
    if (typeof authorUserId !== "string" || authorUserId !== user.id) {
      return forbidden("Only the author can delete this discussion");
    }
    const otherComments = await countNonAuthorComments({ projectId: id, threadId, authorUserId });
    if (otherComments > 0) {
      return forbidden("Cannot delete a discussion with comments from other users");
    }
    await deleteThread({ projectId: id, threadId });
    return ok({ deleted: true });
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    return serverError();
  }
}
