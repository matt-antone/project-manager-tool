import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { badRequest, conflict, forbidden, notFound, ok, serverError, unauthorized } from "@/lib/http";
import { assertClientNotArchivedForMutation, getFileByDropboxPath, getProject } from "@/lib/repositories";
import { getProjectStorageDir } from "@/lib/project-storage";
import { DropboxStorageAdapter } from "@/lib/storage/dropbox-adapter";

const abortSchema = z.object({
  targetPath: z.string().min(1).max(1024)
});

const CLIENT_MUTATION_BLOCK_PATTERN = /client is archived|client archive is in progress/i;

/**
 * Best-effort cleanup for a failed upload. The temporary upload link commits bytes to Dropbox
 * before the client knows the upload succeeded; if finalize then fails the bytes are orphaned and
 * hold the filename hostage. This endpoint deletes that orphan so the original name can be reused.
 *
 * Safety: only deletes paths inside the project's uploads/ area, and refuses any path that a
 * project_files row already tracks (an established file is never an orphan).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser(request);
    const { id: projectId } = await params;

    const project = await getProject(projectId);
    if (!project) {
      return notFound("Project not found");
    }

    await assertClientNotArchivedForMutation(project.client_id, {
      archived: "Client is archived. Restore it before modifying files.",
      inProgress: "Client archive is in progress. File changes are temporarily disabled."
    });

    const body = await request.json().catch(() => null);
    const parsed = abortSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(parsed.error.message);
    }

    const expectedPrefix = `${getProjectStorageDir(project)}/uploads/`;
    if (!parsed.data.targetPath.startsWith(expectedPrefix)) {
      return forbidden("Path is outside the project's storage area");
    }

    const tracked = await getFileByDropboxPath(projectId, parsed.data.targetPath);
    if (tracked) {
      return conflict("Refusing to delete a tracked file");
    }

    const adapter = new DropboxStorageAdapter();
    await adapter.deleteByPath(parsed.data.targetPath);

    return ok({ deleted: true });
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    if (error instanceof Error && CLIENT_MUTATION_BLOCK_PATTERN.test(error.message)) {
      return conflict(error.message);
    }
    console.error("upload_abort_failed", { error });
    return serverError();
  }
}
