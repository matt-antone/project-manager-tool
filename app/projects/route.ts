import { requireUser } from "@/lib/auth";
import { badRequest, conflict, serverError, unauthorized, ok } from "@/lib/http";
import { sendMail } from "@/lib/mailer";
import { assertClientNotArchivedForMutation, createProject, deleteProjectById, listProjects, setProjectStorageDir } from "@/lib/repositories";
import { buildDropboxProjectFolderBaseName, clientCodeFromProjectCode } from "@/lib/project-storage";
import { DropboxStorageAdapter, getDropboxErrorSummary, isTeamSelectUserRequiredError } from "@/lib/storage/dropbox-adapter";
import { z } from "zod";

const CLIENT_MUTATION_BLOCK_PATTERN = /client is archived|client archive is in progress/i;

const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  clientId: z.string().uuid(),
  tags: z.array(z.string().min(1)).max(50).optional(),
  deadline: z.string().date().optional().nullable(),
  requestor: z.string().optional().nullable(),
  memberIds: z.array(z.string().min(1)).max(200).optional()
});

export async function GET(request: Request) {
  try {
    await requireUser(request);
    const url = new URL(request.url);
    const includeArchived = url.searchParams.get("includeArchived") !== "false";

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

    const sortParam = url.searchParams.get("sort")?.trim() ?? "";
    let sort: "title" | "deadline" | undefined;
    if (sortParam.length > 0) {
      if (sortParam !== "title" && sortParam !== "deadline") {
        return badRequest("Invalid sort");
      }
      sort = sortParam;
    }

    const billingOnly =
      url.searchParams.get("billingOnly") === "true" || url.searchParams.get("billing") === "1";

    const projects = await listProjects(includeArchived, {
      clientId,
      search,
      ...(search.length === 0 && sort ? { sort } : {}),
      ...(billingOnly ? { billingOnly: true } : {})
    });
    return ok({ projects });
  } catch (error) {
    console.error("projects_list_failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    return serverError();
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = createProjectSchema.parse(await request.json());
    await assertClientNotArchivedForMutation(payload.clientId, {
      archived: "Client is archived. Restore it before creating new work.",
      inProgress: "Client archive is in progress. New project creation is temporarily disabled."
    });
    // Note on the legacy-creator edge case: if the authenticated user's
    // profile is legacy / missing email, createProject still inserts them
    // into project_members (preserves the historical invariant from the
    // prior post-insert addProjectMember calls), but they are excluded from
    // addedMemberEmails and NOT surfaced in skippedInactiveUserIds.
    const { project: createdProject, skippedInactiveUserIds, addedMemberEmails } = await createProject({
      name: payload.name,
      description: payload.description,
      createdBy: user.id,
      clientId: payload.clientId,
      tags: payload.tags,
      deadline: payload.deadline,
      requestor: payload.requestor,
      memberIds: payload.memberIds
    });

    const adapter = new DropboxStorageAdapter();
    try {
      const clientCodeUpper = clientCodeFromProjectCode(createdProject.project_code).toUpperCase();
      const projectFolderBaseName = buildDropboxProjectFolderBaseName(createdProject);
      const provisioned = await adapter.ensureProjectFolders({
        clientCodeUpper,
        projectFolderBaseName
      });
      const project = await setProjectStorageDir(createdProject.id, provisioned.projectDir);

      // Emails dispatch AFTER Dropbox provisioning succeeds. If Dropbox
      // failed, control flow takes the catch branch below which invokes
      // deleteProjectById (FK cascade clears project_members) — we never
      // notify users about a rolled-back project. Single-attempt, no
      // retry, no idempotency key.
      if (addedMemberEmails.length > 0) {
        const projectName = createdProject.name;
        const sends = addedMemberEmails.map((email) =>
          sendMail({
            recipients: [{ email }],
            subject: `You've been added to ${projectName}`,
            text: `You're now a member of the project "${projectName}".`,
            html: `<p>You're now a member of the project <strong>${projectName}</strong>.</p>`
          }).catch((err) => {
            console.error("project_member_notify_failed", {
              projectId: createdProject.id,
              email,
              error: err instanceof Error ? err.message : String(err)
            });
          })
        );
        await Promise.allSettled(sends);
      }

      return ok({
        project: project ?? createdProject,
        ...(skippedInactiveUserIds.length > 0 ? { warnings: { skippedInactiveUserIds } } : {})
      }, 201);
    } catch (error) {
      const dropboxSummary = getDropboxErrorSummary(error);

      try {
        await deleteProjectById(createdProject.id);
      } catch (cleanupError) {
        console.error("project_create_cleanup_failed", {
          projectId: createdProject.id,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        });
      }

      console.error("project_storage_provision_failed", {
        projectId: createdProject.id,
        clientCodeUpper: clientCodeFromProjectCode(createdProject.project_code).toUpperCase(),
        projectCode: createdProject.project_code,
        projectSlug: createdProject.project_slug,
        error: dropboxSummary
      });

      if (isTeamSelectUserRequiredError(error)) {
        return serverError("Project creation failed because Dropbox requires DROPBOX_SELECT_USER or DROPBOX_SELECT_ADMIN for this team token.");
      }

      return serverError(`Project creation failed while provisioning Dropbox folders: ${dropboxSummary}`);
    }
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    if (error instanceof Error && CLIENT_MUTATION_BLOCK_PATTERN.test(error.message)) {
      return conflict(error.message);
    }
    if (error instanceof Error && /client|project name/i.test(error.message)) {
      return badRequest(error.message);
    }
    if (error instanceof z.ZodError) {
      return badRequest(error.message);
    }
    return serverError();
  }
}
