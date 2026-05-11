// lib/imports/sync-prod-to-test/types.ts

export interface SyncRunContext {
  cutoff: Date;
  dryRun: boolean;
  skipFiles: boolean;
  runId: string; // uuid
  extractDir: string; // docs/reconcile/extracts/<ISO>
}

export interface ProdProjectRow {
  id: string; // uuid
  project_code: string | null;
  client_slug: string | null;
  project_slug: string | null;
  slug: string | null;
  name: string | null;
  archived: boolean;
  status: string | null;
  client_id: string;
  client_code: string | null;
  client_name: string | null;
  created_at: Date;
  updated_at: Date;
  last_activity_at: Date | null;
}

export interface ProdThreadRow {
  id: string;
  project_id: string;
  title: string | null;
  body_markdown: string | null;
  body_html: string | null;
  author_user_id: string | null;
  created_at: Date;
  updated_at: Date | null;
  edited_at: Date | null;
  basecamp_thread_id: string | null;
}

export interface ProdCommentRow {
  id: string;
  project_id: string;
  thread_id: string | null;
  body_markdown: string | null;
  body_html: string | null;
  author_user_id: string | null;
  created_at: Date;
  updated_at: Date | null;
  edited_at: Date | null;
  basecamp_comment_id: string | null;
}

export interface ProdFileRow {
  id: string;
  project_id: string;
  thread_id: string | null;
  comment_id: string | null;
  uploader_user_id: string | null;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  dropbox_file_id: string | null;
  dropbox_path: string | null;
  checksum: string | null;
  bc_attachment_id: string | null;
  created_at: Date;
  basecamp_file_id: string | null;
}

export type ProjectAction =
  | "create_in_test"
  | "append_to_existing"
  | "create_and_archive_padded_twin"
  | "skip";

export interface ProjectOutcome {
  prod_project_id: string;
  prod_project_code: string | null;
  prod_name: string | null;
  action: ProjectAction;
  test_project_id: string | null;
  test_padded_twin_id: string | null;
  threads_inserted: number;
  threads_skipped_existing: number;
  comments_inserted: number;
  comments_skipped_existing: number;
  files_inserted: number;
  files_skipped_existing: number;
  files_copied_dropbox: number;
  files_failed_dropbox: number;
  errors: string[];
}
