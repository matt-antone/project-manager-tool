-- supabase/migrations/0034_mcp_create_project.sql
--
-- create_project over MCP failed on every call: it inserted NULL into
-- projects.tags, which is `not null default '{}'` (0006), and left the whole
-- project_code / project_seq / slug identity NULL.
--
-- This mirrors createProject in lib/repositories.ts so agent-created projects
-- get the same CODE-####-slug identity, sequence lock, and storage path as
-- UI-created ones, instead of duplicating that logic in the edge function.

create or replace function mcp_create_project(
  p_name text,
  p_created_by text,
  p_client_id uuid,
  p_description text default null,
  p_deadline date default null,
  p_tags text[] default '{}'::text[],
  p_requestor text default null,
  p_pm_note text default null,
  p_projects_root text default '/Projects'
)
returns projects
language plpgsql as $$
declare
  v_client clients%rowtype;
  v_seq integer;
  v_code text;
  v_client_slug text;
  v_project_slug text;
  v_title text := trim(p_name);
  v_row projects%rowtype;
begin
  if v_title = '' then
    raise exception 'Project name is required' using errcode = '23514';
  end if;

  select * into v_client from clients where id = p_client_id;
  if not found then
    raise exception 'Unknown client %', p_client_id using errcode = '23503';
  end if;

  -- Same advisory lock key as the app path, so both serialize on the same
  -- per-client sequence instead of racing each other.
  perform pg_advisory_xact_lock(hashtext('project-seq:' || p_client_id::text));
  select coalesce(max(project_seq), 0) + 1 into v_seq
    from projects where client_id = p_client_id;

  v_code := v_client.code || '-' || lpad(v_seq::text, 4, '0');
  v_client_slug := coalesce(nullif(trim(both '-' from regexp_replace(lower(v_client.name), '[^a-z0-9]+', '-', 'g')), ''), 'client');
  v_project_slug := coalesce(nullif(trim(both '-' from regexp_replace(lower(v_title), '[^a-z0-9]+', '-', 'g')), ''), 'project');

  insert into projects (
    name, slug, description, created_by, client_id, status,
    project_seq, project_code, client_slug, project_slug,
    tags, storage_project_dir, deadline, requestor, pm_note
  ) values (
    v_title,
    lower(v_code || '-' || v_project_slug),
    p_description,
    p_created_by,
    p_client_id,
    'new',
    v_seq,
    v_code,
    v_client_slug,
    v_project_slug,
    coalesce(
      (select array_agg(distinct lower(trim(t.tag)))
         from unnest(coalesce(p_tags, '{}'::text[])) as t(tag)
        where trim(t.tag) <> ''),
      '{}'::text[]
    ),
    p_projects_root || '/' || upper(trim(v_client.code)) || '/' || upper(v_code) || '-' ||
      coalesce(nullif(trim(regexp_replace(regexp_replace(v_title, '[\/:*?"<>|]', '', 'g'), '[[:space:]]+', ' ', 'g')), ''), 'project'),
    p_deadline,
    p_requestor,
    p_pm_note
  )
  returning * into v_row;

  return v_row;
end;
$$;
