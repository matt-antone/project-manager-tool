import { createClientArchiveRestoreHandler } from "@/lib/clients-archive-restore";

/**
 * Dropbox client-folder moves can take minutes for large trees, so this route returns `202 Accepted`
 * and completes the move in `after()`. v1 has no automatic retries; the UI surfaces failures and
 * re-invokes this route manually after the operator reviews the error.
 */
export const POST = createClientArchiveRestoreHandler("archive");
