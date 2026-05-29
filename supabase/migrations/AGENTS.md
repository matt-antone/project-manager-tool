<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-21 | Updated: 2026-05-21 -->

# migrations/

## Purpose
Numbered SQL migrations that define the database schema. Applied sequentially in order. Each migration is idempotent and includes rollback safety (e.g., `if not exists`, `drop constraint if exists`). Tracks projects, clients, users, files, comments, tags, FTS indices, and BC2 reconciliation artifacts.

## Key Files
| File | Description |
|------|-------------|
| 0001_init.sql | Create projects, discussion_threads, discussion_comments, project_files tables |
| 0002_clients.sql | Create clients table with unique code |
| 0003_project_status.sql | Add project status column (new, in_progress, blocked, complete, billing) |
| 0004_user_profiles.sql | Create user_profiles table (email, first_name, last_name, is_legacy) |
| 0005_project_identity_and_storage.sql | Add project_seq, project_code, client_slug, project_slug, and storage bucket columns |
| 0006_project_tags_taxonomy.sql | Add tags array column to projects |
| 0007_comment_attachments.sql | Add thread_id and comment_id references to project_files |
| 0008_project_requestor_personal_hours.sql | Add requestor and personal_hours columns to projects |
| 0009_project_user_hours.sql | Create project_user_hours junction table |
| 0010_site_settings_and_project_deadline.sql | Create site_settings table; add deadline to projects |
| 0011_mcp_agents.sql | Create agent_clients table for MCP server credentials |
| 0012_project_files_thumbnail_url.sql | Add thumbnail_url column to project_files |
| 0013_thumbnail_jobs.sql | Create thumbnail_jobs table with status tracking |
| 0014_bc2_people_map.sql | Create import_map_people table for BC2 person ID mapping |
| 0015_thumbnail_jobs_permanent_failure.sql | Update thumbnail_jobs status check to include 'permanent_failure' |
| 0016_project_last_activity_at.sql | Add last_activity_at timestamp to projects |
| 0017_projects_search_fts.sql | Create full-text search index on projects(name, pm_note) |
| 0018_project_pm_note.sql | Add pm_note column to projects (PM-facing note) |
| 0019_site_settings_hourly_rate.sql | Add default_hourly_rate_usd to site_settings (default 150.00) |
| 0020_project_expense_lines.sql | Create project_expense_lines table for cost tracking |
| 0021_project_status_billing.sql | Add 'billing' to project status enum |
| 0022_project_files_bc_attachment.sql | Add bc_attachment_id to project_files (idempotent BC2 re-import) |
| 0023_clients_archive.sql | Add archived and Dropbox archive job metadata to clients |
| 0023_project_files_transfer_status.sql | Add transfer_status tracking to project_files (later reverted) |
| 0024_clients_github_repos_and_domains.sql | Add github_repos and domains array columns to clients |
| 0025_revert_project_files_transfer_status.sql | Revert 0023_project_files_transfer_status.sql (direct Dropbox upload pattern) |
| 0026_project_members.sql | Create project_members junction table with added_at timestamp |
| 0027_project_members_active_resolution.sql | Backfill project_members from legacy BC2 threads/comments |
| 0028_relax_project_identity_constraints.sql | Allow projects without assigned identity; relax project_seq uniqueness |
| 0029_import_logs_data_source.sql | Add data_source column to import_logs ('api' or 'dump') |
| 0030_sync_prod_maps.sql | Create sync_prod_watermarks and per-entity prod→test maps for forward import |
| 0031_sync_prod_matched_existing.sql | Track whether prod→test project was matched to existing or newly inserted |

## For AI Agents

### Working In This Directory
- **Migrations are forward-only.** Once applied to an environment, they are never re-run. New changes go in new migrations.
- **Never re-run full BC2 migration** (from project memory: reconciliation must use targeted subsets, not full-phase orchestration).
- **Backup database before applying any migration** (verified prerequisite in any env: dev, test, prod).
- **Idempotent pattern:** Use `if not exists`, `drop constraint if exists`, and `alter table ... add column if not exists` to tolerate multiple runs.
- **Apply locally first:** Use `supabase db push` to test against local dev database before remote.
- **Deploy to remote:** `supabase link --project-ref <ref>` then `supabase db push` to apply to remote project.

### Common Patterns
- **BC2 import maps:** `import_map_people`, `import_map_projects`, `import_map_tags` (implied from context) map Basecamp 2 IDs to local UUIDs.
- **Status enums:** Defined inline in migrations (e.g., `check (status in (...))`); no separate enum types.
- **Constraints:** Foreign keys use `on delete cascade` for project-owned tables; constraints are named for easy drop/re-add.
- **Denormalization:** Tables like `project_user_hours`, `project_expense_lines`, `project_members` denormalize for query performance.
- **FTS indices:** `projects_search_fts` uses immutable helper functions for stable, indexed search.
- **No RLS policies:** Core tables have no row-level security; access control is in application/API layer.

## Dependencies
- PostgreSQL (Supabase-managed)
- Supabase CLI for local/remote deployment

<!-- MANUAL: -->
