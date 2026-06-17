import { requireUser } from "@/lib/auth";
import { sendThreadCreatedEmail } from "@/lib/mailer";
import { badRequest, conflict, notFound, ok, serverError, unauthorized } from "@/lib/http";
import {
  assertClientNotArchivedForMutation,
  createThread,
  getProject,
  getUserProfileById,
  listProjectMemberRecipients,
  listThreads
} from "@/lib/repositories";
import { getDisplayName } from "@/lib/display-name";
import { z } from "zod";

const CLIENT_MUTATION_BLOCK_PATTERN = /client is archived|client archive is in progress/i;

const createThreadSchema = z.object({
  title: z.string().min(1),
  bodyMarkdown: z.string().min(1)
});

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser(request);
    const { id } = await params;
    const project = await getProject(id);
    if (!project) {
      return notFound("Project not found");
    }
    const threads = await listThreads(id);
    return ok({ threads });
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    return serverError();
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const project = await getProject(id);
    if (!project) {
      return notFound("Project not found");
    }
    await assertClientNotArchivedForMutation(project.client_id, {
      archived: "Client is archived. Restore it before starting new discussions.",
      inProgress: "Client archive is in progress. New discussions are temporarily disabled."
    });

    const payload = createThreadSchema.parse(await request.json());
    const thread = await createThread({
      projectId: id,
      title: payload.title,
      bodyMarkdown: payload.bodyMarkdown,
      authorUserId: user.id
    });

    let recipientCount = 0;
    try {
      const [actorProfile, recipients] = await Promise.all([
        getUserProfileById(user.id),
        listProjectMemberRecipients(id, user.id)
      ]);
      recipientCount = recipients.length;

      if (recipients.length === 0) {
        console.warn("transactional_email_skipped", {
          eventType: "thread_created",
          actorId: user.id,
          projectId: id,
          threadId: thread.id,
          reason: "no_recipients"
        });
      } else {
        const threadUrl = new URL(`/${id}/${thread.id}`, request.url).toString();
        console.info("transactional_email_attempt", {
          eventType: "thread_created",
          actorId: user.id,
          projectId: id,
          threadId: thread.id,
          recipientCount
        });

        const mailResult = await sendThreadCreatedEmail({
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
            id: thread.id,
            title: thread.title,
            bodyMarkdown: payload.bodyMarkdown
          },
          threadUrl
        });

        console.info("transactional_email_result", {
          eventType: "thread_created",
          actorId: user.id,
          projectId: id,
          threadId: thread.id,
          recipientCount,
          mailResult
        });
      }
    } catch (error) {
      console.error("transactional_email_failed", {
        eventType: "thread_created",
        actorId: user.id,
        projectId: id,
        threadId: thread.id,
        recipientCount,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return ok({ thread }, 201);
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
