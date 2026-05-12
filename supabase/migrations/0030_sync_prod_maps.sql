-- supabase/migrations/0030_sync_prod_maps.sql
-- Prod → Test forward importer: watermark + per-entity prod-id → local-id maps.
-- See docs/superpowers/specs/2026-05-12-prod-to-test-forward-importer-design.md.

create table if not exists sync_prod_watermarks (
  entity         text primary key,
  last_synced_at timestamptz not null,
  last_run_at    timestamptz not null default now()
);

create table if not exists import_map_prod_clients (
  prod_id  uuid primary key,
  local_id uuid not null
);

create table if not exists import_map_prod_users (
  prod_id  text primary key,
  local_id text not null
);

create table if not exists import_map_prod_projects (
  prod_id  uuid primary key,
  local_id uuid not null
);

create table if not exists import_map_prod_threads (
  prod_id  uuid primary key,
  local_id uuid not null
);

create table if not exists import_map_prod_comments (
  prod_id  uuid primary key,
  local_id uuid not null
);

create table if not exists import_map_prod_files (
  prod_id  uuid primary key,
  local_id uuid not null
);
