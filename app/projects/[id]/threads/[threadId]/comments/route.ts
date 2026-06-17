import { requireUser } from "@/lib/auth";
import { sendCommentCreatedEmail } from "@/lib/mailer";
import { badRequest, conflict, notFound, ok, serverError, unauthorized } from "@/lib/http";
import {
  assertClientNotArchivedForMutation,
  createComment,
  getProject,
  getThread,
  getUserProfileById,
  listProjectMemberRecipients
} from "@/lib/repositories";
import { getDisplayName } from "@/lib/display-name";
import { z } from "zod";

const CLIENT_MUTATION_BLOCK_PATTERN = /client is archived|client archive is in progress/i;

const createCommentSchema = z.object({
  bodyMarkdown: z.string().min(1)
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; threadId: string }> }
) {
  try {
    const { id, threadId } = await params;
    console.error("comment_route_post_received", {
      projectId: id,
      threadId,
      hasAuthorization: typeof request.headers.get("authorization") === "string"
    });

    const user = await requireUser(request);
    const [project, threadResult] = await Promise.all([getProject(id), getThread(id, threadId)]);
    const thread = threadResult as { id: string; title: string } | null;
    if (!project) {
      return notFound("Project not found");
    }
    if (!thread) {
      return notFound("Thread not found");
    }
    await assertClientNotArchivedForMutation(project.client_id, {
      archived: "Client is archived. Restore it before posting comments.",
      inProgress: "Client archive is in progress. New comments are temporarily disabled."
    });

    const payload = createCommentSchema.parse(await request.json());
    const comment = await createComment({
      projectId: id,
      threadId,
      bodyMarkdown: payload.bodyMarkdown,
      authorUserId: user.id
    });

    let recipientCount = 0;
    let emailBranch: "not_attempted" | "attempted" | "skipped_no_recipients" | "failed" = "not_attempted";
    let mailResult: Awaited<ReturnType<typeof sendCommentCreatedEmail>> | null = null;
    let emailError: string | null = null;

    try {
      const [actorProfile, recipients] = await Promise.all([
        getUserProfileById(user.id),
        listProjectMemberRecipients(id, user.id)
      ]);
      recipientCount = recipients.length;

      if (recipients.length === 0) {
        emailBranch = "skipped_no_recipients";
        console.warn("transactional_email_skipped", {
          eventType: "comment_created",
          actorId: user.id,
          projectId: id,
          threadId,
          reason: "no_recipients"
        });
      } else {
        const threadUrl = new URL(`/${id}/${threadId}`, request.url).toString();
        emailBranch = "attempted";
        console.info("transactional_email_attempt", {
          eventType: "comment_created",
          actorId: user.id,
          projectId: id,
          threadId,
          recipientCount
        });

        mailResult = await sendCommentCreatedEmail({
          recipients: recipients.map((recipient) => ({
            email: recipient.email,
            name: getDisplayName(recipient)
          })),
          actor: {
            name: getDisplayName({ ...(actorProfile ?? {}), email: user.email }),
            email: user.email
          },
          project: {
            id: project.id,
            name: project.name,
            client_code: project.client_code ?? null,
            project_code: project.project_code ?? null
          },
          thread: {
            id: threadId,
            title: thread.title,
            bodyMarkdown: ""
          },
          comment: {
            id: comment.id,
            bodyMarkdown: payload.bodyMarkdown
          },
          threadUrl
        });

        console.info("transactional_email_result", {
          eventType: "comment_created",
          actorId: user.id,
          projectId: id,
          threadId,
          recipientCount,
          mailResult
        });
      }
    } catch (error) {
      emailBranch = "failed";
      emailError = error instanceof Error ? error.message : String(error);
      console.error("transactional_email_failed", {
        eventType: "comment_created",
        actorId: user.id,
        projectId: id,
        threadId,
        recipientCount,
        error: emailError
      });
    }

    console.error("transactional_email_audit", {
      eventType: "comment_created",
      actorId: user.id,
      projectId: id,
      threadId,
      recipientCount,
      emailBranch,
      mailResult,
      emailError
    });

    return ok({ comment }, 201);
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    if (error instanceof Error && CLIENT_MUTATION_BLOCK_PATTERN.test(error.message)) {
      return conflict(error.message);
    }
    if (error instanceof z.ZodError) {
      return badRequest(error.message);
    }
    return serverError();
  }
}
