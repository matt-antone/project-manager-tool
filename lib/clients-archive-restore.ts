import { after } from "next/server";
import { requireUser } from "@/lib/auth";
import { config } from "@/lib/config";
import { badRequest, conflict, notFound, ok, serverError, unauthorized } from "@/lib/http";
import { getClientById, rewriteClientDropboxPaths, updateClientArchiveState } from "@/lib/repositories";
import { DropboxStorageAdapter, getDropboxErrorSummary } from "@/lib/storage/dropbox-adapter";

type ClientArchiveRestoreMode = "archive" | "restore";

const MISSING_ROOT_MESSAGE = "DROPBOX_ARCHIVED_CLIENTS_ROOT is required to archive clients.";

function getConfiguredArchivedRoot() {
  try {
    return config.dropboxArchivedClientsRoot();
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : MISSING_ROOT_MESSAGE);
  }
}

export function createClientArchiveRestoreHandler(mode: ClientArchiveRestoreMode) {
  return async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
      await requireUser(request);
      const { id } = await params;
      const client = await getClientById(id);
      if (!client) {
        return notFound("Client not found");
      }

      try {
        getConfiguredArchivedRoot();
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : MISSING_ROOT_MESSAGE);
      }

      const status = (client.dropbox_archive_status ?? "idle").toLowerCase();
      if (status === "pending" || status === "in_progress") {
        return conflict("Client archive is already running.");
      }
      if (mode === "archive" && client.archived_at) {
        return conflict("Client is already archived.");
      }
      if (mode === "restore" && !client.archived_at) {
        return conflict("Client is not archived.");
      }

      await updateClientArchiveState(id, {
        status: "pending",
        archiveError: null
      });

      after(async () => {
        const adapter = new DropboxStorageAdapter();
        try {
          await updateClientArchiveState(id, {
            status: "in_progress",
            archiveError: null
          });

          const moved =
            mode === "archive"
              ? await adapter.archiveClientRootFolder({ clientCodeUpper: client.code })
              : await adapter.restoreClientRootFolder({ clientCodeUpper: client.code });

          await rewriteClientDropboxPaths({
            clientId: id,
            fromRoot: moved.fromPath,
            toRoot: moved.toPath
          });

          await updateClientArchiveState(id, {
            status: mode === "archive" ? "completed" : "idle",
            archiveError: null,
            archivedAt: mode === "archive" ? new Date().toISOString() : null
          });
        } catch (error) {
          await updateClientArchiveState(id, {
            status: "failed",
            archiveError: getDropboxErrorSummary(error)
          });
        }
      });

      return ok({ pollUrl: `/api/clients/${id}` }, 202);
    } catch (error) {
      if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
        return unauthorized(error.message);
      }
      return serverError();
    }
  };
}
