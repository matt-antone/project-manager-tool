import { randomUUID } from "node:crypto";
import type { PhaseCtx, PhaseResult, PhaseError } from "./types";
import { resolveUserRef } from "./user-ref";
import { DropboxStorageAdapter } from "@/lib/storage/dropbox-adapter";

interface ProdFileRow {
  id: string;
  project_id: string;
  thread_id: string | null;
  comment_id: string | null;
  uploader_user_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  dropbox_file_id: string;
  dropbox_path: string;
  checksum: string;
  thumbnail_url: string | null;
  bc_attachment_id: string | null;
  created_at: Date;
}

async function lookupMap(ctx: PhaseCtx, table: string, prodId: string): Promise<string | null> {
  const r = await ctx.test.query<{ local_id: string }>(
    `select local_id from ${table} where prod_id = $1`,
    [prodId]
  );
  return r.rows[0]?.local_id ?? null;
}

function rewritePath(prodPath: string, prodRoot: string, testRoot: string): string | null {
  if (!prodPath.startsWith(prodRoot)) return null;
  return testRoot + prodPath.slice(prodRoot.length);
}

export interface FilesPhaseDeps {
  dropbox?: {
    copyFile: (args: { fromPath: string; toPath: string; autorename: boolean }) => Promise<{ id: string; pathDisplay: string }>;
  };
}

export async function runFilesPhase(ctx: PhaseCtx, deps: FilesPhaseDeps = {}): Promise<PhaseResult> {
  const watermark = ctx.watermarks.get("files") ?? new Date(0);
  const limit = ctx.flags.limitPerPhase;

  const prodRoot = process.env.PROD_DROPBOX_PROJECTS_ROOT_FOLDER;
  const testRoot = process.env.DROPBOX_PROJECTS_ROOT_FOLDER;
  if (!prodRoot || !testRoot) {
    throw new Error(
      "PROD_DROPBOX_PROJECTS_ROOT_FOLDER and DROPBOX_PROJECTS_ROOT_FOLDER must both be set"
    );
  }

  const dropbox = deps.dropbox ?? new DropboxStorageAdapter();

  const sql =
    `select id, project_id, thread_id, comment_id, uploader_user_id, filename, mime_type,
            size_bytes, dropbox_file_id, dropbox_path, checksum, thumbnail_url, bc_attachment_id,
            created_at
       from project_files
       where created_at > $1
       order by created_at asc, id asc` +
    (limit ? ` limit ${Math.max(1, Math.floor(limit))}` : "");
  const prodRes = await ctx.prod.query<ProdFileRow>(sql, [watermark]);

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  const errors: PhaseError[] = [];
  let maxSeen = watermark;

  for (const row of prodRes.rows) {
    try {
      await ctx.test.query("begin");
      const mapped = await lookupMap(ctx, "import_map_prod_files", row.id);
      if (mapped) {
        await ctx.test.query("commit");
        skipped++;
        if (row.created_at > maxSeen) maxSeen = row.created_at;
        continue;
      }

      const localProject = await lookupMap(ctx, "import_map_prod_projects", row.project_id);
      if (!localProject) throw new Error(`unresolved project ${row.project_id}`);
      const localUploader = await resolveUserRef(ctx, row.uploader_user_id);
      const localThread = row.thread_id
        ? await lookupMap(ctx, "import_map_prod_threads", row.thread_id)
        : null;
      const localComment = row.comment_id
        ? await lookupMap(ctx, "import_map_prod_comments", row.comment_id)
        : null;

      const testPath = rewritePath(row.dropbox_path, prodRoot, testRoot);
      if (!testPath) {
        throw new Error(
          `dropbox_path "${row.dropbox_path}" does not start with prod root "${prodRoot}"`
        );
      }

      const copyRes = await dropbox.copyFile({
        fromPath: row.dropbox_path,
        toPath: testPath,
        autorename: true,
      });
      const newFileId = copyRes.id;
      const newPath = copyRes.pathDisplay;

      const localId = randomUUID();
      await ctx.test.query(
        `insert into project_files
           (id, project_id, thread_id, comment_id, uploader_user_id, filename, mime_type,
            size_bytes, dropbox_file_id, dropbox_path, checksum, thumbnail_url, bc_attachment_id,
            created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          localId,
          localProject,
          localThread,
          localComment,
          localUploader,
          row.filename,
          row.mime_type,
          row.size_bytes,
          newFileId,
          newPath,
          row.checksum,
          row.thumbnail_url,
          row.bc_attachment_id,
          row.created_at,
        ]
      );
      await ctx.test.query(
        "insert into import_map_prod_files (prod_id, local_id) values ($1, $2)",
        [row.id, localId]
      );
      await ctx.test.query("commit");
      inserted++;
      if (row.created_at > maxSeen) maxSeen = row.created_at;
    } catch (e) {
      try { await ctx.test.query("rollback"); } catch { /* ignore */ }
      failed++;
      errors.push({ prodId: row.id, reason: (e as Error).message });
    }
  }

  ctx.log(
    `[files] scanned=${prodRes.rows.length} inserted=${inserted} skipped=${skipped} failed=${failed}`
  );

  return {
    entity: "files",
    kind: "insert",
    scanned: prodRes.rows.length,
    inserted,
    skipped,
    failed,
    newWatermark: maxSeen,
    errors,
  };
}

interface ProdFileRefreshRow {
  id: string;
  filename: string;
  mime_type: string;
  thumbnail_url: string | null;
  bc_attachment_id: string | null;
}

export async function runFilesPhaseRefresh(ctx: PhaseCtx): Promise<PhaseResult> {
  const mapRes = await ctx.test.query<{ prod_id: string; local_id: string }>(
    "select prod_id, local_id from import_map_prod_files"
  );
  if (mapRes.rows.length === 0) {
    ctx.log("[files:refresh] no mapped files");
    return { entity: "files", kind: "refresh", scanned: 0, inserted: 0, skipped: 0, failed: 0, newWatermark: new Date(0), errors: [] };
  }
  const prodIds = mapRes.rows.map((r) => r.prod_id);
  const localByProd = new Map(mapRes.rows.map((r) => [r.prod_id, r.local_id]));

  const limit = ctx.flags.limitPerPhase;
  const limitClause = limit ? ` limit ${Math.max(1, Math.floor(limit))}` : "";

  const prodRes = await ctx.prod.query<ProdFileRefreshRow>(
    `select id, filename, mime_type, thumbnail_url, bc_attachment_id
       from project_files
       where id = ANY($1)
       order by id asc` + limitClause,
    [prodIds]
  );

  let updated = 0;
  let failed = 0;
  const errors: PhaseError[] = [];

  for (const row of prodRes.rows) {
    const localId = localByProd.get(row.id);
    if (!localId) continue;
    try {
      await ctx.test.query(
        `update project_files set
            filename = $2,
            mime_type = $3,
            thumbnail_url = $4,
            bc_attachment_id = $5
          where id = $1`,
        [localId, row.filename, row.mime_type, row.thumbnail_url, row.bc_attachment_id]
      );
      updated++;
    } catch (e) {
      failed++;
      errors.push({ prodId: row.id, reason: (e as Error).message });
    }
  }

  ctx.log(
    `[files:refresh] scanned=${prodRes.rows.length} updated=${updated} failed=${failed}`
  );

  return {
    entity: "files",
    kind: "refresh",
    scanned: prodRes.rows.length,
    inserted: updated,
    skipped: 0,
    failed,
    newWatermark: new Date(0),
    errors,
  };
}
