# Ralplan: Member selection at project creation

**Status:** pending approval (v2 — architect revisions applied)
**Spec:** `.omc/specs/deep-dive-when-adding-new-project-user.md`
**Trace:** `.omc/specs/deep-dive-trace-when-adding-new-project-user.md`
**Mode:** RALPLAN-DR short

---

## Requirements Summary

Allow the creator of a new project to optionally select active users (`user_profiles.is_legacy = false AND email IS NOT NULL`) to add as project members in the same operation. Creator is always added. Project + members insert as an atomic DB transaction; inactive users are silently pre-filtered server-side and returned as warnings; each newly added member receives an email.

---

## RALPLAN-DR Summary (short mode)

### Principles
1. **One round-trip from the UI** — create-with-members is a single user intent, must be a single client call.
2. **Atomic at the DB layer** — no half-staffed projects on infrastructure failure.
3. **Lenient on stale data** — a user deactivated between picker render and submit should not block the whole create.
4. **Reuse before invent** — reuse `listActiveUsers()`, `addProjectMember()`, `sendMail()`; do not replicate.
5. **Edit flow untouched** — this work is additive at create; existing edit-mode member CRUD does not change.

### Decision Drivers (top 3)
1. **Data consistency** — `project_members` rows must reflect a successful project insert (no orphans, no missing creator).
2. **UX speed** — single-form create; no second step; optional picker.
3. **Operational simplicity** — minimal new infrastructure; introduce one `withTransaction` helper, not a job/queue.

### Viable Options

**Option A — Server-side atomic, single endpoint (CHOSEN).** `POST /api/projects` accepts `memberIds[]`. `createProject(args, { memberIds })` opens a transaction via a new `withTransaction()` helper in `lib/db.ts`, pre-filters `memberIds` by active-status, inserts the project, bulk-inserts `project_members` for `[creatorId, ...activeIds]`, commits. Returns `{ project, warnings?: { skippedInactiveUserIds[] } }`. Emails fire post-commit (outside TX), best-effort.

  - **Pros:** matches all 5 principles; single round-trip; clean rollback semantics; reuses existing helpers; minimal new surface area.
  - **Cons:** introduces a `withTransaction` helper (small one-time cost); two-statement transaction (project + members) requires touching the existing single-shot `query()` path inside `createProject`.

**Option B — Client-side N+1 (rejected).** Client calls `POST /api/projects` then `POST /api/projects/[id]/members` per selected user.

  - **Pros:** zero server changes besides UI; reuses the existing members endpoint as-is.
  - **Cons:** violates Principle 2 (no atomicity); partial-failure leaves a half-staffed project; race against deactivation between calls; multiple round-trips; client must compensate on failure (delete project?).
  - **Invalidation:** spec C1 explicitly requires atomic insert.

**Option C — Server best-effort loop, no transaction (rejected).** Single endpoint accepts `memberIds[]`, server inserts project then loops `addProjectMember`, swallows per-row failures.

  - **Pros:** no `withTransaction` helper needed; idempotent via existing `ON CONFLICT DO NOTHING`.
  - **Cons:** violates Principle 2; spec C1 requires DB transaction on real failures; "swallowed FK error" is the exact hidden-corruption mode the spec ruled out.
  - **Invalidation:** spec hybrid contract is "skip stale users, atomic on everything else" — this option drops the atomic half.

---

## Acceptance Criteria

All criteria are concrete and testable.

1. `createProjectSchema` in `app/projects/route.ts:10` includes `memberIds: z.array(z.string().min(1)).max(200).optional()`. Test: POST with `memberIds: ["abc"]` parses; POST with `memberIds: 123` returns 400.

2. `POST /api/projects` returns `{ project, warnings?: { skippedInactiveUserIds: string[] } }`. `warnings` is omitted when empty.

3. `createProject()` in `lib/repositories.ts:747` accepts an extended args type `{ ..., memberIds?: string[] }` and on the happy path inserts project + member rows in **one DB transaction** (uses `withTransaction()` from `lib/db.ts`). Returns `{ project, skippedInactiveUserIds, addedMemberEmails }`.

4. `lib/db.ts` exports `withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>` that issues `BEGIN` / `COMMIT` / `ROLLBACK` on a single client from the existing pool. TSDoc on the export names the legitimate callers and warns against wrapping read-only paths or paths that call other repository helpers (which still use the auto-released `query()` helper and would not share the transaction).

5. **Pre-TX schema probe**: before opening the transaction, a module-level cached check (`hasProjectsDeadlineColumn()`) reads `information_schema.columns` once per process. The transaction then uses the with-deadline INSERT or the legacy INSERT based on this boolean. The previous `try/catch isMissingProjectDeadlineColumnError` retry-on-same-connection pattern is **removed** because re-issuing SQL on a Postgres-aborted transaction is invalid (would raise `25P02`).

6. Inside the transaction, `memberIds` is filtered to active users via a single `SELECT id, email FROM user_profiles WHERE id = ANY($1::text[]) AND is_legacy = false AND email IS NOT NULL`. IDs not returned are collected into `skippedInactiveUserIds`. The creator (`createdBy`) is **always** inserted regardless of the active-status check — this preserves the existing invariant from `lib/repositories.ts:825/866` that the authenticated session user is added as a member. If the creator is non-active per the filter, they are inserted but excluded from `addedMemberEmails`.

7. A new helper `bulkInsertProjectMembers(client: PoolClient, projectId: string, userIds: string[])` is added to `lib/repositories.ts` and used by `createProject`. SQL: `INSERT INTO project_members (project_id, user_id) SELECT $1, unnest($2::text[]) ON CONFLICT (project_id, user_id) DO NOTHING` (explicit PK target to match the existing single-add pattern at `lib/repositories.ts:1490`). Deduped input set = `[creatorId, ...activeFilteredIds]`. The existing single-add `addProjectMember()` is unchanged in this PR; the bulk helper is the future canonical entry point.

8. On any SQL error inside the transaction (incl. project insert, member insert), the entire TX rolls back; no `projects` row, no `project_members` rows. Test: inject `throw` mid-transaction → assert zero rows in both tables.

9. The two existing post-insert `addProjectMember(created.id, args.createdBy)` calls at `lib/repositories.ts:825` and `:866` are removed (their work moves inside the transaction).

10. `components/projects/projects-workspace-shell.tsx` passes `members={[]}`, `activeUsers={fetchedActiveUsers}`, `currentUserId={session.userId}`, `onAddMember`, `onRemoveMember` to `ProjectDialogForm` when opening the create dialog. `activeUsers` is fetched via the existing endpoint that already powers the edit-mode picker (verify or add).

11. `components/projects/projects-workspace-context.tsx` (~line 310) tracks `memberIds` in create-form state and includes it in the create submit payload.

12. `components/project-dialog-form.tsx` renders the creator's row with `checked` and `disabled` attributes; programmatic uncheck has no effect on submit payload. Accepts a new `currentUserId?: string` prop.

13. **Email dispatch order**: emails fire **after Dropbox provisioning succeeds** (`setProjectStorageDir` returns), **not** immediately after `createProject` returns. This ensures that if Dropbox provisioning fails and `deleteProjectById` is invoked (per `app/projects/route.ts:~99`), no users receive notifications about a project that has been deleted.

14. `deleteProjectById(projectId)` is verified to cascade to `project_members` via the existing FK `project_id uuid not null references projects(id) on delete cascade` (migration `0026_project_members.sql:3`). Acceptance test: create a project with members, call `deleteProjectById`, assert zero rows in `project_members` for that project_id.

15. **Email policy is explicit single-attempt, no idempotency key, no retry**: each member in `addedMemberEmails` receives one `sendMail()` call wrapped in `try/catch`; failures log via `console.error("project_member_notify_failed", ...)`; the response still returns success. Document this in route-handler comment. Concurrent dispatch uses `Promise.allSettled` over the array with no concurrency limit at the current 200 cap; if SMTP rate-limit becomes a concern, switch to a small `p-limit(5)` wrapper as a follow-up.

16. Client surfaces `warnings.skippedInactiveUserIds` as a toast or inline message: "Skipped: {name1}, {name2} — no longer active." Names resolved from the picker's local active-user list.

17. **Caller audit for `createProject` return-shape change**: the return type changes from a bare project row to `{ project, skippedInactiveUserIds, addedMemberEmails }`. Verification step: `rg -n "createProject\\(" --type ts` confirms `app/projects/route.ts` is the only direct caller; update its destructuring. Tests that import `createProject` are updated similarly.

18. Edit-mode member picker is unchanged. Test: open existing project → members panel renders + add/remove still works.

---

## Implementation Steps

### Step 1 — Add `withTransaction` helper (`lib/db.ts`)
Add after the existing `query` export. Use `getPool().connect()`, `BEGIN`, the callback, `COMMIT`; on throw `ROLLBACK`; `finally` `client.release()`. Re-export `PoolClient` from `pg` for typing.

TSDoc:
```ts
/**
 * Run a multi-statement DB transaction on a single pooled client.
 *
 * CAUTION: any helper invoked inside `fn` that uses the module-level `query()`
 * helper will run on a *different* connection and is NOT part of this
 * transaction. Pass `client` explicitly to repo functions that participate in
 * the transaction.
 *
 * Current legitimate callers:
 *   - createProject (project + project_members atomic insert)
 *
 * Add additional callers here as they are introduced.
 */
```

### Step 2 — Add pre-TX schema probe (`lib/repositories.ts`)
Add a module-level helper:
```ts
// Process-local cache. A schema migration that adds/removes the `deadline`
// column requires a process restart to refresh this value. Do not add
// hot-reload — column shape is stable across the lifetime of a single
// Next.js server process.
let cachedHasDeadline: boolean | null = null;
async function hasProjectsDeadlineColumn(): Promise<boolean> {
  if (cachedHasDeadline !== null) return cachedHasDeadline;
  const r = await query<{ exists: boolean }>(
    `select exists (
       select 1 from information_schema.columns
       where table_name = 'projects' and column_name = 'deadline'
     ) as exists`
  );
  cachedHasDeadline = r.rows[0]?.exists === true;
  return cachedHasDeadline;
}
```
This replaces the try/catch fallback inside `createProject`. The cache is process-local and never invalidated; a schema migration requires a process restart, which is acceptable for this codebase.

### Step 3 — Extend `createProjectSchema` (`app/projects/route.ts:10`)
Add `memberIds: z.array(z.string().min(1)).max(200).optional()`. `[]` is valid.

### Step 4 — Extend `createProject()` (`lib/repositories.ts:747`)
- Add `memberIds?: string[]` to the args type.
- Call `hasProjectsDeadlineColumn()` **before** opening the transaction.
- Wrap the rest of the body in `withTransaction(async (client) => { ... })`.
- Inside the TX: pick the with-deadline or legacy INSERT SQL based on the probe result; both use `client.query`. No try/catch retry.
- After project insert, build the active-member set and call `bulkInsertProjectMembers(client, created.id, toInsert)`.
- Return `{ project: created, skippedInactiveUserIds, addedMemberEmails }`.

Pseudocode for the post-insert block:
```ts
const wanted = Array.from(new Set([args.createdBy, ...(args.memberIds ?? [])]));
const activeRows = await client.query<{ id: string; email: string }>(
  `select id, email from user_profiles
   where id = any($1::text[]) and is_legacy = false and email is not null`,
  [wanted]
);
const activeIds = new Set(activeRows.rows.map((r) => r.id));
const skippedInactiveUserIds = wanted
  .filter((id) => !activeIds.has(id) && id !== args.createdBy);
const toInsert = Array.from(new Set([args.createdBy, ...activeIds]));
await bulkInsertProjectMembers(client, created.id, toInsert);
const addedMemberEmails = activeRows.rows
  .filter((r) => r.id !== args.createdBy)
  .map((r) => r.email);
return { project: created, skippedInactiveUserIds, addedMemberEmails };
```

### Step 5 — Add `bulkInsertProjectMembers` helper (`lib/repositories.ts`)
```ts
export async function bulkInsertProjectMembers(
  client: PoolClient,
  projectId: string,
  userIds: string[]
) {
  if (userIds.length === 0) return;
  await client.query(
    `insert into project_members (project_id, user_id)
     select $1, unnest($2::text[])
     on conflict (project_id, user_id) do nothing`,
    [projectId, userIds]
  );
}
```

### Step 6 — Update POST handler (`app/projects/route.ts:68`)
Destructure the new return shape; pass `memberIds` through. Dropbox provisioning block is unchanged. Compensating `deleteProjectById` is unchanged (FK cascade handles `project_members`).

```ts
// Note on creator-active edge case: if `session.userId` belongs to a legacy/
// no-email profile, `createProject` still inserts the creator into
// `project_members` (preserving the historical invariant from
// `lib/repositories.ts:825/866`), but the creator is excluded from
// `addedMemberEmails` and is NOT surfaced in `skippedInactiveUserIds`.
// This is intentional, not a bug.
const { project: createdProject, skippedInactiveUserIds, addedMemberEmails } = await createProject({
  ...payload,
  createdBy: session.userId,
  memberIds: payload.memberIds
});

// ... existing Dropbox provisioning try/catch unchanged ...
const project = await setProjectStorageDir(createdProject.id, provisioned.projectDir);

// Emails AFTER Dropbox success — if Dropbox failed, control flow has already
// returned via the catch block (which calls deleteProjectById, cascading to
// project_members). Sending emails here means we never notify users about a
// project that was rolled back.
if (config.emailEnabled() && addedMemberEmails.length > 0) {
  const sends = addedMemberEmails.map((email) =>
    sendMail({
      recipients: [email],
      subject: `You've been added to ${createdProject.name}`,
      text: `You're now a member of the project "${createdProject.name}".`,
      html: `<p>You're now a member of the project <strong>${createdProject.name}</strong>.</p>`
    }).catch((err) => {
      console.error("project_member_notify_failed", {
        projectId: createdProject.id,
        email,
        error: err instanceof Error ? err.message : String(err)
      });
    })
  );
  // single-attempt, no retry, no idempotency key — Promise.allSettled keeps
  // one failure from blocking the rest; failures are already swallowed above.
  await Promise.allSettled(sends);
}

return ok({
  project: project ?? createdProject,
  ...(skippedInactiveUserIds.length ? { warnings: { skippedInactiveUserIds } } : {})
}, 201);
```

### Step 7 — Wire picker into create dialog (`components/projects/projects-workspace-shell.tsx`)
At the create-dialog branch (~line 140), pass `activeUsers={activeUsers}`, `members={selectedMembers}`, `currentUserId={session.userId}`, `onAddMember`, `onRemoveMember`. Source `activeUsers` from the same fetch used by edit mode; if create-mode shell does not currently fetch it, add a `useEffect`/query call.

### Step 8 — Form state for selected members (`components/projects/projects-workspace-context.tsx:~310`)
Add `memberIds: string[]` to create-form state. Update `onAddMember(id) => setState((s) => ({ ...s, memberIds: [...s.memberIds, id] }))`. `onRemoveMember(id)` filters. Include `memberIds: state.memberIds` in submit payload JSON.

### Step 9 — Creator locked-row UX (`components/project-dialog-form.tsx`)
Add `currentUserId?: string` prop. In the checkbox `.map`, when `u.id === currentUserId`, render `<input type="checkbox" checked disabled />` with a small "(you)" label and skip wiring `onChange`. Keep all other rows unchanged.

### Step 10 — Stale-picker warning toast (client)
On successful create response, if `warnings?.skippedInactiveUserIds` is present, resolve names from the in-memory `activeUsers` list (the user IDs are still there from when the picker rendered) and show a toast/banner: "Skipped {n} user(s) no longer active: {names}".

### Step 11 — Caller audit
Run `rg -n "createProject\\(" --type ts` and confirm the only direct caller is `app/projects/route.ts`. Update its destructuring to the new return shape. Update any unit tests that call `createProject` directly.

### Step 12 — Tests
- **Unit (Vitest, `tests/unit/`):**
  - `withTransaction` commits on success, rolls back on throw, releases client in `finally`.
  - `hasProjectsDeadlineColumn` caches result and only queries once across multiple calls.
  - `bulkInsertProjectMembers` is a no-op for `[]`, dedups via `ON CONFLICT`, returns void.
  - `createProject` returns `{ project, skippedInactiveUserIds, addedMemberEmails }` with shape assertions.
  - Creator-always-inserted invariant: pass `args.createdBy = legacyUserId` (mocked profile) → assert creator row exists but is not in `addedMemberEmails`.
- **Integration:**
  - POST with `memberIds=[good1, legacyId]` → `warnings.skippedInactiveUserIds=[legacyId]`; `project_members` for project_id contains exactly `{creator, good1}`.
  - POST with `memberIds: 5` → 400.
  - POST with `memberIds: []` → creator-only row, no warnings field in response.
  - Simulated Dropbox failure (mock `ensureProjectFolders` to throw) → `deleteProjectById` called → assert zero rows in both `projects` and `project_members` (FK cascade verified); assert **no** emails sent.
- **Manual:** create dialog → picker visible → creator locked → select 2 users → submit. Verify project + 3 member rows in DB. Verify mail attempted (or `EMAIL_ENABLED=false` skips). Flip a target user's `is_legacy=true` mid-flow → submit → verify `warnings` toast.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| `withTransaction` introduced repo-wide could be misused elsewhere | Scope-limit the helper to the project-create call only in this PR; TSDoc lists legitimate callers and warns that helpers using auto-released `query()` do not participate in the transaction |
| Existing `createProject` has a legacy-schema fallback (`:828-867`); the prior approach of try/catch-retry inside one TX is invalid because a Postgres-aborted transaction rejects all subsequent queries with `25P02` | Pre-TX schema probe (`hasProjectsDeadlineColumn()`) caches the column existence at module level; the TX uses the correct INSERT variant from the start. No in-TX retry needed |
| Email send blocks the response or fires for a project that gets rolled back by Dropbox failure | Emails dispatch AFTER `setProjectStorageDir` succeeds, never in the Dropbox-failure branch. `Promise.allSettled` runs sends concurrently; per-send `.catch` swallows failures with a `project_member_notify_failed` log line |
| Creator could theoretically fail the active-status check (legacy account that somehow ended up authenticated) | Bypass active-filter for `args.createdBy`; always insert creator. Document this as the historical invariant (preserved from current code at `:825`) |
| Picker activeUsers list goes stale during long-open dialog | Server pre-filter + warnings toast cover this; spec accepts |
| `user_profiles.id` is text in some migrations, possibly uuid elsewhere | Use `text[]` consistently for `memberIds`; `unnest($1::text[])` works for both |
| 200-member cap arbitrary | Pulled from same magnitude as `tags.max(50)` precedent; document; raise later if needed |

---

## Verification Steps

1. **Build:** `pnpm tsc --noEmit` clean.
2. **Lint:** `pnpm lint` clean.
3. **Unit tests:** `pnpm test` — new tests pass; existing tests still pass.
4. **Local DB smoke:** start dev server, log in, open new-project dialog, select 1-2 active users, submit. Confirm:
   - Project appears in list.
   - `select * from project_members where project_id = '<new id>'` returns creator + selected users.
   - Mail log shows attempted sends (or `EMAIL_ENABLED=false` skips them).
5. **Stale-picker manual test:** open dialog, in another tab flip a target user to `is_legacy = true`, submit. Verify response includes `warnings.skippedInactiveUserIds`, toast displays, no row in `project_members` for the flagged user.
6. **Atomic rollback test (manual or scripted):** temporarily inject `throw new Error()` after the project insert but before the members insert (in a dev-only branch) — confirm zero rows in `projects` and `project_members` after the failure.
7. **Edit flow regression:** open an existing project, add/remove a member, confirm no behavior change.

---

## ADR — Architecture Decision Record

**Decision:** Add a single-endpoint, server-side atomic create-with-members flow (Option A).

**Drivers:**
- D1 Data consistency (no orphan rows, no half-staffed projects).
- D2 UX speed (one round-trip, one form, optional picker).
- D3 Operational simplicity (one new helper `withTransaction`, reuse existing repo functions, no queue/job system).

**Alternatives considered:**
- **Option B (client N+1):** rejected — violates atomicity (D1) and forces compensating-delete logic on the client.
- **Option C (server best-effort loop):** rejected — silently swallows DB errors that should roll back per spec C1.

**Why chosen:** Option A is the only design that simultaneously satisfies the spec's hybrid atomicity contract (pre-filter stale users, atomic commit on the rest), keeps client logic to a single fetch, and reuses existing repository/mailer surfaces. The `withTransaction` helper is a small one-time cost that pays back any time the codebase needs multi-statement consistency next.

**Consequences:**
- New `withTransaction` export in `lib/db.ts` becomes available repo-wide; future callers may use it.
- `createProject` return shape grows to include `skippedInactiveUserIds`; all current callers (route handler) updated in this PR; if other callers exist, they must read the new field or destructure to ignore.
- Emails are post-commit and best-effort; an email send failure no longer rolls back project creation. This is intentional (a transient SMTP issue should not lose a project).

**Follow-ups:**
- If future features need create-time member roles, `memberIds: string[]` becomes `members: Array<{ id, role }>` — keep the contract narrow now and widen later.
- Consider an in-app notification channel alongside email in a follow-up PR.
- Audit whether `addProjectMember()` callers elsewhere should also be wrapped in transactions (out of scope here).

---

## Open Questions (resolve during implementation)

- Does the create-mode shell (`projects-workspace-shell.tsx`) currently fetch the `activeUsers` list, or does this PR introduce that fetch? Affects Step 7 scope. If a fetch already exists for the edit dialog, reuse it; otherwise add one alongside the existing client-list fetch.
- Is there an activity-feed / audit-log table that records member additions in the edit-mode flow? If yes, decide whether to write equivalent entries at create-time (current spec C6 says no — confirm during impl).

## Changelog

- **v1** (initial draft): all 14 acceptance criteria, 11 implementation steps, 7 risks, ADR, RALPLAN-DR short summary.
- **v2** (architect revisions): applied 7 architect fixes — pre-TX schema probe replaces in-TX try/catch retry (AC#5, Step 2); emails fire AFTER Dropbox provisioning success (AC#13, Step 6); `withTransaction` TSDoc scope warning (AC#4, Step 1); FK cascade verification step (AC#14, confirmed via migration `0026_project_members.sql:3`); `bulkInsertProjectMembers` helper extracted (AC#7, Step 5); single-attempt no-retry no-idempotency email policy explicit (AC#15); caller-audit step added (AC#17, Step 11). Acceptance criteria count grew from 14 to 18; implementation steps from 11 to 12.
- **v2.1** (critic polish): AC#7 SQL wording aligned to explicit `ON CONFLICT (project_id, user_id) DO NOTHING`; Step 2 added in-code comment about no-hot-reload on schema cache; Step 6 added in-code comment documenting the legacy-creator-skip edge case.
