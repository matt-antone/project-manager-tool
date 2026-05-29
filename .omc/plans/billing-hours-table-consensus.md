# Plan: Per-project user-hours table on `/billing`

- Source spec: `.omc/specs/deep-interview-billing-hours-table.md`
- Mode: consensus / direct (interview already crystallized)
- Status: pending approval (iteration 3 — Architect polish merged; Critic APPROVED)

---

## 1. RALPLAN-DR Summary (short mode)

### Principles
1. **Reuse the projection type `ProjectUserHours` (`lib/repositories.ts:31-38`); add a new SQL statement with the spec-correct sort.** The existing `listProjectUserHours` helper (`lib/repositories.ts:1027-1051`) sorts `first_name` first at `:1040` and MUST NOT be substituted for the billing breakdown — its `ORDER BY` conflicts with the spec (`last_name ASC, first_name ASC, email ASC`). The existing helper remains untouched and continues to serve non-billing callers (`my-hours`, `archived-hours`, etc.). For the billing breakdown we compose a billing-only `json_agg(... ORDER BY ...)` subquery whose internal sort matches the spec.
2. **No DB schema changes.** `project_user_hours` (`supabase/migrations/0009_project_user_hours.sql`) and `user_profiles` (`0004_user_profiles.sql`) stay as-is.
3. **Preserve the existing `/projects?billingOnly=true` contract.** `total_hours` invariant (correlated SUM in `projectListSelectColumns`, `lib/repositories.ts:413-416`) must equal the new Total row. The added field is additive only.
4. **Single round-trip on the billing page.** N-row pages must not fan out N HTTP requests, and the billing payload must come back in a single SQL statement so the Total invariant is atomic.
5. **Tailwind utility classes + the existing CSS-class idiom side-by-side.** `billing-project-row.tsx` currently uses semantic class names (`archiveProjectRow`, `archiveProjectBody`, etc.). New 2-col wrapper uses Tailwind utilities (`flex flex-col md:flex-row md:gap-6`, each child `md:basis-1/2`) without re-skinning the existing left column.
6. **Server-side sort scoped inside the new `json_agg(... ORDER BY ...)` aggregate.** The existing `listProjectUserHours` helper sorts differently (`first_name` first) and is NOT used by the billing path. The aggregate's `ORDER BY` is local to the subquery and does not affect any other call site.

### Decision Drivers (top 3)
1. **Request fan-out on a list page** — `/billing` is a list. With 20+ projects (interview Round 4), per-row fetch = 20+ HTTP requests + 20+ auth round-trips.
2. **Atomicity of the `total_hours == SUM(user_hours_breakdown[].hours)` invariant** — when both values originate from a single SQL statement, divergence is structurally impossible; with two statements, race/refresh windows can break it.
3. **Blast radius onto non-billing `/projects` consumers** — `app/projects/route.ts` is shared by `ProjectsBilling`, archive list, board, list, count routes. Any payload change must be scoped to the billing SQL branch only.

### Viable Options

#### Option A′ — Single-query `json_agg` appended to the billing-branch SELECT (RECOMMENDED)
Compose a billing-only SELECT (`billingSelectColumns = projectListSelectColumns + ", " + breakdownAggregateExpr`) where `breakdownAggregateExpr` is a correlated `json_agg(... ORDER BY ...)` returning `coalesce(..., '[]'::json)`. The shared `projectListSelectColumns` constant (`lib/repositories.ts:406-416`) is **not** mutated; only the billing branch (`:534-544`) uses the composed string. One round-trip, one SQL statement.

- **Pros**
  - 1 HTTP request, 1 SQL statement → Total invariant is atomic.
  - Shared `projectListSelectColumns` is not modified → FTS branch (`:510-525`) and default branches (`:546-560`) are byte-identical.
  - Server-side sort is scoped *inside* the `json_agg(... ORDER BY lower(up.last_name), lower(up.first_name), up.email, puh.user_id)` aggregate — no leakage to other callers and no effect on `listProjectUserHours`.
  - Empty projects naturally yield `[]` via `coalesce(json_agg(...), '[]'::json)`.
  - `LIMIT 200` inside the aggregate caps worst-case payload (see §5).
- **Cons**
  - Slightly denser SQL in the billing branch. Mitigation: extract `breakdownAggregateExpr` into a named constant adjacent to `projectListSelectColumns` with an explanatory comment.
  - The aggregate must be guarded against the missing-table error in environments where `project_user_hours` is not yet migrated (see Step 1.3).
- **Perf**: O(projects × users_per_project) rows; with the spec's 20×5 envelope ≈ 100 rows, capped at 200 per project. Negligible.
- **Surface change**: 1 new type (`BillingProjectWithBreakdown`) used **only** on the billing render path; route file unchanged.

#### Option A (two-statement enrichment) — kept as fallback
Run `listProjects` as today, then fire a second batched `SELECT ... WHERE project_id = any($1::uuid[])` keyed on the returned ids. Group on the client.

- **Pros**: Avoids changing the billing-branch SELECT shape.
- **Cons**: Two SQL statements → Total invariant is no longer atomic; a race/refresh between statements could expose divergence. Adds a second guard against the missing-table error.
- **Invalidation rationale vs A′**: A′ achieves the same payload in one statement with strictly stronger invariant atomicity at no measurable cost. Demoted to fallback only if A′ runs into a Postgres planner issue at execution time.

#### Option B — New batched route `GET /projects/billing-hours-breakdown`
Add a sibling endpoint returning `Record<project_id, ProjectUserHours[]>`. `ProjectsBilling` fires this once on mount alongside the existing `/projects` request.

- **Pros**: Zero change to `/projects` payload; other consumers untouched.
- **Cons**: 2 HTTP requests instead of 1 (auth round-trip × 2); new route file + new repo helper + new types; client must merge two payloads; Total invariant is now cross-payload and harder to defend.
- **Invalidation rationale**: `ProjectsBilling` is the only `billingOnly=true` caller (grep verified — `components/projects/projects-billing.tsx:26-34`), so the "protect other consumers" benefit is moot when we already scope the aggregate to the billing SQL branch. Eliminated.

#### Option C — Per-row lazy fetch `GET /projects/:id/user-hours`
Per-row `useEffect` fetch as the row mounts.

- **Pros**: Smallest payload per request.
- **Cons**: N requests for N projects. Spec Round 4 explicitly confirmed always-expanded for 20+ projects → 20+ requests. Spec's `## Technical Context` already calls this "discouraged".
- **Invalidation rationale**: Violates Principle 4 (single round-trip). Worst auth/network amplification. Eliminated.

### Recommendation: **Option A′**

---

## 2. Requirements Summary

**Goal**: On `/billing`, each billing row uses a responsive 2-column layout. Left = existing content (`components/projects/billing-project-row.tsx:32-60`). Right = a table of `(Name, Hours)` rows for each user with a `project_user_hours` row for that project, sorted `last_name ASC, first_name ASC, email ASC`, plus a `Total` row equal to the existing `total_hours` badge. At `< md` (768px) the right column stacks below. Projects with zero rows render the original single-column row unchanged.

**Non-goals**: schema changes, write endpoints, collapse/expand toggle, pagination, configurable breakpoint, showing project members without hours.

**Invariants**:
- `sum(user_hours_breakdown[].hours) === total_hours` per row (atomic via single SQL statement).
- `my-hours` / `archived-hours` PATCH flows unchanged.
- Sort: `last_name ASC, first_name ASC, email ASC`.
- Display name: `"{first_name} {last_name}".trim()`, fallback `email`.

---

## 3. Implementation Steps (file-by-file)

### Step 1 — Extend the repository payload (Option A′ wiring)
**File**: `lib/repositories.ts`

1. **Type re-use.** Do NOT introduce a new shape for breakdown rows. Re-use and `export` the existing local projection `ProjectUserHours` (`lib/repositories.ts:31-38`). If the helper at `:1327-1333` (`isMissingProjectUserHoursTableError`) is not exported, add `export` to its declaration so the billing branch can reuse the same predicate. If exporting is rejected during review, duplicate the predicate locally in the billing SQL guard (it is 1-3 lines).
2. **Compose a billing-only SELECT.** Adjacent to `projectListSelectColumns` (`lib/repositories.ts:406-416`), add:
   ```ts
   // billing-only: correlated JSON aggregate ordered by spec (last_name, first_name, email).
   // Capped at 200 rows per project — see plan §5.
   // NOTE: Inner subquery applies ORDER BY + LIMIT 200 to bound the row set,
   // AND the outer json_agg restates the same ORDER BY intra-aggregate so the
   // emitted JSON array is order-stable regardless of planner decisions.
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
   ```
   The inner SELECT aliases each sort key (`lastNameKey`, `firstNameKey`, `emailKey`) so the inner `ORDER BY` references the aliases directly. The outer `json_agg(row ORDER BY row."lastName", row."firstName", row."email", row."userId")` then restates the spec sort using the row's own aliased columns — making the emitted array order planner-proof. (The `*Key` columns are sort scaffolding only; they are not consumed by the UI but remain in `row` to keep the projection simple. If a future cleanup wants to strip them, wrap the inner select in a second SELECT that projects only the UI-facing columns and apply the outer ORDER BY there.)
   The shared `projectListSelectColumns` constant is unchanged.
3. **Use `billingSelectColumns` only in the billing branch.** In the `billingOnly` SQL branch (`lib/repositories.ts:534-544`), swap `projectListSelectColumns` for `billingSelectColumns` in that branch only. The FTS branch (`:510-525`) and the default branches (`:546-560`) continue to use the unchanged `projectListSelectColumns`.
4. **Missing-table guard.** Wrap the billing branch's SQL execution in a `try/catch`. On `isMissingProjectUserHoursTableError(err)` (`lib/repositories.ts:1327-1333` — definition), either:
   - **Preferred**: re-run the same SQL with `billingSelectColumns` replaced by `projectListSelectColumns + ", '[]'::json as user_hours_breakdown"` (no `project_user_hours` reference), OR
   - **Fallback**: re-run with plain `projectListSelectColumns` and inject `user_hours_breakdown: []` onto each row client-side in the repo function before returning.

   Both paths preserve the single-round-trip contract and keep the UI from blowing up on dev branches without the migration.

**Acceptance**:
- `await listProjects(false, { billingOnly: true })` returns rows whose every element has `user_hours_breakdown: ProjectUserHours[]` (possibly `[]`).
- `await listProjects(true)` (non-billing) returns rows **without** `user_hours_breakdown`.
- Sort matches the spec (`last_name ASC, first_name ASC, email ASC`).
- The aggregate is bounded: a project with > 200 user-hours rows returns only the first 200 by spec sort (see §5).

### Step 2 — API route stays unchanged
**File**: `app/projects/route.ts:19-66`

No edits required. The route already spreads whatever `listProjects` returns via `return ok({ projects })`. Confirm in code review that no `Pick<>` narrowing is applied. (Verified: line 56 is `return ok({ projects })`.)

### Step 3 — Type changes (segregated, billing-only)
**Files**: `lib/repositories.ts`, `components/projects/billing-project-row.tsx`

Do **NOT** add `user_hours_breakdown` to the shared `BillingProjectItem` type or any other shared shape consumed by board/list/archive callers.

1. **Introduce a concrete row-shape type for `listProjects`.** Code-inspection confirmed (`lib/repositories.ts:504-562`): `listProjects` currently returns `result.rows` with no named return-type alias — every branch (`:524`, `:543`, `:560-561`) returns untyped rows. There is therefore no existing `ProjectListItem` to reuse.

   Add a new exported type `ProjectListRow` in `lib/repositories.ts`, placed adjacent to `projectListSelectColumns` (`:406-416`), representing the row shape produced by that SELECT:
   ```ts
   export type ProjectListRow = {
     // mirrors `p.*` columns from `projects` plus the projected joins/aggregates
     // produced by `projectListSelectColumns` (lib/repositories.ts:406-416).
     id: string;
     name: string;
     project_code: string | null;
     status: string;
     archived: boolean;
     client_id: string | null;
     // ... remaining `projects` columns as they exist in schema ...
     client_name: string | null;
     client_code: string | null;
     display_name: string;
     discussion_count: number;
     file_count: number;
     total_hours: string; // numeric -> string via pg driver default
     // (concrete column list to be finalized against `supabase/migrations/0001_projects*.sql`
     //  and any subsequent migrations during implementation; this type is the canonical
     //  shape going forward and supersedes any ad-hoc inline shape.)
   };
   ```
   Then define the billing-only subtype as a concrete intersection (no hedge, no fallback wording):
   ```ts
   export type BillingProjectWithBreakdown = ProjectListRow & {
     user_hours_breakdown: ProjectUserHours[];
   };
   ```
   The `billingOnly` branch (`:534-544`) annotates its return as `BillingProjectWithBreakdown[]`. Non-billing branches return `ProjectListRow[]`.
2. In `components/projects/billing-project-row.tsx:8-18`, keep `BillingProjectItem` unchanged. At the **call site** in `components/projects/projects-billing.tsx`, type the incoming row narrowly:
   ```ts
   type BillingRow = BillingProjectItem & { user_hours_breakdown?: ProjectUserHours[] | null };
   ```
   and pass that to `BillingProjectRow` either via a new prop or by widening `Props.project` to `BillingProjectItem & { user_hours_breakdown?: ProjectUserHours[] | null }` strictly inside the billing render path. Other consumers of `BillingProjectItem` continue to compile and run unchanged.
3. Export `ProjectUserHours` from `lib/repositories.ts` (Step 1.1).

### Step 4 — UI: 2-column responsive layout
**File**: `components/projects/billing-project-row.tsx:32-60`

1. Widen the local `Props` (or accept a billing-narrowed type as in Step 3.2):
   ```ts
   type Props = {
     project: BillingProjectItem & { user_hours_breakdown?: ProjectUserHours[] | null };
     onArchive: (project: BillingProjectItem) => void;
     onReopen: (project: BillingProjectItem) => void;
   };
   ```
2. Compute `const breakdown = project.user_hours_breakdown ?? []` and `const hasBreakdown = breakdown.length > 0`.
3. Wrap the existing `<li className="archiveProjectRow">` body in a Tailwind flex container at the top level inside the row:
   ```tsx
   <div className="flex flex-col gap-4 md:flex-row md:gap-6">
     <div className={hasBreakdown ? "md:basis-1/2 md:min-w-0" : "md:basis-full"}>
       {/* existing left column: status pill, archiveProjectBody, archiveProjectActions */}
     </div>
     {hasBreakdown && (
       <div className="md:basis-1/2 md:min-w-0">
         <BillingProjectUserHoursTable rows={breakdown} totalHours={project.total_hours} />
       </div>
     )}
   </div>
   ```
   Empty case (`!hasBreakdown`): right column is not rendered at any breakpoint → row visually identical to today.
4. Build `BillingProjectUserHoursTable` inline at the bottom of the same file (no new file unless the file grows past ~150 LOC):
   - Renders a `<table>` with `<thead>`: `Name`, `Hours`.
   - Body rows: `displayName(row)` + formatted hours.
   - `displayName(row) = ${row.firstName ?? ""} ${row.lastName ?? ""}.trim() || row.email`.
   - **Truncation affordance**: when `rows.length === 200` (i.e. the SQL cap was hit), render a small footer note immediately below the table reading `Showing first 200 users (sorted by last name).` Use a muted style (e.g. `<p className="mt-1 text-xs text-muted-foreground">`). When `rows.length < 200`, render nothing below the table.
   - **Hours formatting (resolved open question)**: No shared `formatHours` helper exists in `lib/project-utils.ts` or anywhere under `lib/`/`components/` (grep verified). `lib/project-utils.ts:24` exposes a private `coerceHoursTotal` used only by `hasMissingHours`; there is no project-wide formatter. Furthermore, `components/projects/billing-project-row.tsx` does **not** currently render `total_hours` at all — only the `Missing hours` badge consults it via `hasMissingHours` (`:30, :38-42`). Therefore there is no existing per-row precedent to mirror.
     - **Action**: implement a tiny file-local helper
       ```ts
       const formatHours = (v: number | string | null | undefined): string =>
         (v === null || v === undefined || v === "" || Number.isNaN(Number(v)))
           ? "0.00"
           : Number(v).toFixed(2);
       ```
       and use it for both each row's hours cell and the Total row. The Total value is `formatHours(project.total_hours)` (i.e. taken from the same SQL source as the badge, not recomputed in JS) so the rendered Total cannot diverge from the existing `total_hours` invariant.
     - If a project-wide hours formatter is introduced later (e.g. via the architect review), swap this helper for the canonical one in a follow-up.
5. Do not touch `archiveProjectRow`, `archiveProjectBody`, `archiveProjectActions` semantic classes. The new Tailwind utilities sit *outside or alongside* those — no CSS rewrite.

**Acceptance**:
- At `>= 768px` and `breakdown.length > 0`: 50/50 split, right column visible.
- At `< 768px`: stacked, hours table after content.
- At any width with `breakdown.length === 0`: zero new DOM relative to current row (no right wrapper rendered).
- Total cell text equals `formatHours(project.total_hours)`.
- When breakdown is capped at 200, a footer note is rendered with text including `200` (e.g. `Showing first 200 users (sorted by last name).`). When `breakdown.length < 200`, no footer note is rendered.

### Step 5 — Wire ProjectsBilling (minor type narrow)
**File**: `components/projects/projects-billing.tsx:14-49`

With Step 1 enriching the payload, no behavioral change is needed here. The only edit (per Step 3.2) is a local type narrow on the incoming `result.projects` so each row has `user_hours_breakdown?: ProjectUserHours[] | null` in scope. If the existing `BillingProjectItem` import already typechecks through the API boundary as `unknown`/`any`, no narrowing is needed; otherwise add a single intersection type alias inside the file.

### Step 6 — Tests

1. **New unit test (route shape)**: `tests/unit/projects-billing-route-breakdown.test.ts`
   - Stub `listProjects` to assert: when called with `billingOnly: true`, returned rows include `user_hours_breakdown` (array). When called without `billingOnly`, rows don't.
2. **New unit test (repository SQL)**: extend `tests/unit/projects-billing-count-route.test.ts` or create `tests/unit/list-projects-billing-breakdown.test.ts`
   - Insert 2 projects, 3 users with hours rows split across them, 1 user with null first_name/last_name.
   - Assert: each project's `user_hours_breakdown` sorted by `last_name ASC, first_name ASC, email ASC`; `sum(hours) === total_hours`; project with 0 user hours rows returns `[]`.
   - **Cap assertion**: seed a single project with 250 user-hours rows; assert `breakdown.length === 200` and that the 200 returned rows are the spec-sort-first 200.
   - **Missing-table guard**: simulate `isMissingProjectUserHoursTableError` by dropping/renaming `project_user_hours` in a test transaction (or by stubbing) and assert all rows return `user_hours_breakdown: []` with no thrown error.
3. **Component test (optional but recommended)**: `tests/unit/billing-project-row.test.tsx` (Vitest + Testing Library)
   - Renders 2-col when breakdown present; 1-col when empty; Total row equals `formatHours(total_hours)`; mobile-class assertion via `getByRole('table')`.
   - Asserts that with `breakdown` of length 200, the table renders exactly 200 body rows + 1 Total row.

---

## 4. Acceptance Criteria (refined from spec, with verification paths)

| # | Criterion | Verification |
|---|-----------|--------------|
| 1 | At `>= 768px`, billing rows with ≥1 breakdown render 2-col, 50/50, content left, hours right. | Manual: visit `/billing` at 1440px wide. Snapshot: component test asserts `md:basis-1/2` classes present on both columns. |
| 2 | At `< 768px`, same row stacks: content above, hours below. | Manual at 375px. CSS class assertion: container has `flex-col` and lacks `md:flex-row` flow at sm breakpoint. |
| 3 | Hours table columns: `Name`, `Hours`. | Component test: assert `<th>` text nodes. |
| 4 | Sort: `last_name ASC, first_name ASC, email ASC`. | Repository SQL unit test with seeded fixtures. |
| 5 | Display name = `"{first} {last}".trim() ‖ email`. | Component test + helper unit test. |
| 6 | Hours formatting uses file-local `formatHours = (v) => Number(v).toFixed(2)`; Total cell uses `formatHours(project.total_hours)`. | Component test: assert Total text equals `Number(total_hours).toFixed(2)`. |
| 7 | `Total` row equals `project.total_hours` (formatted), which by SQL invariant equals `SUM(user_hours_breakdown[].hours)` when the breakdown is uncapped. | Repository unit test: assert invariant numerically for uncapped sets. Component test: assert Total cell text. |
| 8 | Zero-breakdown project renders identically to today's single-col row. | Snapshot test: render `BillingProjectRow` with `user_hours_breakdown: []` vs prior baseline. |
| 9 | Always-expanded inline; no toggle. | Component test: assert no `<button>`/`aria-expanded` inside hours table. |
| 10 | `my-hours` / `archived-hours` PATCH flows untouched. | grep verification: no diff in `app/projects/[id]/my-hours/**` or `app/projects/[id]/archived-hours/**`. |
| 11 | Missing hours badge still appears when applicable. | Manual + component test (badge present in left column when `hasMissingHours` true). |
| 12 | No new write endpoints. | grep `app/projects/**/route.ts` diff: only existing routes touched. |
| 13 | Payload row cap = `min(actualUsers, 200)` per project. | Repository unit test with 250-row seed. |
| 14 | When breakdown is capped at 200, a footer note is rendered below the table with text including `200`. When `breakdown.length < 200`, no footer note is rendered. | Component test: render with `rows.length === 200` and assert footer text contains `200`; render with `rows.length === 5` and assert no footer node. |

---

## 5. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Payload size if a billing project has hundreds of users. | **Hard cap of 200 rows per project**, applied inside the `json_agg` subquery via `LIMIT 200` over the spec-sorted inner SELECT. Contract: "If a project accumulates more than 200 `project_user_hours` rows, only the first 200 (by spec sort `last_name, first_name, email, user_id`) are returned. Larger sets are out of scope for V1; revisit if encountered." Realistic ceiling is small (interview Round 4: 3-5 users typical, 20+ projects). Worst-case envelope is ~5 KB JSON per page, capped at ~200 × 200 ≈ 40K rows aggregate. Unit test in §6 asserts `payload.length === min(actualUsers, 200)`. |
| Breaking other `/projects` consumers. | Aggregate scoped to the billing SQL branch only (`lib/repositories.ts:534-544`) via the locally-composed `billingSelectColumns`. The shared `projectListSelectColumns` constant (`:406-416`) is byte-identical. The new return-type alias `BillingProjectWithBreakdown` is used **only** on the billing render path; the shared `BillingProjectItem` type and all non-billing call sites are unchanged. Add a unit test asserting `user_hours_breakdown` absent when `billingOnly !== true`. |
| Tailwind class purge / unused-class warnings. | `flex flex-col md:flex-row md:gap-6 md:basis-1/2 md:min-w-0 md:basis-full` are all standard utilities; verified against Next.js 15 default Tailwind 3 config. Run `pnpm build` to confirm purge doesn't drop them (they appear inline in JSX so the JIT picks them up). |
| Locale-sensitive name sort drift. | Sort is server-side via Postgres `lower()` inside the `json_agg(... ORDER BY ...)` aggregate — deterministic, no client `Intl.Collator` divergence. |
| Total row diverges from `total_hours` badge due to rounding. | Total cell renders `formatHours(project.total_hours)` directly (NOT a JS recomputation of the breakdown sum). Since `total_hours` and breakdown rows now come from the same SQL statement, the SQL invariant cannot break mid-flight. Unit test asserts equality between Total cell and badge for fixtures < 200 users. |
| `project_user_hours` table missing on a dev branch. | Reuse `isMissingProjectUserHoursTableError` (`lib/repositories.ts:1327-1333` — definition). Wrap the billing SQL execution in a `try/catch`: on missing-table, re-run with the aggregate column replaced by `'[]'::json as user_hours_breakdown` (or inject `[]` client-side in the repo function). UI silently falls back to single-col. |
| Single-statement SQL is rejected by the Postgres planner for some unforeseen reason. | Fallback to Option A (two-statement enrichment): keep `projectListSelectColumns` unchanged in the billing branch and add a second batched `SELECT ... WHERE project_id = any($1::uuid[])`. Documented in §1 as an explicit retreat path. |
| Hooks / hook count change in `BillingProjectRow`. | The component is presentational, no hooks added — just derived constants. No effect on React strict mode. |

---

## 6. Verification Steps

1. `pnpm lint` — no new ESLint warnings.
2. `pnpm build` — Tailwind purge keeps new utilities; TypeScript narrowing on `user_hours_breakdown` passes.
3. `pnpm test` — new unit tests pass; existing `tests/unit/projects-billing-count-route.test.ts` still passes (count semantics unchanged); 200-cap test asserts payload length.
4. `pnpm dev` manual:
   - Open `/billing` at viewport ≥ 768px → confirm 2-col, 50/50, table on right, Total = badge.
   - Resize to < 768px → confirm stack with table below content.
   - Filter by a client that has a project with no logged hours → confirm that row renders as today (no right column).
   - Confirm "Missing hours" badge still appears on appropriate rows.
   - Click `Archive` / `Reopen work` → confirm unchanged behavior.
5. SQL spot-check: `select id, total_hours from projects where status='billing' limit 5;` and compare against the rendered Total values for the same projects.

---

## 7. ADR

**Title**: Embed per-project user-hours breakdown in `/projects?billingOnly=true` payload via a billing-only `json_agg` aggregate.

- **Decision**: Extend `listProjects` to attach a `user_hours_breakdown: ProjectUserHours[]` array to each row when `billingOnly: true`, via a **single SQL statement** that composes a billing-only SELECT (`billingSelectColumns = projectListSelectColumns + ", " + billingUserHoursBreakdownExpr`) where `billingUserHoursBreakdownExpr` is a correlated `json_agg(... ORDER BY lower(last_name), lower(first_name), lower(email), user_id ... LIMIT 200)` returning `coalesce(..., '[]'::json)`. The shared `projectListSelectColumns` constant is **not** mutated. Render the breakdown in `components/projects/billing-project-row.tsx` as a 2-column Tailwind layout (`flex flex-col md:flex-row`, `md:basis-1/2`).
- **Drivers**:
  1. Single round-trip on a list page with potentially 20+ rows AND atomic Total invariant (single SQL statement).
  2. Preserve existing `total_hours` invariant via the same SQL source.
  3. Minimize blast radius to non-billing `/projects` consumers — the shared SELECT constant and `BillingProjectItem` shared type are both untouched.
- **Alternatives considered**:
  - **Option A (two-statement enrichment)**: kept as a retreat fallback. Rejected as the default because two statements make the Total invariant non-atomic and add a second missing-table guard, with no compensating benefit when the aggregate is already scoped to a billing-only SELECT.
  - **Option B (dedicated batched route)**: rejected — adds 1 extra HTTP request and 1 extra repo function for no benefit when `ProjectsBilling` is the only `billingOnly=true` caller and the aggregate is scoped to a billing-only SELECT.
  - **Option C (per-row lazy fetch)**: rejected — fan-out scales linearly with project count; spec's Technical Context explicitly discouraged it.
- **Why chosen**: Lowest cost, lowest blast radius, atomic invariant, server-side spec-correct sort scoped to a billing-only aggregate, reuses existing error guard (`isMissingProjectUserHoursTableError` at `lib/repositories.ts:1327-1333`).
- **Consequences**:
  - `/projects?billingOnly=true` payload grows by O(min(users_with_hours_per_billing_project, 200)). Acceptable per spec.
  - A new return-type alias `BillingProjectWithBreakdown` is introduced adjacent to `listProjects`; the shared `BillingProjectItem` type is unchanged.
  - Sort logic now lives in SQL (good — deterministic, locale-stable). Client must not re-sort.
  - Projects with > 200 user-hours rows are truncated to the first 200 by spec sort. Documented in §5 as a deliberate V1 contract.
- **Follow-ups**:
  - If a project-wide hours formatter is later introduced, replace the file-local `formatHours` in `billing-project-row.tsx` with the canonical helper.
  - Consider promoting `ProjectUserHours` to `lib/types/project-user-hours.ts` if more components need it; for now it is exported in-place from `lib/repositories.ts`.
  - Consider memoizing `BillingProjectUserHoursTable` if profiling shows re-render cost at the 200-row cap.
  - If a real project ever exceeds 200 user-hours rows, revisit either raising the cap or adding pagination on the breakdown table. (V1 already surfaces the truncation via an inline footer note — see Step 4 / §4 criterion #14.)

---

## Plan Summary

**Plan saved to:** `.omc/plans/billing-hours-table-consensus.md`

**Scope:**
- ~3 file edits: `lib/repositories.ts`, `components/projects/billing-project-row.tsx`, optional narrow type alias in `components/projects/projects-billing.tsx`, 1-2 new test files.
- Zero new routes, zero new migrations, zero schema changes.
- Estimated complexity: **LOW–MEDIUM** (additive single-statement aggregate + presentational UI).

**Key Deliverables:**
1. Enriched `listProjects(..., { billingOnly: true })` payload with `user_hours_breakdown` via a single-statement `json_agg` aggregate scoped to a billing-only composed SELECT.
2. Responsive 2-col `BillingProjectRow` with inline `BillingProjectUserHoursTable` and file-local `formatHours` helper.
3. Repository + route + (optional) component tests covering sort, atomic invariant, empty case, 200-row cap, missing-table guard, and non-billing isolation.

**Consensus artifacts present:**
- RALPLAN-DR: 6 principles, 3 drivers, viable options (A′ chosen; A retained as fallback; B and C invalidated with explicit rationale).
- ADR: Decision, Drivers, Alternatives considered, Why chosen, Consequences, Follow-ups.

**Open Questions** (logged in `.omc/plans/open-questions.md`):
- `formatHours` resolution: **RESOLVED** (no shared helper exists; file-local helper in `billing-project-row.tsx`). See Step 4.4.
- `ProjectUserHours` location: keep in-place + export from `lib/repositories.ts` (default decision, recorded in ADR Follow-ups).

---

## Changelog (iteration 2)

Merged from Architect + Critic consensus:

1. **Principle 1 rewritten** to clarify that `ProjectUserHours` (the *type*) is reused, while the existing `listProjectUserHours` helper (`lib/repositories.ts:1027-1051`) is explicitly NOT reused on the billing path due to its conflicting `first_name`-first `ORDER BY` at `:1040`. The helper remains untouched for `my-hours` / `archived-hours` callers.
2. **Type segregation**: `BillingProjectItem` is no longer extended. Introduced `BillingProjectWithBreakdown` adjacent to `listProjects` and use a local narrowed type at the billing render path only. Steps 3 and 4 updated.
3. **Adopted Option A′ (single-query `json_agg`)** as the recommended option, replacing the two-statement Option A. Composed billing-only `billingSelectColumns` so the shared `projectListSelectColumns` (`:406-416`) is unchanged. ADR §7 updated: the prior "JSON aggregate rejected" entry was a strawman (it assumed mutating the shared constant); the new aggregate is added to a billing-only SELECT composition. Moved from "Alternatives rejected" to "Chosen approach." Two-statement A retained as fallback.
4. **`isMissingProjectUserHoursTableError` citation corrected** from `:1046-1049` (call site) to `:1327-1333` (definition). Added explicit export action (or local duplication) and a `try/catch` around the billing SQL with a documented re-run-without-aggregate recovery path.
5. **Payload tail mitigation made concrete**: added `LIMIT 200` inside the `json_agg` subquery, documented the V1 contract ("first 200 by spec sort, larger sets out of scope"), and added §6 / §4 row-count assertion (`min(actualUsers, 200)`).
6. **`formatHours` open question resolved**: grep verified that no shared helper exists in `lib/` or `components/`, and `billing-project-row.tsx` does not currently render `total_hours` at all (only `hasMissingHours`). Step 4.4 now specifies a file-local `formatHours = (v) => Number(v).toFixed(2)` used for both row cells and the Total row, with Total taken from `project.total_hours` (not a JS sum) to preserve the SQL invariant. `.omc/plans/open-questions.md` to be updated to mark this resolved.

Also: Principle 6 reworded to scope server-side sort to the `json_agg(... ORDER BY ...)` aggregate and to explicitly note that the existing `listProjectUserHours` helper is NOT used by the billing path.

---

## Changelog (iteration 3)

Architect requested 3 non-blocking polish items after Critic APPROVED. All merged:

1. **Planner-defensive `json_agg` ORDER BY**: Step 1.2's SQL block now applies ORDER BY at both layers — the inner subquery keeps its `ORDER BY "lastNameKey", "firstNameKey", "emailKey", puh.user_id` + `LIMIT 200`, AND the outer `json_agg(row ORDER BY row."lastName", row."firstName", row."email", row."userId")` restates the spec sort intra-aggregate. The inner SELECT aliases columns to `userId`, `firstName`, `lastName`, `email`, `avatarUrl`, `hours` plus sort-key aliases `lastNameKey`, `firstNameKey`, `emailKey` so the outer `json_agg` can reference the spec columns directly on `row`. This is planner-proof: the emitted JSON array is order-stable regardless of how Postgres chooses to materialize the inner subquery.
2. **Truncation affordance promoted to V1**: Step 4.4 now requires rendering a small muted footer note (`Showing first 200 users (sorted by last name).`) immediately below the table when `rows.length === 200`. Acceptance criterion added to Step 4 bullets and as §4 criterion #14 (component test verifies footer rendered at cap and absent below cap). §7 ADR Follow-ups updated: the "if a real project ever exceeds 200" item now notes that V1 already surfaces the truncation inline.
3. **`ProjectListItem` ambiguity resolved**: Code inspection (`lib/repositories.ts:504-562`) confirmed that `listProjects` returns `result.rows` with no named return type — there is no existing `ProjectListItem` alias. Step 3.1 now introduces a concrete exported `ProjectListRow` type in `lib/repositories.ts` (adjacent to `projectListSelectColumns` at `:406-416`) representing the row shape from `listProjects`. `BillingProjectWithBreakdown = ProjectListRow & { user_hours_breakdown: ProjectUserHours[] }` is now defined unconditionally with no "or, if not the right base" hedge and no fallback wording. The concrete column list in `ProjectListRow` is to be finalized against the active migrations during implementation; the type is canonical going forward.

Status line set to `pending approval`. No source files mutated; plan file edits only.
