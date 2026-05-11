// lib/imports/sync-prod-to-test/prod-reader.ts
import type { Pool } from "pg";
import type {
  ProdProjectRow, ProdThreadRow, ProdCommentRow, ProdFileRow,
} from "./types";

export interface ProdReader {
  projectsWithPostCutoffActivity(cutoff: Date, opts?: { code?: string; limit?: number | null }): Promise<ProdProjectRow[]>;
  threadsPostCutoff(projectId: string, cutoff: Date): Promise<ProdThreadRow[]>;
  commentsPostCutoff(projectId: string, cutoff: Date): Promise<ProdCommentRow[]>;
  filesPostCutoff(projectId: string, cutoff: Date): Promise<ProdFileRow[]>;
}

export function createProdReader(prod: Pool): ProdReader {
  async function projectsWithPostCutoffActivity(
    cutoff: Date,
    opts: { code?: string; limit?: number | null } = {},
  ): Promise<ProdProjectRow[]> {
    const params: (string | number | Date)[] = [cutoff];
    let where = "";
    if (opts.code) { params.push(opts.code); where += ` AND p.project_code = $${params.length}`; }
    let sql = `
      WITH activity AS (
        SELECT DISTINCT project_id FROM discussion_threads  WHERE created_at >= $1
        UNION SELECT DISTINCT project_id FROM project_files       WHERE created_at >= $1
        UNION SELECT DISTINCT project_id FROM discussion_comments WHERE created_at >= $1
      )
      SELECT p.id, p.project_code, p.client_slug, p.project_slug, p.slug, p.name, p.archived, p.status,
             p.client_id, c.code AS client_code, c.name AS client_name,
             p.created_at, p.updated_at, p.last_activity_at
        FROM projects p
        JOIN activity a ON a.project_id = p.id
        LEFT JOIN clients c ON c.id = p.client_id
       WHERE 1=1${where}
       ORDER BY p.project_code NULLS LAST`;
    if (opts.limit != null) { params.push(opts.limit); sql += ` LIMIT $${params.length}`; }
    const r = await prod.query(sql, params);
    return r.rows.map(mapProject);
  }

  async function threadsPostCutoff(projectId: string, cutoff: Date): Promise<ProdThreadRow[]> {
    const r = await prod.query(`
      SELECT t.id, t.project_id, t.title, t.body_markdown, t.body_html, t.author_user_id,
             t.created_at, t.updated_at, t.edited_at,
             m.basecamp_thread_id
        FROM discussion_threads t
        LEFT JOIN import_map_threads m ON m.local_thread_id = t.id
       WHERE t.project_id = $1 AND t.created_at >= $2
       ORDER BY t.created_at`, [projectId, cutoff]);
    return r.rows.map((row) => ({ ...row, created_at: new Date(row.created_at),
      updated_at: row.updated_at ? new Date(row.updated_at) : null,
      edited_at: row.edited_at ? new Date(row.edited_at) : null }));
  }

  async function commentsPostCutoff(projectId: string, cutoff: Date): Promise<ProdCommentRow[]> {
    const r = await prod.query(`
      SELECT c.id, c.project_id, c.thread_id, c.body_markdown, c.body_html, c.author_user_id,
             c.created_at, c.updated_at, c.edited_at,
             m.basecamp_comment_id
        FROM discussion_comments c
        LEFT JOIN import_map_comments m ON m.local_comment_id = c.id
       WHERE c.project_id = $1 AND c.created_at >= $2
       ORDER BY c.created_at`, [projectId, cutoff]);
    return r.rows.map((row) => ({ ...row, created_at: new Date(row.created_at),
      updated_at: row.updated_at ? new Date(row.updated_at) : null,
      edited_at: row.edited_at ? new Date(row.edited_at) : null }));
  }

  async function filesPostCutoff(projectId: string, cutoff: Date): Promise<ProdFileRow[]> {
    const r = await prod.query(`
      SELECT f.id, f.project_id, f.thread_id, f.comment_id, f.uploader_user_id,
             f.filename, f.mime_type, f.size_bytes, f.dropbox_file_id, f.dropbox_path,
             f.checksum, f.bc_attachment_id, f.created_at,
             m.basecamp_file_id
        FROM project_files f
        LEFT JOIN import_map_files m ON m.local_file_id = f.id
       WHERE f.project_id = $1 AND f.created_at >= $2
       ORDER BY f.created_at`, [projectId, cutoff]);
    return r.rows.map((row) => ({ ...row, created_at: new Date(row.created_at),
      size_bytes: row.size_bytes !== null ? Number(row.size_bytes) : null }));
  }

  return { projectsWithPostCutoffActivity, threadsPostCutoff, commentsPostCutoff, filesPostCutoff };
}

function mapProject(row: Record<string, unknown>): ProdProjectRow {
  return {
    ...(row as object),
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
    last_activity_at: row.last_activity_at ? new Date(row.last_activity_at as string) : null,
  } as ProdProjectRow;
}
