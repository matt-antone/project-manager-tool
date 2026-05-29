import slugify from "slugify";
import { config } from "./config-core";
import { query, withTransaction, type PoolClient } from "./db";
import { renderMarkdown } from "./markdown";
import { DEFAULT_HOURLY_RATE_USD, MAX_EXPENSE_LINE_AMOUNT_USD, MAX_SITE_HOURLY_RATE_USD } from "./project-financials";
import type { ProjectStatus } from "./project-status";
import type { ClientRecord } from "./types/client-record";
import type { ClientWithStats, ClientTabCounts, ClientDetailStats, ClientProjectRow } from "./types/client-stats";

export type UserProfile = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  timezone: string | null;
  bio: string | null;
};

type NotificationRecipient = Pick<UserProfile, "id" | "email" | "firstName" | "lastName">;
type SiteSettings = {
  siteTitle: string | null;
  logoUrl: string | null;
  defaultHourlyRateUsd: number | string | null;
};


type ClientArchiveStatus = "idle" | "pending" | "in_progress" | "completed" | "failed";

export type ProjectUserHours = {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  avatarUrl: string | null;
  hours: number | string;
};

type ProjectExpenseLine = {
  id: string;
  projectId: string;
  label: string;
  amount: number | string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

function parseProjectFileSizeBytes(value: unknown) {
  const numericValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : 0;
}

function normalizeProjectFileSizeRow<T extends Record<string, unknown>>(row: T): T {
  if (!Object.prototype.hasOwnProperty.call(row, "size_bytes")) {
    return row;
  }

  return {
    ...row,
    size_bytes: parseProjectFileSizeBytes((row as { size_bytes?: unknown }).size_bytes)
  } as T;
}

export async function getUserProfileById(id: string) {
  const result = await query("select * from user_profiles where id = $1", [id]);
  return result.rows[0] ?? null;
}

type ActiveUser = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
};

export async function listActiveUsers(): Promise<ActiveUser[]> {
  const result = await query<ActiveUser>(
    `select id, email, first_name, last_name
       from user_profiles
      where is_legacy = false
        and email is not null
      order by coalesce(first_name, ''), coalesce(last_name, '')`
  );
  return result.rows;
}

export async function getActiveUserById(userId: string): Promise<ActiveUser | null> {
  const result = await query<ActiveUser>(
    `select id, email, first_name, last_name
       from user_profiles
      where id = $1
        and is_legacy = false
        and email is not null`,
    [userId]
  );
  return result.rows[0] ?? null;
}

export async function createUserProfile(profile: UserProfile) {
  const result = await query(
    `insert into user_profiles (id, email, first_name, last_name, avatar_url, job_title, timezone, bio)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (id) do nothing
     returning *`,
    [
      profile.id,
      profile.email,
      profile.firstName,
      profile.lastName,
      profile.avatarUrl,
      profile.jobTitle,
      profile.timezone,
      profile.bio
    ]
  );
  return result.rows[0] ?? null;
}

export async function updateUserProfile(args: {
  id: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  timezone: string | null;
  bio: string | null;
}) {
  const result = await query(
    `update user_profiles
     set first_name = $2,
         last_name = $3,
         avatar_url = $4,
         job_title = $5,
         timezone = $6,
         bio = $7,
         updated_at = now(),
         last_seen_at = now()
     where id = $1
     returning *`,
    [args.id, args.firstName, args.lastName, args.avatarUrl, args.jobTitle, args.timezone, args.bio]
  );
  return result.rows[0] ?? null;
}

export async function listNotificationRecipients(): Promise<NotificationRecipient[]> {
  const result = await query(
    `with deduped as (
       select distinct on (lower(email))
              id,
              email,
              first_name as "firstName",
              last_name as "lastName"
       from user_profiles
       where active = true
         and lower(split_part(email, '@', 2)) = $1
       order by lower(email), coalesce(first_name, ''), coalesce(last_name, ''), email, id
     )
     select *
     from deduped
     order by coalesce("firstName", ''), coalesce("lastName", ''), email`,
    [config.workspaceDomain()]
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    email: String(row.email),
    firstName: typeof row.firstName === "string" ? row.firstName : null,
    lastName: typeof row.lastName === "string" ? row.lastName : null
  }));
}

export async function listClients(): Promise<ClientRecord[]> {
  const result = await query("select * from clients order by name asc");
  return result.rows as ClientRecord[];
}

export async function createClient(args: {
  name: string;
  code: string;
  githubRepos?: string[];
  domains?: string[];
}): Promise<ClientRecord | undefined> {
  const code = args.code.trim().toUpperCase();
  const result = await query(
    `insert into clients (name, code, github_repos, domains)
     values ($1, $2, $3::text[], $4::text[])
     returning *`,
    [args.name.trim(), code, args.githubRepos ?? [], args.domains ?? []]
  );
  return result.rows[0] as ClientRecord | undefined;
}

export async function getClientById(id: string): Promise<ClientRecord | null> {
  const result = await query("select * from clients where id = $1", [id]);
  return (result.rows[0] as ClientRecord | undefined) ?? null;
}

export async function updateClientArchiveState(
  id: string,
  args: {
    status: ClientArchiveStatus;
    archiveError?: string | null;
    archivedAt?: string | null;
  }
) {
  const shouldOverwriteArchivedAt = Object.prototype.hasOwnProperty.call(args, "archivedAt");
  const result = await query(
    `update clients
     set dropbox_archive_status = $2,
         archive_error = $3,
         archived_at = case
           when $5::boolean then $4::timestamptz
           else archived_at
         end,
         archive_started_at = case
           when $2 = 'pending' then now()
           when $2 = 'idle' then null
           else coalesce(archive_started_at, now())
         end
     where id = $1::uuid
     returning *`,
    [id, args.status, args.archiveError ?? null, args.archivedAt ?? null, shouldOverwriteArchivedAt]
  );
  return (result.rows[0] as ClientRecord | undefined) ?? null;
}

export async function rewriteClientDropboxPaths(args: { clientId: string; fromRoot: string; toRoot: string }) {
  const fromRoot = args.fromRoot.trim().replace(/\/+$/, "");
  const toRoot = args.toRoot.trim().replace(/\/+$/, "");
  if (!fromRoot || !toRoot || !fromRoot.startsWith("/") || !toRoot.startsWith("/")) {
    throw new Error("Client Dropbox root rewrite paths must be absolute");
  }

  await query(
    `update projects
     set storage_project_dir = case
           when storage_project_dir = $2 then $3
           else $3 || substring(storage_project_dir from char_length($2) + 1)
         end,
         updated_at = now()
     where client_id = $1::uuid
       and storage_project_dir is not null
       and (storage_project_dir = $2 or storage_project_dir like $2 || '/%')`,
    [args.clientId, fromRoot, toRoot]
  );

  await query(
    `update project_files pf
     set dropbox_path = case
           when pf.dropbox_path = $2 then $3
           else $3 || substring(pf.dropbox_path from char_length($2) + 1)
         end
     from projects p
     where p.id = pf.project_id
       and p.client_id = $1::uuid
       and pf.dropbox_path is not null
       and (pf.dropbox_path = $2 or pf.dropbox_path like $2 || '/%')`,
    [args.clientId, fromRoot, toRoot]
  );
}

export async function assertClientNotArchivedForMutation(
  clientId: string | null | undefined,
  messages: { archived: string; inProgress: string }
) {
  if (!clientId) {
    return;
  }

  const client = await getClientById(clientId);
  if (!client) {
    return;
  }

  if (client.archived_at) {
    throw new Error(messages.archived);
  }

  const status = (client.dropbox_archive_status ?? "idle").toLowerCase();
  if (status === "pending" || status === "in_progress") {
    throw new Error(messages.inProgress);
  }
}

export async function updateClient(
  id: string,
  args: { name: string; githubRepos?: string[]; domains?: string[] }
): Promise<ClientRecord | null> {
  const current = await getClientById(id);
  if (!current) {
    return null;
  }

  const result = await query(
    `update clients
     set name = $1,
         github_repos = $2::text[],
         domains = $3::text[]
     where id = $4::uuid
     returning *`,
    [
      args.name.trim(),
      args.githubRepos ?? current.github_repos ?? [],
      args.domains ?? current.domains ?? [],
      id
    ]
  );
  return (result.rows[0] as ClientRecord | undefined) ?? null;
}

export async function listClientsWithStats(
  filter: "active" | "archived"
): Promise<ClientWithStats[]> {
  const archivedClause =
    filter === "archived" ? "c.archived_at is not null" : "c.archived_at is null";

  const result = await query(
    `select
       c.id, c.name, c.code, c.github_repos, c.domains, c.created_at, c.archived_at,
       count(p.id) filter (where p.archived = false) as active_project_count,
       max(p.last_activity_at) filter (where p.archived = false) as last_activity_at
     from clients c
     left join projects p on p.client_id = c.id
     where ${archivedClause}
     group by c.id
     order by c.name asc`
  );

  return result.rows.map((row: Record<string, unknown>) => ({
    ...(row as unknown as ClientRecord),
    active_project_count: Number(row.active_project_count ?? 0),
    last_activity_at: (row.last_activity_at as string | null) ?? null
  }));
}

export async function getClientWithStats(
  id: string
): Promise<{ client: ClientRecord; stats: ClientDetailStats } | null> {
  const result = await query(
    `select
       c.id, c.name, c.code, c.github_repos, c.domains, c.created_at, c.archived_at,
       count(p.id) filter (where p.archived = false) as active_project_count,
       count(p.id) filter (where p.archived = true)  as archived_project_count,
       max(p.last_activity_at) filter (where p.archived = false) as last_activity_at
     from clients c
     left join projects p on p.client_id = c.id
     where c.id = $1
     group by c.id`,
    [id]
  );

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;

  const {
    active_project_count,
    archived_project_count,
    last_activity_at,
    ...client
  } = row;

  return {
    client: client as unknown as ClientRecord,
    stats: {
      activeProjectCount: Number(active_project_count ?? 0),
      archivedProjectCount: Number(archived_project_count ?? 0),
      lastActivityAt: (last_activity_at as string | null) ?? null
    }
  };
}

export async function listClientProjects(
  clientId: string,
  filter: "active" | "archived"
): Promise<ClientProjectRow[]> {
  const result = await query(
    `select id, name, status, last_activity_at, deadline, created_at
     from projects
     where client_id = $1
       and archived = $2
     order by name asc`,
    [clientId, filter === "archived"]
  );
  return result.rows as ClientProjectRow[];
}

export async function getClientTabCounts(): Promise<ClientTabCounts> {
  const result = await query(
    `select
       count(*) filter (where archived_at is null) as active,
       count(*) filter (where archived_at is not null) as archived
     from clients`
  );
  const row = result.rows[0] ?? { active: 0, archived: 0 };
  return { active: Number(row.active ?? 0), archived: Number(row.archived ?? 0) };
}

/** Same CASE as `display_name` — use for ORDER BY title / tie-breaks. */
const projectDisplayNameOrderExpr = `case
           when p.project_code is not null and length(trim(p.project_code)) > 0 then p.project_code || '-' || p.name
           else p.name
         end`;

const projectListSelectColumns = `p.*, c.name as client_name, c.code as client_code,
         ${projectDisplayNameOrderExpr} as display_name,
         (
           (select count(*)::int from discussion_threads t where t.project_id = p.id) +
           (select count(*)::int from discussion_comments dc where dc.project_id = p.id)
         ) as discussion_count,
         (select count(*)::int from project_files f where f.project_id = p.id) as file_count,
         coalesce(
           (select sum(puh.hours) from project_user_hours puh where puh.project_id = p.id),
           0
         )::numeric as total_hours`;

// billing-only: correlated JSON aggregate ordered by spec (last_name, first_name, email).
// Capped at 200 rows per project. Inner ORDER BY + LIMIT bounds the row set;
// outer json_agg ORDER BY restates the same sort to be planner-proof.
const billingUserHoursBreakdownExpr = `
  coalesce((
    select json_agg(
      row
      order by row."lastName", row."firstName", row."email", row."userId"
    )
    from (
      select
        puh.user_id                          as "userId",
        up.first_name                        as "firstName",
        up.last_name                         as "lastName",
        up.email                             as "email",
        up.avatar_url                        as "avatarUrl",
        puh.hours                            as "hours",
        lower(coalesce(up.last_name, ''))    as "lastNameKey",
        lower(coalesce(up.first_name, ''))   as "firstNameKey",
        lower(up.email)                      as "emailKey"
      from project_user_hours puh
      left join user_profiles up on up.id = puh.user_id
      where puh.project_id = p.id
      order by "lastNameKey", "firstNameKey", "emailKey", puh.user_id
      limit 200
    ) row
  ), '[]'::json) as user_hours_breakdown
`;

const billingSelectColumns = projectListSelectColumns + ", " + billingUserHoursBreakdownExpr;

export type ProjectListRow = {
  id: string;
  name: string;
  project_code: string | null;
  status: string;
  archived: boolean;
  client_id: string | null;
  client_name: string | null;
  client_code: string | null;
  display_name: string;
  discussion_count: number;
  file_count: number;
  total_hours: string;
  [key: string]: unknown;
};

export type BillingProjectWithBreakdown = ProjectListRow & {
  user_hours_breakdown: ProjectUserHours[];
};

type ListProjectsOptions = {
  clientId?: string | null;
  search?: string | null;
  /** Ignored when `search` is non-empty after trim (FTS ordering). */
  sort?: "title" | "deadline" | null;
  /**
   * When true: only non-archived projects with `status = 'billing'` (e.g. `/billing`).
   * When false/omitted: default workspace lists exclude `billing` rows.
   */
  billingOnly?: boolean;
};

function projectFtsPredicate(alias = "q") {
  return `(
           to_tsvector(
             'english',
             coalesce(p.name, '') || ' ' ||
             coalesce(p.description, '') || ' ' ||
             coalesce(p.project_code, '') || ' ' ||
             coalesce(array_to_string(p.tags, ' '), '')
           ) @@ ${alias}.tsq
           or (
             c.id is not null
             and to_tsvector('english', coalesce(c.name, '') || ' ' || coalesce(c.code, '')) @@ ${alias}.tsq
           )
           or exists (
             select 1 from discussion_threads t
             where t.project_id = p.id
               and to_tsvector('english', coalesce(t.title, '') || ' ' || coalesce(t.body_markdown, '')) @@ ${alias}.tsq
           )
           or exists (
             select 1 from discussion_comments cm
             where cm.project_id = p.id
               and to_tsvector('english', coalesce(cm.body_markdown, '')) @@ ${alias}.tsq
           )
           or exists (
             select 1 from project_files pf
             where pf.project_id = p.id
               and to_tsvector('simple', coalesce(pf.filename, '')) @@ ${alias}.tsq
           )
         )`;
}

function projectFtsRankExpr(alias = "q") {
  return `(
           ts_rank_cd(
             to_tsvector(
               'english',
               coalesce(p.name, '') || ' ' ||
               coalesce(p.description, '') || ' ' ||
               coalesce(p.project_code, '') || ' ' ||
               coalesce(array_to_string(p.tags, ' '), '')
             ),
             ${alias}.tsq
           )
           + case
               when c.id is not null then
                 ts_rank_cd(
                   to_tsvector('english', coalesce(c.name, '') || ' ' || coalesce(c.code, '')),
                   ${alias}.tsq
                 )
               else 0
             end
           + coalesce((
               select max(
                 ts_rank_cd(
                   to_tsvector('english', coalesce(t.title, '') || ' ' || coalesce(t.body_markdown, '')),
                   ${alias}.tsq
                 )
               )
               from discussion_threads t
               where t.project_id = p.id
             ), 0)
           + coalesce((
               select max(ts_rank_cd(to_tsvector('english', coalesce(cm.body_markdown, '')), ${alias}.tsq))
               from discussion_comments cm
               where cm.project_id = p.id
             ), 0)
           + coalesce((
               select max(ts_rank_cd(to_tsvector('simple', coalesce(pf.filename, '')), ${alias}.tsq))
               from project_files pf
               where pf.project_id = p.id
             ), 0)
         )`;
}

export async function listProjects(includeArchived = true, options?: ListProjectsOptions) {
  const clientId = options?.clientId?.trim() ? options.clientId : null;
  const search = (options?.search ?? "").trim();
  const sort = search.length > 0 ? null : options?.sort ?? null;
  const billingOnly = options?.billingOnly === true;

  if (search.length > 0) {
    const archivedAndBillingClause = billingOnly
      ? "and p.archived = false and p.status = 'billing'"
      : `${includeArchived ? "" : "and p.archived = false\n         "}and p.status <> 'billing'`;
    const sql = `select ${projectListSelectColumns}
       from projects p
       left join clients c on c.id = p.client_id
       cross join lateral (select plainto_tsquery('english', $1) as tsq) q
       where ($2::uuid is null or p.client_id = $2::uuid)
         ${archivedAndBillingClause}
         and ${projectFtsPredicate("q")}
       order by ${projectFtsRankExpr("q")} desc, p.created_at desc
       limit 100`;
    const result = await query(sql, [search, clientId]);
    return result.rows;
  }

  const orderBy =
    sort === "title"
      ? `lower(${projectDisplayNameOrderExpr}) asc`
      : sort === "deadline"
        ? `p.deadline asc nulls last, lower(${projectDisplayNameOrderExpr}) asc`
        : `p.created_at desc`;

  if (billingOnly) {
    // Billing list is always sorted alphabetically by project display name.
    const billingOrderBy = `lower(${projectDisplayNameOrderExpr}) asc`;
    const sql = `select ${billingSelectColumns}
       from projects p
       left join clients c on c.id = p.client_id
       where p.archived = false
         and p.status = 'billing'
         and ($1::uuid is null or p.client_id = $1::uuid)
       order by ${billingOrderBy}`;
    try {
      const result = await query(sql, [clientId]);
      return result.rows as BillingProjectWithBreakdown[];
    } catch (err) {
      if (!isMissingProjectUserHoursTableError(err)) throw err;
      // project_user_hours table not yet migrated — fall back without aggregate
      const fallbackSql = `select ${projectListSelectColumns}, '[]'::json as user_hours_breakdown
         from projects p
         left join clients c on c.id = p.client_id
         where p.archived = false
           and p.status = 'billing'
           and ($1::uuid is null or p.client_id = $1::uuid)
         order by ${billingOrderBy}`;
      const result = await query(fallbackSql, [clientId]);
      return result.rows as BillingProjectWithBreakdown[];
    }
  }

  const sql = includeArchived
    ? `select ${projectListSelectColumns}
       from projects p
       left join clients c on c.id = p.client_id
       where ($1::uuid is null or p.client_id = $1::uuid)
         and p.status <> 'billing'
       order by ${orderBy}`
    : `select ${projectListSelectColumns}
       from projects p
       left join clients c on c.id = p.client_id
       where p.archived = false
         and ($1::uuid is null or p.client_id = $1::uuid)
         and p.status <> 'billing'
       order by ${orderBy}`;
  const result = await query(sql, [clientId]);
  return result.rows;
}

/**
 * Count of non-archived projects in `billing` status. Matches
 * `listProjects(includeArchived=false, { billingOnly: true, clientId, search }).length`
 * and GET `/projects?billingOnly=true&includeArchived=false` with the same `clientId` / `search`.
 */
export async function countBillingStageProjects(options?: ListProjectsOptions) {
  const clientId = options?.clientId?.trim() ? options.clientId : null;
  const search = (options?.search ?? "").trim();

  if (search.length > 0) {
    const sql = `select count(*)::int as c
       from projects p
       left join clients c on c.id = p.client_id
       cross join lateral (select plainto_tsquery('english', $1) as tsq) q
       where ($2::uuid is null or p.client_id = $2::uuid)
         and p.archived = false and p.status = 'billing'
         and ${projectFtsPredicate("q")}`;
    const result = await query<{ c: string }>(sql, [search, clientId]);
    const raw = result.rows[0]?.c;
    return typeof raw === "number" ? raw : Number(raw ?? 0);
  }

  const sql = `select count(*)::int as c
     from projects p
     where p.archived = false
       and p.status = 'billing'
       and ($1::uuid is null or p.client_id = $1::uuid)`;
  const result = await query<{ c: string }>(sql, [clientId]);
  const raw = result.rows[0]?.c;
  return typeof raw === "number" ? raw : Number(raw ?? 0);
}

export async function listArchivedProjectsPaginated(options: {
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
  clientId?: string | null;
}) {
  const searchRaw = (options.search ?? "").trim();
  const searchLower = searchRaw.toLowerCase();
  const status = options.status ?? "all";
  const limit = Math.min(options.limit ?? 20, 100);
  const page = Math.max(options.page ?? 1, 1);
  const offset = (page - 1) * limit;
  const clientId = options.clientId?.trim() ? options.clientId : null;

  const archivedListSelect = `p.*, c.name as client_name, c.code as client_code,
       case
         when p.project_code is not null and length(trim(p.project_code)) > 0 then p.project_code || '-' || p.name
         else p.name
       end as display_name,
       (
         (select count(*)::int from discussion_threads t where t.project_id = p.id) +
         (select count(*)::int from discussion_comments dc where dc.project_id = p.id)
       ) as discussion_count,
       (select count(*)::int from project_files f where f.project_id = p.id) as file_count,
       count(*) over() as total_count`;

  const result =
    searchRaw.length > 0
      ? await query<{ total_count: string }>(
          `select ${archivedListSelect}
     from projects p
     left join clients c on c.id = p.client_id
     cross join lateral (select plainto_tsquery('english', $1) as tsq) q
     where p.archived = true
       and ($2::uuid is null or p.client_id = $2::uuid)
       and ($3 = 'all' or p.status = $3)
       and ${projectFtsPredicate("q")}
     order by ${projectFtsRankExpr("q")} desc, coalesce(p.last_activity_at, p.updated_at) desc
     limit $4 offset $5`,
          [searchRaw, clientId, status, limit, offset]
        )
      : await query<{ total_count: string }>(
          `select ${archivedListSelect}
     from projects p
     left join clients c on c.id = p.client_id
     where p.archived = true
       and ($1::uuid is null or p.client_id = $1::uuid)
       and ($2 = '' or (
         lower(p.name) like '%' || $2 || '%'
         or lower(coalesce(p.description, '')) like '%' || $2 || '%'
         or lower(coalesce(c.name, '')) like '%' || $2 || '%'
         or lower(coalesce(p.project_code, '')) like '%' || $2 || '%'
       ))
       and ($3 = 'all' or p.status = $3)
     order by coalesce(p.last_activity_at, p.updated_at) desc
     limit $4 offset $5`,
          [clientId, searchLower, status, limit, offset]
        );

  const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;
  return {
    projects: result.rows,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
}

function normalizeProjectTags(tags?: string[]) {
  if (!tags) {
    return [];
  }

  return Array.from(
    new Set(
      tags
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0)
    )
  );
}

// Process-local cache for the `projects.deadline` column existence check.
// A schema migration that adds or removes the column requires a process
// restart to refresh this value. Do not add hot-reload — column shape is
// stable across the lifetime of a single Next.js server process.
let cachedHasProjectsDeadlineColumn: boolean | null = null;
export function resetProjectsDeadlineCacheForTests(): void {
  cachedHasProjectsDeadlineColumn = null;
}
async function hasProjectsDeadlineColumn(): Promise<boolean> {
  if (cachedHasProjectsDeadlineColumn !== null) {
    return cachedHasProjectsDeadlineColumn;
  }
  const r = await query<{ exists: boolean }>(
    `select exists (
       select 1 from information_schema.columns
       where table_name = 'projects' and column_name = 'deadline'
     ) as exists`
  );
  cachedHasProjectsDeadlineColumn = r.rows[0]?.exists === true;
  return cachedHasProjectsDeadlineColumn;
}

export type CreatedProjectRow = {
  id: string;
  name: string;
  project_code: string;
  project_slug: string;
  storage_project_dir?: string | null;
  client_code?: string | null;
  [key: string]: unknown;
};

export async function createProject(args: {
  name: string;
  description?: string;
  createdBy: string;
  clientId?: string;
  tags?: string[];
  deadline?: string | null;
  requestor?: string | null;
  memberIds?: string[];
}): Promise<{
  project: CreatedProjectRow;
  skippedInactiveUserIds: string[];
  addedMemberEmails: string[];
}> {
  const projectTitle = args.name.trim();
  if (!projectTitle) {
    throw new Error("Project name is required");
  }
  if (!args.clientId) {
    throw new Error("Client is required");
  }

  const projectClient = await getClientById(args.clientId);
  if (!projectClient) {
    throw new Error("Selected client not found");
  }

  const clientSlug = slugify(projectClient.name, { strict: true }) || slugify(projectClient.code, { strict: true }) || "client";
  const projectSlug = slugify(projectTitle, { lower: true, strict: true }) || "project";
  const normalizedTags = normalizeProjectTags(args.tags);
  const deadline = typeof args.deadline === "string" ? args.deadline.trim() || null : null;
  const requestor = typeof args.requestor === "string" ? args.requestor.trim() || null : null;
  const projectsRoot = config.dropboxProjectsRootFolder();
  const valuesWithDeadline = [
    projectTitle,
    args.description ?? null,
    args.createdBy,
    args.clientId,
    projectClient.code,
    clientSlug,
    projectSlug,
    normalizedTags,
    projectsRoot,
    deadline,
    requestor
  ];
  const valuesLegacy = [...valuesWithDeadline.slice(0, 9), requestor];

  const insertWithDeadlineSql = `with lock as (
       select pg_advisory_xact_lock(hashtext('project-seq:' || $4::uuid::text))
     ),
     next_seq as (
       select coalesce(max(project_seq), 0) + 1 as seq
       from projects
       where client_id = $4::uuid
         and exists(select 1 from lock)
     )
     insert into projects (
       name, slug, description, created_by, client_id, status, project_seq, project_code, client_slug, project_slug, tags, storage_project_dir, deadline, requestor
     )
     select
       $1,
       lower($5 || '-' || lpad(next_seq.seq::text, 4, '0') || '-' || $7),
       $2,
       $3,
       $4::uuid,
       'new',
       next_seq.seq,
       $5 || '-' || lpad(next_seq.seq::text, 4, '0'),
       $6,
       $7,
       $8::text[],
       $9 || '/' || upper(trim($5)) || '/' || upper(trim($5) || '-' || lpad(next_seq.seq::text, 4, '0')) || '-' || coalesce(nullif(trim(regexp_replace(regexp_replace(trim($1), '[\\/:*?"<>|]', '', 'g'), '[[:space:]]+', ' ', 'g')), ''), 'project'),
       $10::date,
       $11
     from next_seq
     returning *`;

  const insertLegacySql = `with lock as (
       select pg_advisory_xact_lock(hashtext('project-seq:' || $4::uuid::text))
     ),
     next_seq as (
       select coalesce(max(project_seq), 0) + 1 as seq
       from projects
       where client_id = $4::uuid
         and exists(select 1 from lock)
     )
     insert into projects (
       name, slug, description, created_by, client_id, status, project_seq, project_code, client_slug, project_slug, tags, storage_project_dir, requestor
     )
     select
       $1,
       lower($5 || '-' || lpad(next_seq.seq::text, 4, '0') || '-' || $7),
       $2,
       $3,
       $4::uuid,
       'new',
       next_seq.seq,
       $5 || '-' || lpad(next_seq.seq::text, 4, '0'),
       $6,
       $7,
       $8::text[],
       $9 || '/' || upper(trim($5)) || '/' || upper(trim($5) || '-' || lpad(next_seq.seq::text, 4, '0')) || '-' || coalesce(nullif(trim(regexp_replace(regexp_replace(trim($1), '[\\/:*?"<>|]', '', 'g'), '[[:space:]]+', ' ', 'g')), ''), 'project'),
       $10
     from next_seq
     returning *`;

  // Pre-TX schema probe. Avoids reissuing SQL on a Postgres-aborted
  // transaction (would otherwise raise SQLSTATE 25P02).
  const hasDeadline = await hasProjectsDeadlineColumn();
  const insertSql = hasDeadline ? insertWithDeadlineSql : insertLegacySql;
  const insertValues = hasDeadline ? valuesWithDeadline : valuesLegacy;

  return withTransaction(async (client) => {
    const insertResult = await client.query<CreatedProjectRow>(insertSql, insertValues);
    const created = insertResult.rows[0];

    // Filter requested members to active users only. Creator is always
    // inserted regardless of active-status; if they happen to be legacy /
    // missing-email, they're still added (preserves historical invariant
    // from prior post-insert addProjectMember calls).
    const requested = Array.from(new Set([args.createdBy, ...(args.memberIds ?? [])]));
    const activeRows = await client.query<{ id: string; email: string }>(
      `select id, email from user_profiles
        where id = any($1::text[])
          and is_legacy = false
          and email is not null`,
      [requested]
    );
    const activeIds = new Set(activeRows.rows.map((r) => r.id));
    const skippedInactiveUserIds = requested.filter(
      (id) => !activeIds.has(id) && id !== args.createdBy
    );
    const toInsert = Array.from(new Set<string>([args.createdBy, ...activeIds]));
    await bulkInsertProjectMembers(client, created.id, toInsert);

    const addedMemberEmails = activeRows.rows
      .filter((r) => r.id !== args.createdBy)
      .map((r) => r.email);

    return { project: created, skippedInactiveUserIds, addedMemberEmails };
  });
}

export async function getProject(id: string, viewerUserId?: string | null) {
  try {
    const result = await query(
      `select p.*, c.name as client_name, c.code as client_code,
         case
           when p.project_code is not null and length(trim(p.project_code)) > 0 then p.project_code || '-' || p.name
           else p.name
         end as display_name,
         ${
           viewerUserId
             ? "puh.hours as my_hours"
             : "null::numeric as my_hours"
         }
       from projects p
       left join clients c on c.id = p.client_id
       ${
         viewerUserId
           ? "left join project_user_hours puh on puh.project_id = p.id and puh.user_id = $2"
           : ""
       }
       where p.id = $1`,
      viewerUserId ? [id, viewerUserId] : [id]
    );
    return result.rows[0] ?? null;
  } catch (error) {
    if (!viewerUserId || !isMissingProjectUserHoursTableError(error)) {
      throw error;
    }

    const fallback = await query(
      `select p.*, c.name as client_name, c.code as client_code,
         case
           when p.project_code is not null and length(trim(p.project_code)) > 0 then p.project_code || '-' || p.name
           else p.name
         end as display_name,
         null::numeric as my_hours
       from projects p
       left join clients c on c.id = p.client_id
       where p.id = $1`,
      [id]
    );
    return fallback.rows[0] ?? null;
  }
}

export async function getProjectUpdatedDate(id: string): Promise<{ updatedDate: string } | null> {
  const result = await query<{ updatedDate: string }>(
    `select greatest(updated_at, coalesce(last_activity_at, updated_at)) as "updatedDate"
     from projects
     where id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function updateProject(args: {
  id: string;
  name: string;
  description?: string;
  clientId: string;
  tags?: string[];
  deadline?: string | null;
  requestor?: string | null;
  /** Optional PM note; max 256 chars (enforced in DB + API). */
  pm_note?: string | null;
}) {
  const current = await getProject(args.id);
  if (!current) {
    return null;
  }
  if (current.client_id !== args.clientId) {
    throw new Error("Cannot change project client after creation");
  }

  const nextTags = args.tags === undefined ? current.tags ?? [] : normalizeProjectTags(args.tags);
  const nextDeadline =
    args.deadline === undefined
      ? typeof current.deadline === "string"
        ? current.deadline
        : current.deadline ?? null
      : typeof args.deadline === "string"
        ? args.deadline.trim() || null
        : null;
  const nextRequestor =
    args.requestor === undefined
      ? current.requestor ?? null
      : typeof args.requestor === "string"
        ? args.requestor.trim() || null
        : null;
  const currentPmNote = (current as { pm_note?: string | null }).pm_note;
  const nextPmNote =
    args.pm_note === undefined
      ? (typeof currentPmNote === "string" ? currentPmNote : null)
      : typeof args.pm_note === "string"
        ? args.pm_note.trim() || null
        : null;

  try {
    let result;
    try {
      result = await query(
        `update projects
         set name = $2,
             description = $3,
             tags = $4::text[],
             deadline = $5::date,
             requestor = $6,
             pm_note = $7,
             updated_at = now()
         where id = $1
         returning *`,
        [args.id, args.name.trim(), args.description ?? null, nextTags, nextDeadline, nextRequestor, nextPmNote]
      );
    } catch (inner) {
      if (!isMissingPmNoteColumnError(inner)) {
        throw inner;
      }
      result = await query(
        `update projects
         set name = $2,
             description = $3,
             tags = $4::text[],
             deadline = $5::date,
             requestor = $6,
             updated_at = now()
         where id = $1
         returning *`,
        [args.id, args.name.trim(), args.description ?? null, nextTags, nextDeadline, nextRequestor]
      );
    }

    const updated = result.rows[0] ?? null;
    await touchProjectActivity(args.id);
    return updated;
  } catch (error) {
    if (isMissingProjectRequestorColumnError(error)) {
      try {
        const fallback = await query(
          `update projects
           set name = $2,
               description = $3,
               tags = $4::text[],
               deadline = $5::date,
               pm_note = $6,
               updated_at = now()
           where id = $1
           returning *`,
          [args.id, args.name.trim(), args.description ?? null, nextTags, nextDeadline, nextPmNote]
        );
        const updated = fallback.rows[0] ?? null;
        await touchProjectActivity(args.id);
        return updated;
      } catch (inner) {
        if (!isMissingPmNoteColumnError(inner)) {
          throw inner;
        }
        const fallback = await query(
          `update projects
           set name = $2,
               description = $3,
               tags = $4::text[],
               deadline = $5::date,
               updated_at = now()
           where id = $1
           returning *`,
          [args.id, args.name.trim(), args.description ?? null, nextTags, nextDeadline]
        );

        const updated = fallback.rows[0] ?? null;
        await touchProjectActivity(args.id);
        return updated;
      }
    }

    if (!isMissingProjectDeadlineColumnError(error)) {
      throw error;
    }

    const fallback = await query(
      `update projects
       set name = $2,
           description = $3,
           tags = $4::text[],
           updated_at = now()
       where id = $1
       returning *`,
      [args.id, args.name.trim(), args.description ?? null, nextTags]
    );

    const updated = fallback.rows[0] ?? null;
    await touchProjectActivity(args.id);
    return updated;
  }
}

export async function touchProjectActivity(projectId: string, activityAt?: Date): Promise<void> {
  try {
    if (activityAt) {
      await query(
        `update projects
         set last_activity_at = greatest(
           coalesce(last_activity_at, '-infinity'::timestamptz),
           $2::timestamptz
         )
         where id = $1`,
        [projectId, activityAt]
      );
    } else {
      await query(
        `update projects
         set last_activity_at = greatest(
           coalesce(last_activity_at, '-infinity'::timestamptz),
           now()
         )
         where id = $1`,
        [projectId]
      );
    }
  } catch {
    // Non-critical — column may not exist if migration is pending
  }
}

export async function listProjectUserHours(projectId: string): Promise<ProjectUserHours[]> {
  try {
    const result = await query(
      `select
         puh.user_id as "userId",
         up.first_name as "firstName",
         up.last_name as "lastName",
         up.email,
         up.avatar_url as "avatarUrl",
         puh.hours
       from project_user_hours puh
       left join user_profiles up on up.id = puh.user_id
       where puh.project_id = $1
       order by coalesce(up.first_name, ''), coalesce(up.last_name, ''), up.email, puh.user_id`,
      [projectId]
    );

    return result.rows as ProjectUserHours[];
  } catch (error) {
    if (isMissingProjectUserHoursTableError(error)) {
      return [];
    }
    throw error;
  }
}

const projectExpenseLineSelectColumns = `id,
       project_id as "projectId",
       label,
       amount,
       sort_order as "sortOrder",
       created_at as "createdAt",
       updated_at as "updatedAt"`;

function parseFiniteNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateDefaultHourlyRateUsd(value: number | string | null | undefined) {
  const parsed = parseFiniteNumber(value);
  if (parsed === null || parsed < 0 || parsed > MAX_SITE_HOURLY_RATE_USD) {
    throw new Error("Default hourly rate must be between 0 and 999999.99");
  }
  return parsed;
}

function validateExpenseLineAmount(value: number | string | null | undefined) {
  const parsed = parseFiniteNumber(value);
  if (parsed === null || parsed < 0 || parsed > MAX_EXPENSE_LINE_AMOUNT_USD) {
    throw new Error("Expense amount must be between 0 and 9999999999.99");
  }
  return parsed;
}

function validateExpenseLineLabel(label: string) {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    throw new Error("Expense label is required");
  }
  return trimmedLabel;
}

export async function getSiteSettings(): Promise<SiteSettings | null> {
  try {
    try {
      const result = await query(
        `select
           site_title as "siteTitle",
           logo_url as "logoUrl",
           default_hourly_rate_usd as "defaultHourlyRateUsd"
         from site_settings
         where id = 'default'`,
        []
      );
      return (result.rows[0] as SiteSettings | undefined) ?? null;
    } catch (inner) {
      if (!isMissingSiteSettingsHourlyRateColumnError(inner)) {
        throw inner;
      }

      const fallback = await query(
        `select
           site_title as "siteTitle",
           logo_url as "logoUrl"
         from site_settings
         where id = 'default'`,
        []
      );
      const row = fallback.rows[0] as Omit<SiteSettings, "defaultHourlyRateUsd"> | undefined;
      return row
        ? {
            ...row,
            defaultHourlyRateUsd: DEFAULT_HOURLY_RATE_USD
          }
        : null;
    }
  } catch (error) {
    if (isMissingSiteSettingsTableError(error)) {
      return null;
    }
    throw error;
  }
}

export async function upsertSiteSettings(settings: SiteSettings): Promise<SiteSettings> {
  const hourlyRate = validateDefaultHourlyRateUsd(settings.defaultHourlyRateUsd ?? DEFAULT_HOURLY_RATE_USD);

  try {
    try {
      const result = await query(
        `insert into site_settings (id, site_title, logo_url, default_hourly_rate_usd)
         values ('default', $1, $2, $3)
         on conflict (id)
         do update set
           site_title = excluded.site_title,
           logo_url = excluded.logo_url,
           default_hourly_rate_usd = excluded.default_hourly_rate_usd,
           updated_at = now()
         returning
           site_title as "siteTitle",
           logo_url as "logoUrl",
           default_hourly_rate_usd as "defaultHourlyRateUsd"`,
        [settings.siteTitle, settings.logoUrl, hourlyRate]
      );
      return result.rows[0] as SiteSettings;
    } catch (inner) {
      if (!isMissingSiteSettingsHourlyRateColumnError(inner)) {
        throw inner;
      }

      const fallback = await query(
        `insert into site_settings (id, site_title, logo_url)
         values ('default', $1, $2)
         on conflict (id)
         do update set
           site_title = excluded.site_title,
           logo_url = excluded.logo_url,
           updated_at = now()
         returning
           site_title as "siteTitle",
           logo_url as "logoUrl"`,
        [settings.siteTitle, settings.logoUrl]
      );
      const row = fallback.rows[0] as Omit<SiteSettings, "defaultHourlyRateUsd">;
      return {
        ...row,
        defaultHourlyRateUsd: hourlyRate
      };
    }
  } catch (error) {
    if (!isMissingSiteSettingsTableError(error)) {
      throw error;
    }

    throw new Error("site_settings table is not available. Apply migration 0010_site_settings_and_project_deadline.sql first.");
  }
}

export async function listProjectExpenseLines(projectId: string): Promise<ProjectExpenseLine[]> {
  try {
    const result = await query<ProjectExpenseLine>(
      `select ${projectExpenseLineSelectColumns}
       from project_expense_lines
       where project_id = $1
       order by sort_order asc, created_at asc`,
      [projectId]
    );
    return result.rows;
  } catch (error) {
    if (isMissingProjectExpenseLinesTableError(error)) {
      return [];
    }
    throw error;
  }
}

export async function createProjectExpenseLine(args: {
  projectId: string;
  label: string;
  amount: number | string;
  sortOrder?: number;
}) {
  const label = validateExpenseLineLabel(args.label);
  const amount = validateExpenseLineAmount(args.amount);

  try {
    const result = await query<ProjectExpenseLine>(
      `insert into project_expense_lines (project_id, label, amount, sort_order)
       values (
         $1,
         $2,
         $3,
         coalesce(
           $4,
           (
             select coalesce(max(sort_order), -1) + 1
             from project_expense_lines
             where project_id = $1
           )
         )
       )
       returning ${projectExpenseLineSelectColumns}`,
      [args.projectId, label, amount, args.sortOrder ?? null]
    );
    await touchProjectActivity(args.projectId);
    return result.rows[0] ?? null;
  } catch (error) {
    if (!isMissingProjectExpenseLinesTableError(error)) {
      throw error;
    }

    throw new Error("project_expense_lines table is not available. Apply migration 0020_project_expense_lines.sql first.");
  }
}

export async function updateProjectExpenseLine(args: {
  id: string;
  projectId: string;
  label?: string;
  amount?: number | string;
  sortOrder?: number;
}) {
  const existing = await query<ProjectExpenseLine>(
    `select ${projectExpenseLineSelectColumns}
     from project_expense_lines
     where id = $1 and project_id = $2`,
    [args.id, args.projectId]
  );
  const current = existing.rows[0] ?? null;
  if (!current) {
    return null;
  }

  const label = args.label === undefined ? current.label : validateExpenseLineLabel(args.label);
  const amount = args.amount === undefined ? current.amount : validateExpenseLineAmount(args.amount);
  const sortOrder = args.sortOrder ?? current.sortOrder;

  const result = await query<ProjectExpenseLine>(
    `update project_expense_lines
     set label = $3,
         amount = $4,
         sort_order = $5,
         updated_at = now()
     where id = $1
       and project_id = $2
     returning ${projectExpenseLineSelectColumns}`,
    [args.id, args.projectId, label, amount, sortOrder]
  );
  await touchProjectActivity(args.projectId);
  return result.rows[0] ?? null;
}

export async function deleteProjectExpenseLine(args: { id: string; projectId: string }) {
  try {
    const result = await query<{ id: string }>(
      `delete from project_expense_lines
       where id = $1 and project_id = $2
       returning id`,
      [args.id, args.projectId]
    );
    if ((result.rows[0]?.id ?? null) !== null) {
      await touchProjectActivity(args.projectId);
      return true;
    }
    return false;
  } catch (error) {
    if (!isMissingProjectExpenseLinesTableError(error)) {
      throw error;
    }

    throw new Error("project_expense_lines table is not available. Apply migration 0020_project_expense_lines.sql first.");
  }
}

export async function setProjectUserHours(args: {
  projectId: string;
  userId: string;
  hours: number | null;
}) {
  if (args.hours === null) {
    await query("delete from project_user_hours where project_id = $1 and user_id = $2", [args.projectId, args.userId]);
    return null;
  }

  const result = await query(
    `insert into project_user_hours (project_id, user_id, hours)
     values ($1, $2, $3)
     on conflict (project_id, user_id)
     do update set hours = excluded.hours, updated_at = now()
     returning *`,
    [args.projectId, args.userId, args.hours]
  );
  return result.rows[0] ?? null;
}

export function isMissingProjectUserHoursTableError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return /project_user_hours/i.test(error.message) && /does not exist|undefined table/i.test(error.message);
}

function isMissingProjectRequestorColumnError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return /requestor/i.test(error.message) && /does not exist|undefined column/i.test(error.message);
}

function isMissingProjectDeadlineColumnError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return /deadline/i.test(error.message) && /does not exist|undefined column/i.test(error.message);
}

function isMissingPmNoteColumnError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return /pm_note/i.test(error.message) && /does not exist|undefined column/i.test(error.message);
}

function isMissingSiteSettingsTableError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return /site_settings/i.test(error.message) && /does not exist|undefined table/i.test(error.message);
}

function isMissingSiteSettingsHourlyRateColumnError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return /default_hourly_rate_usd/i.test(error.message) && /does not exist|undefined column/i.test(error.message);
}

function isMissingProjectExpenseLinesTableError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return /project_expense_lines/i.test(error.message) && /does not exist|undefined table/i.test(error.message);
}

export async function setProjectStorageDir(id: string, storageProjectDir: string) {
  const result = await query(
    `update projects
     set storage_project_dir = $2,
         updated_at = now()
     where id = $1
     returning *`,
    [id, storageProjectDir]
  );
  return result.rows[0] ?? null;
}

export async function deleteProjectById(id: string) {
  await query("delete from projects where id = $1", [id]);
}

export async function setProjectArchivedWithStorageDir(id: string, archived: boolean, storageProjectDir: string) {
  const result = await query(
    `update projects
     set archived = $2,
         storage_project_dir = $3,
         updated_at = now()
     where id = $1
     returning *`,
    [id, archived, storageProjectDir]
  );
  return result.rows[0] ?? null;
}

export async function setProjectStatus(id: string, status: ProjectStatus) {
  const result = await query(
    `update projects
     set status = $2, updated_at = now()
     where id = $1
     returning *`,
    [id, status]
  );
  return result.rows[0] ?? null;
}

export async function addProjectMember(projectId: string, userId: string) {
  await query(
    "insert into project_members (project_id, user_id) values ($1, $2) on conflict (project_id, user_id) do nothing",
    [projectId, userId]
  );
}

export async function bulkInsertProjectMembers(
  client: PoolClient,
  projectId: string,
  userIds: string[]
): Promise<void> {
  if (userIds.length === 0) return;
  await client.query(
    `insert into project_members (project_id, user_id)
     select $1, unnest($2::text[])
     on conflict (project_id, user_id) do nothing`,
    [projectId, userIds]
  );
}

export async function removeProjectMember(projectId: string, userId: string) {
  const countResult = await query(
    "select count(*)::int as count from project_members where project_id = $1",
    [projectId]
  );
  const current = Number(countResult.rows[0]?.count ?? 0);
  if (current <= 1) {
    throw new Error("Cannot remove the last member of a project");
  }
  await query(
    "delete from project_members where project_id = $1 and user_id = $2",
    [projectId, userId]
  );
}

type ProjectMember = {
  user_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  added_at: Date;
};

export async function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  const result = await query<ProjectMember>(
    `select up.id as user_id,
            up.email,
            up.first_name,
            up.last_name,
            min(pm.added_at) as added_at
       from project_members pm
       join user_profiles up on up.id = pm.user_id
      where pm.project_id = $1
        and up.is_legacy = false
        and up.email is not null
   group by up.id, up.email, up.first_name, up.last_name
   order by min(pm.added_at) asc`,
    [projectId]
  );
  return result.rows as ProjectMember[];
}

export async function listProjectMemberRecipients(
  projectId: string,
  excludeUserId: string
): Promise<NotificationRecipient[]> {
  const result = await query<{
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
  }>(
    `select up.id, up.email, up.first_name, up.last_name
       from project_members pm
       join user_profiles up on up.id = pm.user_id
      where pm.project_id = $1
        and pm.user_id <> $2
        and up.is_legacy = false
        and up.email is not null`,
    [projectId, excludeUserId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name
  }));
}

export async function listThreads(projectId: string) {
  const result = await query(
    `select
       discussion_threads.*,
       latest_comment.latest_comment_updated_at,
       greatest(
         discussion_threads.created_at,
         discussion_threads.updated_at,
         coalesce(latest_comment.latest_comment_updated_at, discussion_threads.updated_at, discussion_threads.created_at)
       ) as activity_updated_at,
       user_profiles.email as starter_email,
       user_profiles.first_name as starter_first_name,
       user_profiles.last_name as starter_last_name
     from discussion_threads
     left join lateral (
       select max(discussion_comments.updated_at) as latest_comment_updated_at
       from discussion_comments
       where discussion_comments.project_id = discussion_threads.project_id
         and discussion_comments.thread_id = discussion_threads.id
     ) latest_comment on true
     left join user_profiles on user_profiles.id = discussion_threads.author_user_id
     where discussion_threads.project_id = $1
     order by activity_updated_at desc`,
    [projectId]
  );
  return result.rows;
}

export async function createThread(args: {
  projectId: string;
  title: string;
  bodyMarkdown: string;
  authorUserId: string;
  /** When set (e.g. BC2 migration), row `created_at` / `updated_at` use this instant. */
  sourceCreatedAt?: Date | null;
}) {
  const bodyHtml = renderMarkdown(args.bodyMarkdown);
  const sourceTs = args.sourceCreatedAt ?? null;
  const result = await query(
    `insert into discussion_threads (
       project_id, title, body_markdown, body_html, author_user_id,
       created_at, updated_at
     )
     values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), coalesce($6::timestamptz, now()))
     returning *`,
    [args.projectId, args.title, args.bodyMarkdown, bodyHtml, args.authorUserId, sourceTs]
  );
  await touchProjectActivity(args.projectId, args.sourceCreatedAt ?? undefined);
  return result.rows[0];
}

export async function editThread(args: {
  projectId: string;
  threadId: string;
  title: string;
  bodyMarkdown: string;
}) {
  const bodyHtml = renderMarkdown(args.bodyMarkdown);
  const result = await query(
    `update discussion_threads set
            title = $1,
            body_markdown = $2,
            body_html = $3,
            edited_at = now()
      where id = $4 and project_id = $5
      returning id, title, body_markdown, body_html, edited_at`,
    [args.title, args.bodyMarkdown, bodyHtml, args.threadId, args.projectId]
  );
  return result.rows[0];
}

export async function countNonAuthorComments(args: {
  projectId: string;
  threadId: string;
  authorUserId: string;
}) {
  const result = await query<{ c: string }>(
    `select count(*)::int as c
       from discussion_comments
      where project_id = $1
        and thread_id = $2
        and author_user_id <> $3`,
    [args.projectId, args.threadId, args.authorUserId]
  );
  const raw = result.rows[0]?.c;
  return typeof raw === "number" ? raw : Number(raw ?? 0);
}

export async function deleteThread(args: { projectId: string; threadId: string }) {
  await query(
    `delete from discussion_threads where id = $1 and project_id = $2`,
    [args.threadId, args.projectId]
  );
  await touchProjectActivity(args.projectId);
}

export async function getThread(projectId: string, threadId: string) {
  const threadResult = await query(
    `select
       discussion_threads.*,
       user_profiles.email as starter_email,
       user_profiles.first_name as starter_first_name,
       user_profiles.last_name as starter_last_name
     from discussion_threads
     left join user_profiles on user_profiles.id = discussion_threads.author_user_id
     where discussion_threads.project_id = $1 and discussion_threads.id = $2`,
    [projectId, threadId]
  );
  const thread = threadResult.rows[0] ?? null;
  if (!thread) {
    return null;
  }

  const commentsResult = await query(
    `select
       discussion_comments.*,
       user_profiles.email as author_email,
       user_profiles.first_name as author_first_name,
       user_profiles.last_name as author_last_name
     from discussion_comments
     left join user_profiles on user_profiles.id = discussion_comments.author_user_id
     where discussion_comments.project_id = $1 and discussion_comments.thread_id = $2
     order by discussion_comments.created_at asc`,
    [projectId, threadId]
  );

  const attachmentsResult = await query(
    `select id, project_id, thread_id, comment_id, filename, mime_type, size_bytes, thumbnail_url, created_at
     from project_files
     where project_id = $1 and thread_id = $2
     order by created_at asc`,
    [projectId, threadId]
  );

  const filesByComment = new Map<string, typeof attachmentsResult.rows>();
  const threadAttachments: typeof attachmentsResult.rows = [];
  for (const attachment of attachmentsResult.rows) {
    const normalizedAttachment = normalizeProjectFileSizeRow(attachment);
    const commentId = String(attachment.comment_id ?? "");
    if (!commentId) {
      threadAttachments.push(normalizedAttachment);
      continue;
    }
    const current = filesByComment.get(commentId) ?? [];
    current.push(normalizedAttachment);
    filesByComment.set(commentId, current);
  }

  return {
    ...thread,
    threadAttachments,
    comments: commentsResult.rows.map((comment) => ({
      ...comment,
      attachments: filesByComment.get(String(comment.id)) ?? []
    }))
  };
}

export async function getComment(projectId: string, threadId: string, commentId: string) {
  const result = await query(
    `select *
     from discussion_comments
     where project_id = $1 and thread_id = $2 and id = $3`,
    [projectId, threadId, commentId]
  );
  return result.rows[0] ?? null;
}

export async function createComment(args: {
  projectId: string;
  threadId: string;
  bodyMarkdown: string;
  authorUserId: string;
  /** When set (e.g. BC2 migration), row `created_at` / `updated_at` use this instant. */
  sourceCreatedAt?: Date | null;
}) {
  const bodyHtml = renderMarkdown(args.bodyMarkdown);
  const sourceTs = args.sourceCreatedAt ?? null;
  const result = await query(
    `insert into discussion_comments (
       project_id, thread_id, body_markdown, body_html, author_user_id,
       created_at, updated_at
     )
     values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), coalesce($6::timestamptz, now()))
     returning *`,
    [args.projectId, args.threadId, args.bodyMarkdown, bodyHtml, args.authorUserId, sourceTs]
  );
  await touchProjectActivity(args.projectId, args.sourceCreatedAt ?? undefined);
  return result.rows[0];
}

export async function editComment(args: {
  projectId: string;
  threadId: string;
  commentId: string;
  bodyMarkdown: string;
}) {
  const bodyHtml = renderMarkdown(args.bodyMarkdown);
  const result = await query(
    `update discussion_comments
     set body_markdown = $4, body_html = $5, edited_at = now(), updated_at = now()
     where project_id = $1 and thread_id = $2 and id = $3
     returning *`,
    [args.projectId, args.threadId, args.commentId, args.bodyMarkdown, bodyHtml]
  );
  return result.rows[0] ?? null;
}

export async function listFiles(projectId: string) {
  const result = await query(
    "select * from project_files where project_id = $1 order by created_at desc",
    [projectId]
  );
  return result.rows.map((row) => normalizeProjectFileSizeRow(row));
}

/**
 * Insert a project_files row. Returns the inserted row, or null only if the
 * insert was rejected (no row exists in the database). Callers can rely on:
 * if the return is non-null, the row is persisted.
 */
export async function createFileMetadata(args: {
  projectId: string;
  uploaderUserId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  dropboxFileId: string;
  dropboxPath: string;
  checksum: string;
  threadId?: string | null;
  commentId?: string | null;
  thumbnailUrl?: string | null;
  /** Basecamp 2 attachment id — stored when `thumbnail_url` column exists (migration 0022). */
  bcAttachmentId?: string | null;
  /** When set (e.g. BC2 migration), row `created_at` uses this instant. */
  sourceCreatedAt?: Date | null;
}) {
  const sourceTs = args.sourceCreatedAt ?? null;
  const bcId = args.bcAttachmentId ?? null;
  const values = [
    args.projectId,
    args.uploaderUserId,
    args.filename,
    args.mimeType,
    args.sizeBytes,
    args.dropboxFileId,
    args.dropboxPath,
    args.checksum,
    args.threadId ?? null,
    args.commentId ?? null,
    args.thumbnailUrl ?? null,
    bcId,
    sourceTs
  ];

  try {
    const result = await query(
      `insert into project_files (
        project_id, uploader_user_id, filename, mime_type, size_bytes,
        dropbox_file_id, dropbox_path, checksum,
        thread_id, comment_id, thumbnail_url, bc_attachment_id, created_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, coalesce($13::timestamptz, now()))
       returning *`,
      values
    );
    const file = result.rows[0] ? normalizeProjectFileSizeRow(result.rows[0]) : null;
    await touchProjectActivity(args.projectId, args.sourceCreatedAt ?? undefined);
    return file;
  } catch (error) {
    if (!isMissingProjectFileColumnError(error)) {
      throw error;
    }

    try {
      const result = await query(
        `insert into project_files (
          project_id, uploader_user_id, filename, mime_type, size_bytes,
          dropbox_file_id, dropbox_path, checksum, thread_id, comment_id,
          created_at
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11::timestamptz, now()))
         returning *`,
        [...values.slice(0, 10), sourceTs]
      );
      const file = result.rows[0] ? normalizeProjectFileSizeRow(result.rows[0]) : null;
      await touchProjectActivity(args.projectId, args.sourceCreatedAt ?? undefined);
      return file;
    } catch (legacyError) {
      if (!isMissingProjectFileColumnError(legacyError)) {
        throw legacyError;
      }

      if (args.threadId || args.commentId) {
        throw new Error("Comment attachments require database migration 0007_comment_attachments.sql");
      }

      const result = await query(
        `insert into project_files (
          project_id, uploader_user_id, filename, mime_type, size_bytes,
          dropbox_file_id, dropbox_path, checksum, created_at
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()))
         returning *`,
        [...values.slice(0, 8), sourceTs]
      );
      const file = result.rows[0] ? normalizeProjectFileSizeRow(result.rows[0]) : null;
      await touchProjectActivity(args.projectId, args.sourceCreatedAt ?? undefined);
      return file;
    }
  }
}

export async function getFileById(projectId: string, fileId: string) {
  const result = await query(
    "select * from project_files where project_id = $1 and id = $2",
    [projectId, fileId]
  );
  return result.rows[0] ? normalizeProjectFileSizeRow(result.rows[0]) : null;
}

export async function setFileThumbnailUrl(args: {
  projectId: string;
  fileId: string;
  thumbnailUrl: string | null;
}) {
  const result = await query(
    `update project_files
     set thumbnail_url = $3
     where project_id = $1 and id = $2
     returning *`,
    [args.projectId, args.fileId, args.thumbnailUrl]
  );
  return result.rows[0] ? normalizeProjectFileSizeRow(result.rows[0]) : null;
}

export async function upsertThumbnailJob(args: { projectFileId: string }) {
  const existing = await query(
    `select id, project_file_id, status, attempt_count, next_attempt_at, last_error, created_at, updated_at
     from thumbnail_jobs
     where project_file_id = $1
     limit 1`,
    [args.projectFileId]
  );
  const current = existing.rows[0] as
    | {
        id: string;
        project_file_id: string;
        status: string;
        attempt_count: number;
        next_attempt_at: string;
        last_error: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!current) {
    const inserted = await query(
      `insert into thumbnail_jobs (project_file_id, status, attempt_count, next_attempt_at, last_error)
       values ($1, 'queued', 0, now(), null)
       returning id, project_file_id, status, attempt_count, next_attempt_at, last_error, created_at, updated_at`,
      [args.projectFileId]
    );
    return {
      action: "inserted" as const,
      job: inserted.rows[0] as NonNullable<typeof current>
    };
  }

  if (current.status === "permanent_failure") {
    return {
      action: "permanent_failure" as const,
      job: current
    };
  }

  if (current.status === "queued" || current.status === "processing") {
    const updatedAt = new Date(current.updated_at);
    const staleMs = 10 * 60 * 1000; // 10 minutes
    const isStale = Date.now() - updatedAt.getTime() > staleMs;

    if (!isStale) {
      const deduped = await query(
        `update thumbnail_jobs
         set updated_at = now()
         where project_file_id = $1
         returning id, project_file_id, status, attempt_count, next_attempt_at, last_error, created_at, updated_at`,
        [args.projectFileId]
      );
      return {
        action: "deduped" as const,
        job: deduped.rows[0] as NonNullable<typeof current>
      };
    }
  }

  const restarted = await query(
    `update thumbnail_jobs
     set status = 'queued',
         attempt_count = 0,
         next_attempt_at = now(),
         last_error = null,
         updated_at = now()
     where project_file_id = $1
     returning id, project_file_id, status, attempt_count, next_attempt_at, last_error, created_at, updated_at`,
    [args.projectFileId]
  );
  return {
    action: "inserted" as const,
    job: restarted.rows[0] as NonNullable<typeof current>
  };
}

export async function completeThumbnailJob(args: { projectFileId: string }) {
  await query(
    `update thumbnail_jobs
     set status = 'succeeded',
         last_error = null,
         updated_at = now()
     where project_file_id = $1`,
    [args.projectFileId]
  );
}

export async function failThumbnailJob(args: {
  projectFileId: string;
  error: string;
  permanent: boolean;
}) {
  const status = args.permanent ? "permanent_failure" : "failed";
  await query(
    `update thumbnail_jobs
     set status = $2,
         last_error = $3,
         attempt_count = attempt_count + 1,
         updated_at = now()
     where project_file_id = $1`,
    [args.projectFileId, status, args.error.slice(0, 1000)]
  );
}

function isMissingProjectFileColumnError(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { code?: string; message?: string };
  if (candidate.code === "42703") {
    return true;
  }

  const message = candidate.message?.toLowerCase() ?? "";
  return (
    message.includes('column "thread_id"') ||
    message.includes('column "comment_id"') ||
    message.includes('column "thumbnail_url"') ||
    message.includes('column "bc_attachment_id"') ||
    message.includes("project_files.thread_id") ||
    message.includes("project_files.comment_id") ||
    message.includes("project_files.thumbnail_url") ||
    message.includes("project_files.bc_attachment_id")
  );
}
