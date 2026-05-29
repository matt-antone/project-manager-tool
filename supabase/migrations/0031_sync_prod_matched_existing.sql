-- supabase/migrations/0031_sync_prod_matched_existing.sql
-- Track whether a prod→test project map row was created by matching an
-- existing test project (true) or by inserting a fresh row (false). The
-- threads/comments/files phases filter out children of matched projects.

alter table import_map_prod_projects
  add column if not exists matched_existing boolean not null default false;

create index if not exists idx_import_map_prod_projects_matched_existing
  on import_map_prod_projects (matched_existing);
