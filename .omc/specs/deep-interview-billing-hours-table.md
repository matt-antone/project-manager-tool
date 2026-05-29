# Deep Interview Spec: Per-project user-hours table on billing page

## Metadata
- Interview ID: di-billing-hours-table-2026-05-21
- Rounds: 5 (Round-0 topology + 4 ambiguity rounds incl. 1 Contrarian)
- Final Ambiguity Score: ~15%
- Type: brownfield
- Generated: 2026-05-21
- Threshold: 20%
- Initial Context Summarized: no
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.95 | 0.35 | 0.3325 |
| Constraint Clarity | 0.92 | 0.25 | 0.2300 |
| Success Criteria | 0.55 | 0.25 | 0.1375 |
| Context Clarity | 0.95 | 0.15 | 0.1425 |
| **Total Clarity** | | | **0.8425** |
| **Ambiguity** | | | **0.1575** |

## Topology
| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| per-project-hours-table | active | Per-project user-hours breakdown table embedded in each billing row in a responsive 2-column layout | Covers data fetch (extend payload) + UI rendering inside `billing-project-row.tsx` |

## Goal
On `/billing`, every billing project row uses a responsive **2-column layout**: existing row content on the left, a per-project user-hours table on the right. The hours table lists each user (sorted by last name ASC, then first name ASC) who has a row in `project_user_hours` for that project, showing their display name and their `hours` value. A final row labeled "Total" sums the hours for the project. Layout collapses to a single stacked column at viewports `< 768px` (Tailwind `md` breakpoint); the hours table appears below the existing content on mobile. Side-by-side split at ≥768px is **50/50**. Projects with zero `project_user_hours` rows render no table; the row reverts to its existing single-column layout. The table is always expanded inline — no collapse toggle.

## Constraints
- Data source: existing `project_user_hours` table joined to `user_profiles` (first_name + last_name).
- Display name: `"{first_name} {last_name}".trim()`; fall back to `email` if both name parts are null.
- Sort: last_name ASC, first_name ASC, ties broken by email.
- Render only users that have a `project_user_hours` row for the project (`hours = 0` still included if a row exists).
- Layout: 2 columns at `md:` (≥768px), 50/50 split, content left, hours right.
- Layout: stacked single column below `md:` — hours table renders beneath content.
- Always-expanded inline display; no toggle, no row cap.
- No new editing UI — read-only display only. Existing `my-hours` / `archived-hours` PATCH flows untouched.
- Hours total must equal the existing `total_hours` value on the billing row (shared SUM source — testable invariant).
- Empty case: when the project has 0 `project_user_hours` rows, the right column is omitted; the row collapses to its current single-column rendering at all breakpoints.

## Non-Goals
- Inline editing of per-user hours on the billing page.
- Collapsible / lazy-rendered rows.
- A separate API endpoint dedicated to the billing breakdown (prefer extending the existing `/projects?billingOnly=true` payload).
- Pagination, virtualization, or row caps.
- Changes to the `project_user_hours` schema or to archived-hours semantics.
- Showing users with no `project_user_hours` row (e.g. project_members without hours).
- Configurable breakpoint or split — fixed at `md` / 50-50.

## Acceptance Criteria
- [ ] On `/billing`, every billing project row that has ≥1 `project_user_hours` entry renders a 2-column layout at viewports ≥768px: existing content left, hours table right, 50/50 width split.
- [ ] At viewports <768px, the same row renders stacked single-column: existing content first, hours table below it.
- [ ] The hours table contains columns `Name` and `Hours`.
- [ ] User rows are sorted by `last_name ASC, first_name ASC` (email as final tiebreaker).
- [ ] Display name is `"{first_name} {last_name}".trim()`, falling back to `email` when both name parts are empty.
- [ ] Hour values match `project_user_hours.hours` exactly (formatting consistent with existing `total_hours` display).
- [ ] A final `Total` row appears with the SUM of all displayed user hours, equal to the existing `total_hours` value on the billing row.
- [ ] When a project has zero `project_user_hours` rows: no right column at any breakpoint; row renders identically to today's billing-row layout.
- [ ] The hours table is always expanded — no toggle, chevron, or expand/collapse interaction.
- [ ] No new write endpoints are added; `my-hours` and `archived-hours` PATCH flows behave identically.
- [ ] Visual style matches existing billing typography and component patterns in `components/projects/`.
- [ ] Existing `/billing` regressions: missing-hours badge still appears when applicable; tags, description, client info still render correctly within the new left column.

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| "Table of hours" implies many columns | Round 1 asked columns | Name + Hours only |
| Always-expanded scales fine on long billing page | Round 4 Contrarian (20+ projects × 3-5 users) | Confirmed always expanded |
| Every project should render a table even when empty | Round 3 asked empty state | Hide table entirely; row reverts to single-col |
| Sort order obvious from "users who logged hours" | Round 3 asked sort | Name ASC (last, then first) |
| Inline editing should be part of scope | Round 0 offered inline-edit | Out of scope — display only |
| Layout was vertical inline under content | User correction mid-interview added 2-col side-by-side | Round 5 resolved breakpoint + split |
| Side-by-side at all sizes is fine | Round 5 asked mobile behavior | Stack at <768px |

## Technical Context
Brownfield repo facts (from `explore` agent):
- Billing UI entry: `app/billing/page.tsx` → wraps `components/projects/projects-billing.tsx` in `ProjectsWorkspaceProvider`.
- Data fetch idiom: `ProjectsBilling` (client) calls `authedJsonFetch({ path: "/projects?billingOnly=true&includeArchived=false" })` → `app/projects/route.ts` GET → `listProjects(...)` in `lib/repositories.ts`.
- Row component: `components/projects/billing-project-row.tsx` currently renders `display_name`/`name`, `client_name`/`client_code`, `description`, `tags`, `total_hours`, and a "missing hours" badge.
- Hours table: `project_user_hours(project_id uuid, user_id text, hours numeric, created_at, updated_at)` — PK `(project_id, user_id)` — migration `supabase/migrations/0009_project_user_hours.sql`.
- User identity: `user_profiles(id text PK, email, first_name, last_name, avatar_url)` — migration `0004_user_profiles.sql`.
- Existing helper: `listProjectUserHours(projectId)` in `lib/repositories.ts` returns `[{ userId, firstName, lastName, email, avatarUrl, hours }]`. Reuse it.
- `total_hours` on a billing row is a correlated subquery `SUM(project_user_hours.hours)` in `projectListSelectColumns` — the new Total row must equal this value.
- Tailwind is the styling system (Next.js 15 + standard `@tailwindcss/...`); `md:` breakpoint is 768px.

Recommended data path:
- Extend `listProjects(... billingOnly: true ...)` payload to include `user_hours_breakdown: ProjectUserHours[]` per row — single round-trip. Alternative per-row fetch (N requests) is discouraged on a billing page with many projects.

Recommended layout primitive:
- Wrap existing row body and the new hours table in a `flex flex-col md:flex-row md:gap-X` container with each child set to `md:basis-1/2 md:flex-1` (or `grid grid-cols-1 md:grid-cols-2`). Render the right column conditionally on `user_hours_breakdown.length > 0`.

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| Project | core domain | id, display_name, client_code, total_hours, status | Project has many ProjectUserHours |
| User (user_profiles) | core domain | id, email, first_name, last_name, avatar_url | User has many ProjectUserHours |
| ProjectUserHours | core domain | project_id, user_id, hours, created_at, updated_at | Joins Project ↔ User; PK (project_id, user_id) |
| BillingRow | UI surface | display_name, client_name, tags, total_hours, hours_breakdown, layout (2-col responsive) | Renders one Project + its ProjectUserHours list |

## Ontology Convergence
| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 0 | 3 | 3 | - | - | N/A |
| 1 | 4 (+BillingRow) | 1 | 0 | 3 | 75% |
| 2 | 4 | 0 | 0 | 4 | 100% |
| 3 | 4 | 0 | 0 | 4 | 100% |
| 4 | 4 | 0 | 0 | 4 | 100% |
| 5 | 4 | 0 | 1 (BillingRow gained `layout`) | 3 | 100% (rename/extend counts as stable) |

Ontology stable since Round 2; Round 5 extended `BillingRow` with layout fields, no new entities.

## Interview Transcript
<details>
<summary>Full Q&A (5 rounds + 1 mid-interview user constraint addition)</summary>

### Round 0 — Topology
**Q:** Reading scope as 1 top-level component: "Per-project user-hours breakdown table embedded in each billing row." Right shape?
**A:** Yes, 1 component.

### Round 1 — Goal (columns)
**Q:** What columns does each user row show?
**A:** Name + Hours only.

### Round 2 — Constraints (display affordance)
**Q:** How is the hours table displayed in each billing row?
**A:** Always expanded inline.

### Round 3 — Goal+Constraints (empty + sort)
**Q1:** When a project has 0 users with logged hours, what shows?
**A1:** Hide the table entirely.
**Q2:** How are user rows sorted?
**A2:** Name ascending.

### Round 4 — Contrarian (always-expanded scale check)
**Q:** With 20+ projects × 3-5 users each, is always-expanded still right?
**A:** Keep always expanded.

### User constraint addition (mid-interview)
> "Let's locate the table to the right of the content making each project a 2-column layout that collapses on mobile."

### Round 5 — Constraints (breakpoint + split)
**Q1:** Breakpoint for collapsing 2-col → stacked?
**A1:** Tailwind `md` (768px).
**Q2:** Column-width split when side-by-side?
**A2:** 50 / 50.

</details>

## Status: pending approval
