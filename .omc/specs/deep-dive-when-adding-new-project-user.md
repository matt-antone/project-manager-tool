# Deep Dive Spec: Member selection at project creation

**Slug:** `when-adding-new-project-user`
**Source:** `/deep-dive`
**Trace:** `.omc/specs/deep-dive-trace-when-adding-new-project-user.md`
**Final ambiguity:** ~12%

---

## Goal

When creating a new project, allow the creator to optionally select one or more **active users** (where active = `is_legacy = false AND email IS NOT NULL`) to add as project members in the same operation. The creator is always added automatically.

---

## Constraints

- **C1 — Atomic insert (hybrid):** The server pre-filters submitted `memberIds[]` by active-status. Inactive users are dropped from the list and returned to the client as a warning. The remaining inserts (project + creator + selected active members) run in a **single DB transaction**. Any infrastructure/FK failure rolls back the entire transaction.
- **C2 — Active-user definition is fixed:** Reuse `listActiveUsers()` semantics (`is_legacy = false AND email IS NOT NULL`). No new `is_active`/`status` column.
- **C3 — Creator UX:** Creator appears in the picker checkbox list, **checked and disabled** (locked). Cannot be deselected.
- **C4 — Picker UX:** Inline `<fieldset>` section in the existing create dialog (reuse the scaffolded checkbox-list pattern already present in `components/project-dialog-form.tsx`). Selecting additional members is **optional** — creating a project with only the creator is valid.
- **C5 — Notification channel:** Each newly added member (excluding the creator) receives an **email-only** notification when the project is created. Use the existing email transport in the repo; do not add a new transport for this work.
- **C6 — No activity-log entries** for create-time member adds (out of scope; edit-mode adds remain unchanged).
- **C7 — Stale-picker handling:** Users that were active at picker render but became inactive before submit are silently filtered server-side and returned in the response as `skippedInactiveUserIds[]`. The project + remaining members still commit.

---

## Non-Goals

- Roles or permissions per member (all members remain equal).
- Bulk operations on the members endpoint (no batch PATCH).
- Search/typeahead in the picker beyond what the existing checkbox-list scaffold offers.
- Changing the "active user" definition.
- Activity-log / audit entries for the new flow.
- Notifying the creator (they created it).
- In-app notifications (email only).

---

## Acceptance Criteria

1. **Schema accepts `memberIds[]`**
   - `createProjectSchema` in `app/projects/route.ts` includes `memberIds: z.array(z.string()).optional()`.
   - Invalid (non-string) entries cause a 400.

2. **Repository accepts member list**
   - `createProject()` in `lib/repositories.ts:747` accepts an optional `memberIds?: string[]` argument.
   - Internally, the function: opens a transaction → inserts the project → fetches active-status for all `memberIds` → drops inactive IDs into a returned `skippedInactiveUserIds[]` array → bulk-inserts `project_members` rows for `[creatorId, ...activeIds]` using `ON CONFLICT DO NOTHING` for safety → commits.
   - On any DB/FK error, transaction rolls back; no partial state.

3. **API response shape**
   - `POST /api/projects` returns `{ project: ProjectRow, warnings?: { skippedInactiveUserIds: string[] } }`.
   - `warnings` field is omitted when empty.

4. **UI wires picker into create flow**
   - `projects-workspace-shell.tsx` passes `members={[]}`, `activeUsers={fetchedActiveUsers}`, `onAddMember`, `onRemoveMember` to `ProjectDialogForm` at create.
   - Local form state tracks selected `memberIds`.
   - Submit payload in `projects-workspace-context.tsx` includes `memberIds`.

5. **Creator locked in UI**
   - Creator's row in the checkbox list is rendered with `checked` and `disabled` attributes.
   - Attempting to programmatically uncheck has no effect on submitted payload.

6. **Email side-effect**
   - For each newly added member (excluding creator), an email is sent via the existing email transport.
   - Email failure does **not** roll back the transaction (the project + members are already committed before email send).
   - Skipped inactive users receive no email.

7. **Stale-picker warning surfaced**
   - When the server skips inactive users, the response carries `warnings.skippedInactiveUserIds`.
   - The client shows a toast/inline message listing the skipped names (resolve IDs → display names from the picker's local list).

8. **Existing edit flow unchanged**
   - `POST /api/projects/[id]/members` continues to work as today.
   - Project edit dialog's member picker is not modified by this change.

---

## Assumptions Exposed

- An email transport exists in the repo (assumed from notification choice). If absent, implementation must surface this as a blocker before writing email code.
- The edit-mode member picker in `project-dialog-form.tsx` is functioning (Lane 1 evidence indicates scaffolding works when props are passed; not independently verified in trace).
- `listActiveUsers()` is available on the server at create-time without performance concerns (the same query already runs for the edit-mode picker).
- The Lane 1 trace observed a non-trivial number of code locations; assume no other call sites pass member props to `ProjectDialogForm` for create.

---

## Technical Context

**Files to modify:**
- `app/projects/route.ts` — extend `createProjectSchema` + POST handler.
- `lib/repositories.ts` — extend `createProject()` signature + body; wrap in transaction; bulk-insert pattern.
- `components/projects/projects-workspace-shell.tsx` (~line 140) — pass member-picker props to `ProjectDialogForm` at create.
- `components/projects/projects-workspace-context.tsx` (~line 310) — track `memberIds` in form state, include in submit payload.
- `components/project-dialog-form.tsx` — minor: render creator row as `checked + disabled`; ensure picker visible in create.

**Schema:** `project_members (project_id, user_id)` PK, `ON CONFLICT (project_id, user_id) DO NOTHING` already in repo.

**Active-user query:** `listActiveUsers()` in `lib/repositories.ts:~78` — reuse.

**Transaction pattern:** repo currently calls `addProjectMember(created.id, args.createdBy)` outside the project insert. This work introduces a transaction boundary; check for an existing `withTransaction` / `pool.connect` helper before inventing one.

---

## Ontology

| Term | Meaning |
|------|---------|
| **Active user** | `user_profiles` row with `is_legacy = false AND email IS NOT NULL`. |
| **Project member** | Row in `project_members(project_id, user_id)`. |
| **Creator** | The authenticated user who issued the create request. Always becomes a member. |
| **Skipped inactive user** | A user submitted in `memberIds[]` who failed the active-status pre-filter at submit time. |
| **Atomic (in this spec)** | Project insert + member inserts run in one DB transaction. Stale-picker filtering is a pre-step, not part of atomicity. |

---

## Ontology Convergence

- "Atomic" was the load-bearing term that risked confusion. Final meaning: the **DB transaction** is atomic; the **client→server contract** is hybrid (pre-filter + atomic insert).
- "Active user" stayed stable across the interview — code-defined, not redefined.

---

## Trace Findings

**Most likely explanation (from trace):** Feature is unimplemented end-to-end. UI scaffold exists in `project-dialog-form.tsx` but caller `projects-workspace-shell.tsx:140` omits all member-picker props; Zod schema in `app/projects/route.ts` lacks `memberIds`; `createProject()` in `lib/repositories.ts:747` has no `memberIds` parameter. Only the creator is auto-added, non-atomically, after project insert.

**Per-lane critical unknowns and resolutions:**
- **Lane 1 (UI placement):** Resolved → inline section in existing create dialog, optional.
- **Lane 2 (atomicity):** Resolved → hybrid (server pre-filter + atomic DB transaction).
- **Lane 3 (creator handling):** Resolved → auto-checked + disabled in picker.

**Evidence that shaped the interview:** Lane 1 + Lane 2 converged on a single end-to-end gap, so the interview did not waste time confirming "is the feature missing?" and instead drove directly into UX and consistency-semantics questions. Lane 3's "premise" framing surfaced the creator-self-selection edge case that drove Q2.

---

## Interview Transcript

- **Q1 (Atomicity):** Atomic single transaction. → C1
- **Q2 (Creator UX):** Auto-checked and disabled. → C3
- **Q3 (Picker placement + required):** Inline section, optional. → C4
- **Q4 (Side-effects):** Notify added members; (server validation added as derived constraint). → C5, C6 (no log)
- **Q5a (Notification channel):** Email only. → C5
- **Q5b (Stale-picker):** Silently skip (conflicted with Q1).
- **Q6 (Reconcile Q1+Q5b):** Hybrid — pre-filter inactive then atomic insert. → C1, C7
