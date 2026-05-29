import { createClientArchiveRestoreHandler } from "@/lib/clients-archive-restore";

/**
 * Restore mirrors archive: return `202 Accepted`, run the Dropbox move in `after()`, and let the UI
 * poll `/clients/:id` every 2 seconds until `idle` or `failed`. v1 retries are operator-driven only.
 */
export const POST = createClientArchiveRestoreHandler("restore");
