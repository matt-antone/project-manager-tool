# Clients Pages

Date: 2026-05-13
Status: design

## Goal

Add two read-focused pages so any authenticated member can browse clients and drill into a client's projects.

- `/clients` — list all clients, split into Active / Archived tabs, with at-a-glance stats per row.
- `/clients/[id]` — show a client's profile and their projects, split into Active / Archived tabs.

Editing client metadata is reachable from the detail page via an inline modal that reuses the existing client form.

## Scope

In scope:

- New routes `app/clients/page.tsx` and `app/clients/[id]/page.tsx` as client components, following the existing app pattern (bootstrap + `authedJsonFetch`).
- New repository functions for stats aggregation.
- New GET API endpoints to serve those repository functions to the client:
  - `GET /clients?stats=1` — clients + stats.
  - `GET /clients/[id]?stats=1` — client + counts + last activity.
  - `GET /clients/[id]/projects?filter=active|archived` — projects for client.
- New components under `components/clients/`.
- A `Clients` link in `app/header.tsx`.
- Inline client edit dialog on the detail page, wrapping the existing settings client form.

Out of scope:

- Schema changes (none needed).
- Sort / search / pagination on tables.
- Admin-only gating (all authenticated members can view).

## Permissions

Authenticated members only. Uses existing `lib/server-auth.ts`; unauthenticated visitors are redirected to login. No role check beyond authentication.

## Routes

### `app/clients/page.tsx`

- Client component (`"use client"`). Same auth bootstrap as `app/settings/page.tsx` (uses `fetchAuthSession` and `authedJsonFetch`).
- Local state `tab: 'active' | 'archived'` syncs to `?tab=` via `useRouter`/`useSearchParams`. Invalid values fall back to `active`.
- On mount and on `tab` change: calls `GET /clients?stats=1` once (returns both active and archived rows + counts), partitions them client-side for the visible tab.
- Renders header (`<h1>Clients</h1>`), `<ClientTabs />`, and `<ClientsTable rows={...} />`.

### `app/clients/[id]/page.tsx`

- Client component (`"use client"`). Reads `[id]` from `useParams`; reads `?tab=` from `useSearchParams` (default `active`, invalid → `active`).
- On mount: calls `GET /clients/[id]?stats=1`. On 404, renders an inline "Client not found" state. On other errors, an error message + retry button.
- On `tab` change: calls `GET /clients/[id]/projects?filter=<tab>`.
- Renders `<ClientHeader client={...} counts={...} lastActivityAt={...} onEdit={...} />`, `<ClientTabs counts={...} />`, `<ClientProjectsTable rows={...} />`, and a `<ClientEditDialog />` mounted hidden until Edit is clicked.

## Navigation

Add a `Clients` link to `app/header.tsx`, placed alongside existing top-level links (Projects, Feeds, Settings — exact position chosen during implementation to match design).

## Data model

No schema changes. Tables used:

- `clients` — `id`, `name`, `archived_at`, `github_repos` (text[]), `domains` (text[]).
- `projects` — `id`, `client_id`, `name`, `archived`, `status`, `last_activity_at` (from migration 0016), `deadline` (from migration 0010), `created_at`.
- No hours column for v1. The only hours table (`project_user_hours`) is a cumulative per-user/project total without a date axis, so calendar-YTD cannot be computed honestly. Revisit when a per-day hours log exists.

## API routes

### `GET /clients?stats=1`

Modify existing `app/clients/route.ts` GET handler. When `?stats=1` is present:

- Returns `{ active: ClientWithStats[], archived: ClientWithStats[], counts: { active: number, archived: number } }`.
- Auth: existing `requireUser`.
- Without `?stats=1`, behavior unchanged (returns plain `{ clients }` for backward compatibility with the settings page).

### `GET /clients/[id]?stats=1`

Modify existing `app/clients/[id]/route.ts` GET handler. When `?stats=1` is present:

- Returns `{ client: ClientRecord, stats: { activeProjectCount: number, archivedProjectCount: number, lastActivityAt: string | null } }`.
- 404 when client not found.
- Without `?stats=1`, behavior unchanged.

### `GET /clients/[id]/projects?filter=active|archived`

New route `app/clients/[id]/projects/route.ts`.

- Auth: `requireUser`.
- Validates `filter` with zod (`z.enum(['active', 'archived'])`); invalid → 400.
- Returns `{ projects: ProjectRow[] }`. Empty array if none.

## Repository functions

All added to `lib/repositories.ts` (or a new `lib/clients-repository.ts` if the file is already crowded — pick during implementation).

### `listClientsWithStats(filter: 'active' | 'archived'): Promise<ClientWithStats[]>`

```sql
select
  c.id,
  c.name,
  c.archived_at,
  count(p.id) filter (where p.archived = false) as active_project_count,
  max(p.last_activity_at) filter (where p.archived = false) as last_activity_at
from clients c
left join projects p on p.client_id = c.id
where c.archived_at is null   -- or `is not null` for archived
group by c.id
order by c.name;
```

Returns `[]` when no rows.

### `getClientTabCounts(): Promise<{ active: number; archived: number }>`

Single query:

```sql
select
  count(*) filter (where archived_at is null) as active,
  count(*) filter (where archived_at is not null) as archived
from clients;
```

### `getClientWithStats(id: string): Promise<ClientDetail | null>`

Returns the client row plus:

- `activeProjectCount` — `count(*) filter (where archived = false)`
- `archivedProjectCount` — `count(*) filter (where archived = true)`
- `lastActivityAt` — `max(last_activity_at) filter (where archived = false)`

Returns `null` when no row, so the page can call `notFound()`.

### `listClientProjects(clientId: string, filter: 'active' | 'archived'): Promise<ProjectRow[]>`

```sql
select id, name, status, last_activity_at, deadline, created_at
from projects
where client_id = $1
  and archived = $2  -- false for active, true for archived
order by name;
```

## Components

All new components live in `components/clients/`.

### `<ClientsTable rows={ClientWithStats[]} />`

Columns: Name (link styling) · Active projects · Last activity. Whole `<tr>` is wrapped in or behaves as a Next `Link` to `/clients/[id]`. Empty state when `rows.length === 0`:

- Active tab: "No active clients."
- Archived tab: "No archived clients."

### `<ClientProjectsTable rows={ProjectRow[]} />`

Columns: Project · Status (badge) · Last activity · Due · Created. Whole row links to `/projects/[id]`. Empty state:

- Active tab: "No active projects for this client."
- Archived tab: "No archived projects for this client."

Reuses the existing project status badge component if one exists; otherwise adds an inline `<StatusBadge status={...} />` that matches app conventions.

### `<ClientTabs counts={{ active, archived }} />`

Two tab buttons rendering `Active (n)` and `Archived (n)`. Reads/writes `?tab=` on the URL using `useRouter` / `useSearchParams`. Used on both the list and detail pages.

### `<ClientHeader client counts lastActivityAt onEdit />`

Renders, top-to-bottom:

- Client name, plus an "Archived" badge when `client.archived_at != null`.
- Repos line (when `client.github_repos?.length > 0`): "Repos:" followed by each repo as a link.
- Domains line (when `client.domains?.length > 0`): "Domains:" followed by comma-separated domains.
- Stats line: "<activeCount> active · <archivedCount> archived projects · last activity <relative-time>".
- Edit button on the right that opens `<ClientEditDialog />`.

When a list is empty, the entire line is omitted (don't render "Repos:" with nothing after).

### `<ClientEditDialog client />`

A modal that reuses the form currently in `app/settings/_settings-page-content.tsx`. Plan during implementation:

1. Extract the existing form (fields, validation, submit handler) into a shared component `components/clients/client-form.tsx`.
2. Have both `_settings-page-content.tsx` and the new dialog mount that shared form.
3. The dialog calls the same `PATCH /clients/[id]` route the settings page already uses; on success it closes and revalidates the page.

If extraction proves too disruptive for this PR, fall back to keeping the dialog content as a thin wrapper that simply navigates to settings — but the goal is true inline editing.

## Display rules

- `last_activity_at` NULL — render `—`.
- `deadline` NULL — render `—`.
- Empty `github_repos` / `domains` arrays — omit that line in the header entirely.
- Archive badge in header uses the same small pill style as elsewhere in the app (`bg-amber-200 text-amber-900` or whatever the codebase pattern is).

## Error handling and edge cases

- Unauthenticated → existing redirect to login.
- Bad `[id]` (no client) → Next `notFound()`.
- Archived client detail page still loads; header shows the badge; both tabs continue to work.
- `?tab=` invalid value → fall back to `active`.
- Edit dialog save failure → surface the existing PATCH route's error response inline; modal stays open.
- Zero rows in any table → empty state copy (see component sections).

## Testing

### Repository (Vitest)

- `listClientsWithStats('active')` excludes clients with `archived_at != null`. Includes only non-archived projects in `active_project_count` and `last_activity_at`.
- `listClientsWithStats('archived')` returns only archived clients with the same stat semantics.
- `getClientTabCounts()` counts active and archived clients correctly.
- `getClientWithStats(id)` — returns `null` for unknown id; correct active/archived counts; `lastActivityAt` reflects active projects only.
- `listClientProjects(id, filter)` — filter returns correct subset; ordering by name; columns match component needs.

### Components

- `<ClientsTable />` — renders rows; empty state copy per tab; row link href; NULL `last_activity_at` rendered as `—`.
- `<ClientProjectsTable />` — status badge maps known statuses; NULL `deadline` and `last_activity_at` render `—`.
- `<ClientTabs />` — labels include counts; clicking updates `?tab=`.
- `<ClientHeader />` — archive badge shown iff `archived_at != null`; repos line omitted when array empty; domains line omitted when array empty.

### Integration / page

- `/clients` renders both tab counts; `?tab=archived` swaps the table contents.
- `/clients/[id]` renders header fields conditionally; Edit dialog opens, submits, closes.
- `/clients/<bad-id>` returns 404.

### Manual checklist

- Visit `/clients` as a non-admin authenticated user.
- Visit an archived client's detail page; confirm archive badge.
- Confirm `Clients` link visible in header nav.
- Confirm clicking a client row navigates to `/clients/[id]`.
- Confirm clicking a project row navigates to `/projects/[id]`.

## Open implementation questions (resolved during plan, not blocking design)

- Whether to extract the settings client form fully or wrap it for v1 (preference: extract).
- Existing status-badge component name — reuse or add new.
