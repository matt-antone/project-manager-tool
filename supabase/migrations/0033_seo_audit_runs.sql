create table if not exists seo_audit_runs (
  id            uuid primary key default gen_random_uuid(),
  url           text not null,
  host          text,
  status        text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  requested_by  text not null references user_profiles(id) on delete cascade,
  max_pages     integer not null default 30,
  result        jsonb,
  seo_score     integer,
  aeo_score     integer,
  pages_crawled integer,
  error         text,
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists seo_audit_runs_requested_by_created_at_idx
  on seo_audit_runs (requested_by, created_at desc);

create index if not exists seo_audit_runs_status_created_at_idx
  on seo_audit_runs (status, created_at);
