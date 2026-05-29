# Deep Dive Trace: when-adding-new-project-user

## Observed Result

Feature gap: when creating a project, the user cannot select active users to include as project members. Only the creator is auto-added.

## Ranked Hypotheses

| Rank | Hypothesis | Confidence | Evidence Strength | Why it leads |
|------|------------|------------|-------------------|--------------|
| 1 | Code-path: member-picker UI exists in `project-dialog-form.tsx` but is not rendered/wired in create flow | High | Strong | `projects-workspace-shell.tsx:~140` passes no member props at create; `showMembers` evaluates false; submit handler omits `members` field |
| 2 | Data/API: `createProjectSchema` + `createProject()` do not accept a `members[]` field; only creator auto-added non-atomically post-insert | High | Strong | Zod schema in `app/projects/route.ts:~20` has no members; `createProject()` signature in `lib/repositories.ts:747` has no members param; comment in repo confirms non-atomic |
| 3 | Premise: "active user" definition mismatch + self-selection edge case (creator auto-added but picker doesn't exclude self) | Moderate | Moderate | `listActiveUsers()` = `is_legacy=false AND email IS NOT NULL` (settled, but unused `last_seen_at` raises UX question); picker shows creator; `ON CONFLICT DO NOTHING` silently dedupes |

## Evidence Summary by Hypothesis

- **Lane 1 (UI)**: `project-dialog-form.tsx` lines 110-178 contain full checkbox-list scaffold gated by `showMembers = Boolean(members && activeUsers && onAddMember && onRemoveMember)`. Caller `projects-workspace-shell.tsx:140` omits all four props. Submit handler in `projects-workspace-context.tsx:~310` posts `{name, description, deadline, clientId, tags, requestor}` only.
- **Lane 2 (API)**: `createProjectSchema` lacks `members`/`memberIds`. `createProject()` args type lacks members. `addProjectMember()` is idempotent (`ON CONFLICT DO NOTHING`) but single-row. Creator-add runs after project insert in a non-transactional sequence.
- **Lane 3 (Premise)**: `is_legacy=false AND email IS NOT NULL` is the only definition; `last_seen_at` column exists but is never filtered on. Picker has no self-exclusion; clicking creator's own checkbox silently dedupes via PK conflict.

## Evidence Against / Missing Evidence

- **Lane 1**: scaffold works in edit mode (assumed), so component itself is not broken — gap is only the wire-up at create.
- **Lane 2**: members-route `POST /api/projects/[id]/members` exists and could be called N times client-side, but leaks partial-failure risk.
- **Lane 3**: definition is unambiguous in code + documented in migration 0027 comments; no actual data corruption — only UX clarity issue.

## Per-Lane Critical Unknowns

- **Lane 1 (UI)**: Should the picker render inline in the create dialog, as a second step, or in a side panel — and is it required or optional for create?
- **Lane 2 (API)**: Should project + members be wrapped in a single transaction (atomic), or accept client-side N+1 calls with idempotent retry on failure?
- **Lane 3 (Premise)**: Should the creator appear in the picker auto-checked-and-disabled, be hidden entirely, or remain selectable with silent dedupe?

## Lane 3 Misplacement / SoT Ownership Scope

N/A — no MOVE candidates surfaced; this is a feature-add, not a misplacement.

## Rebuttal Round

- Best rebuttal to leader (Lane 1): "Could be only an API gap — UI scaffold maybe just untested." Rejected: Lane 2 confirms API also lacks the field, so both layers are missing; not either/or.
- Convergence: Lanes 1 and 2 are not competing — they are two layers of the same end-to-end gap. Lane 3 sits orthogonally, addressing UX semantics within the proposed feature.

## Convergence / Separation Notes

- Lanes 1 + 2 merge into single finding: feature unimplemented top-to-bottom (UI hidden, schema lacks field, repo lacks bulk add).
- Lane 3 stays separate: it doesn't dispute the gap, it surfaces design questions the interview must answer.

## Most Likely Explanation

The feature is unimplemented end-to-end. The create-dialog form has a member-picker scaffold (already used in edit flow, presumably) but it is not wired into create: caller omits props, submit payload omits members, API schema omits the field, and the repository function has no parameter for additional members. Implementing requires changes at four layers: caller (pass props), form (already supports), submit payload, Zod schema, repository signature, and a transactional or compensating bulk-add path.

## Critical Unknown

Whether project creation + initial-member assignment must be atomic (single transaction) or can be best-effort with idempotent retry — this drives whether the API accepts `memberIds[]` directly or whether the client calls the members endpoint N times after create.

## Recommended Discriminating Probe

Decide the atomicity requirement first (single transactional `POST /api/projects` with `memberIds[]` vs. N+1 client-side calls). All downstream decisions (UI layout, error handling, partial-state recovery) hinge on this.
