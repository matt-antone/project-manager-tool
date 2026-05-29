# Delete Own Discussion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a discussion's author to delete it when no other user has commented.

**Architecture:** Add a `DELETE` handler to the existing thread route, two helper repo functions (`countNonAuthorComments`, `deleteThread`), and a Delete button on the discussion page. Existing FK cascade removes author's own comments; `project_files.thread_id`/`comment_id` are set to null by existing FK rule.

**Tech Stack:** Next.js App Router, Postgres (Supabase), Vitest, TypeScript, React.

Reference spec: `docs/superpowers/specs/2026-05-13-delete-own-discussion-design.md`.

---

## File Structure

- Modify `lib/repositories.ts` — add `countNonAuthorComments` and `deleteThread`.
- Modify `app/projects/[id]/threads/[threadId]/route.ts` — add `DELETE` handler.
- Modify `app/[id]/[discussion]/page.tsx` — add Delete button and handler.
- Create `tests/unit/delete-thread-repo.test.ts` — repo-level unit tests.
- Create `tests/unit/thread-delete-route.test.ts` — route-level unit tests.

---

### Task 1: Repo — `countNonAuthorComments`

**Files:**
- Modify: `lib/repositories.ts` (add export adjacent to `getThread` near line 1480)
- Test: `tests/unit/delete-thread-repo.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/delete-thread-repo.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const touchProjectActivityMock = vi.fn();

vi.mock("@/lib/db", () => ({ query: queryMock }));

beforeEach(() => {
  vi.resetModules();
  queryMock.mockReset();
  touchProjectActivityMock.mockReset();
});

describe("countNonAuthorComments", () => {
  it("counts comments authored by users other than the thread author", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ c: 3 }] });
    const { countNonAuthorComments } = await import("@/lib/repositories");
    const n = await countNonAuthorComments({ projectId: "p1", threadId: "t1", authorUserId: "u1" });
    expect(n).toBe(3);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/from discussion_comments/);
    expect(sql).toMatch(/author_user_id <> \$3/);
    expect(params).toEqual(["p1", "t1", "u1"]);
  });

  it("returns 0 when no rows match", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ c: 0 }] });
    const { countNonAuthorComments } = await import("@/lib/repositories");
    const n = await countNonAuthorComments({ projectId: "p1", threadId: "t1", authorUserId: "u1" });
    expect(n).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/delete-thread-repo.test.ts`
Expected: FAIL with `countNonAuthorComments` not exported (or similar).

- [ ] **Step 3: Add `countNonAuthorComments` to repositories**

In `lib/repositories.ts`, add immediately after the `editThread` function (right before `getThread`, near line 1480):

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/delete-thread-repo.test.ts`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/repositories.ts tests/unit/delete-thread-repo.test.ts
git commit -m "feat(repo): add countNonAuthorComments for thread delete gate"
```

---

### Task 2: Repo — `deleteThread`

**Files:**
- Modify: `lib/repositories.ts` (add after `countNonAuthorComments`)
- Test: `tests/unit/delete-thread-repo.test.ts` (append)

- [ ] **Step 1: Append failing test**

Append to `tests/unit/delete-thread-repo.test.ts` (inside the same file, after the existing `describe` blocks):

```ts
describe("deleteThread", () => {
  it("issues a delete scoped to project + thread id and touches activity", async () => {
    // First call: the DELETE. Second call: touchProjectActivity's internal query.
    queryMock.mockResolvedValue({ rows: [] });
    const { deleteThread } = await import("@/lib/repositories");
    await deleteThread({ projectId: "p1", threadId: "t1" });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/delete from discussion_threads/);
    expect(sql).toMatch(/where id = \$1 and project_id = \$2/);
    expect(params).toEqual(["t1", "p1"]);
    // Activity touch invoked at least once after the delete.
    expect(queryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/delete-thread-repo.test.ts`
Expected: FAIL — `deleteThread` not exported.

- [ ] **Step 3: Add `deleteThread`**

In `lib/repositories.ts`, immediately after `countNonAuthorComments`:

```ts
export async function deleteThread(args: { projectId: string; threadId: string }) {
  await query(
    `delete from discussion_threads where id = $1 and project_id = $2`,
    [args.threadId, args.projectId]
  );
  await touchProjectActivity(args.projectId);
}
```

(`touchProjectActivity` is already defined earlier in the file and is called from `createThread`/`editThread`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/delete-thread-repo.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/repositories.ts tests/unit/delete-thread-repo.test.ts
git commit -m "feat(repo): add deleteThread (cascade handles comments, files set null)"
```

---

### Task 3: Route — `DELETE /projects/[id]/threads/[threadId]`

**Files:**
- Modify: `app/projects/[id]/threads/[threadId]/route.ts`
- Test: `tests/unit/thread-delete-route.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/thread-delete-route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserMock = vi.fn();
const getProjectMock = vi.fn();
const getThreadMock = vi.fn();
const countNonAuthorCommentsMock = vi.fn();
const deleteThreadMock = vi.fn();

vi.mock("@/lib/auth", () => ({ requireUser: requireUserMock }));
vi.mock("@/lib/repositories", () => ({
  getProject: getProjectMock,
  getThread: getThreadMock,
  editThread: vi.fn(),
  countNonAuthorComments: countNonAuthorCommentsMock,
  deleteThread: deleteThreadMock
}));

beforeEach(() => {
  vi.resetModules();
  [requireUserMock, getProjectMock, getThreadMock, countNonAuthorCommentsMock, deleteThreadMock].forEach((m) => m.mockReset());
});

function req() {
  return new Request("http://localhost/projects/p1/threads/t1", { method: "DELETE" });
}
const params = { params: Promise.resolve({ id: "p1", threadId: "t1" }) };

describe("DELETE /projects/[id]/threads/[threadId]", () => {
  it("returns 200 and deletes when author and no third-party comments", async () => {
    requireUserMock.mockResolvedValue({ id: "u1" });
    getProjectMock.mockResolvedValue({ id: "p1" });
    getThreadMock.mockResolvedValue({ id: "t1", author_user_id: "u1" });
    countNonAuthorCommentsMock.mockResolvedValue(0);
    deleteThreadMock.mockResolvedValue(undefined);
    const { DELETE } = await import("@/app/projects/[id]/threads/[threadId]/route");
    const res = await DELETE(req(), params);
    expect(res.status).toBe(200);
    expect(deleteThreadMock).toHaveBeenCalledWith({ projectId: "p1", threadId: "t1" });
  });

  it("returns 403 when caller is not the author", async () => {
    requireUserMock.mockResolvedValue({ id: "u1" });
    getProjectMock.mockResolvedValue({ id: "p1" });
    getThreadMock.mockResolvedValue({ id: "t1", author_user_id: "someone-else" });
    const { DELETE } = await import("@/app/projects/[id]/threads/[threadId]/route");
    const res = await DELETE(req(), params);
    expect(res.status).toBe(403);
    expect(deleteThreadMock).not.toHaveBeenCalled();
  });

  it("returns 403 when other users have commented", async () => {
    requireUserMock.mockResolvedValue({ id: "u1" });
    getProjectMock.mockResolvedValue({ id: "p1" });
    getThreadMock.mockResolvedValue({ id: "t1", author_user_id: "u1" });
    countNonAuthorCommentsMock.mockResolvedValue(2);
    const { DELETE } = await import("@/app/projects/[id]/threads/[threadId]/route");
    const res = await DELETE(req(), params);
    expect(res.status).toBe(403);
    expect(deleteThreadMock).not.toHaveBeenCalled();
  });

  it("returns 404 when project missing", async () => {
    requireUserMock.mockResolvedValue({ id: "u1" });
    getProjectMock.mockResolvedValue(null);
    const { DELETE } = await import("@/app/projects/[id]/threads/[threadId]/route");
    const res = await DELETE(req(), params);
    expect(res.status).toBe(404);
  });

  it("returns 404 when thread missing", async () => {
    requireUserMock.mockResolvedValue({ id: "u1" });
    getProjectMock.mockResolvedValue({ id: "p1" });
    getThreadMock.mockResolvedValue(null);
    const { DELETE } = await import("@/app/projects/[id]/threads/[threadId]/route");
    const res = await DELETE(req(), params);
    expect(res.status).toBe(404);
  });

  it("returns 401 when auth fails", async () => {
    requireUserMock.mockRejectedValue(new Error("auth required"));
    const { DELETE } = await import("@/app/projects/[id]/threads/[threadId]/route");
    const res = await DELETE(req(), params);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/thread-delete-route.test.ts`
Expected: FAIL — `DELETE` not exported.

- [ ] **Step 3: Add `DELETE` handler**

In `app/projects/[id]/threads/[threadId]/route.ts`:

Update the imports line to include the new repo functions:

```ts
import { countNonAuthorComments, deleteThread, editThread, getProject, getThread } from "@/lib/repositories";
```

Append the handler at the end of the file (after the existing `PATCH` handler):

```ts
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; threadId: string }> }
) {
  try {
    const user = await requireUser(request);
    const { id, threadId } = await params;
    const project = await getProject(id);
    if (!project) return notFound("Project not found");
    const thread = await getThread(id, threadId);
    if (!thread) return notFound("Thread not found");
    const authorUserId = (thread as unknown as { author_user_id?: unknown }).author_user_id;
    if (typeof authorUserId !== "string" || authorUserId !== user.id) {
      return forbidden("Only the author can delete this discussion");
    }
    const otherComments = await countNonAuthorComments({ projectId: id, threadId, authorUserId });
    if (otherComments > 0) {
      return forbidden("Cannot delete a discussion with comments from other users");
    }
    await deleteThread({ projectId: id, threadId });
    return ok({ deleted: true });
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    return serverError();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/thread-delete-route.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Run the existing PATCH tests to confirm no regression**

Run: `pnpm vitest run tests/unit/thread-edit-route.test.ts tests/unit/thread-route.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add app/projects/[id]/threads/[threadId]/route.ts tests/unit/thread-delete-route.test.ts
git commit -m "feat(api): DELETE /projects/[id]/threads/[threadId] for author when no other comments"
```

---

### Task 4: Frontend — Delete button on discussion page

**Files:**
- Modify: `app/[id]/[discussion]/page.tsx`

- [ ] **Step 1: Confirm `useRouter` import exists**

Run: `grep -n 'useRouter\|from \"next/navigation\"' 'app/[id]/[discussion]/page.tsx'`
- If `useRouter` is already imported, skip to Step 2.
- If not, add to existing `next/navigation` import (or insert new import near the other React imports at the top of the file):

```ts
import { useRouter } from "next/navigation";
```

- [ ] **Step 2: Add router + delete handler**

Inside the component, near the other top-level handlers (e.g., after `cancelEditingThread` around line 266), add:

```ts
const router = useRouter();

async function deleteThreadAction() {
  if (!projectId || !discussionId) return;
  if (!window.confirm("Delete this discussion? This cannot be undone.")) return;
  try {
    const token = await ensureAccessToken();
    if (!token) throw new Error("Sign in to delete this discussion.");
    await authedFetch(token, `/projects/${projectId}/threads/${discussionId}`, {
      method: "DELETE"
    });
    router.push(`/${projectId}`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not delete discussion");
  }
}
```

Notes:
- `projectId`, `discussionId`, `ensureAccessToken`, `authedFetch`, and `setStatus` are already in scope (used by `saveThreadEdit` at line 269). Read the surrounding code to confirm the exact names and reuse them — do not introduce new helpers.
- If the file uses a different access-token accessor than `ensureAccessToken` (e.g., a `token` from state or `accessToken` variable), use the same approach as `saveThreadEdit`.

- [ ] **Step 3: Add Delete button next to Edit**

Locate the existing Edit-button block at `app/[id]/[discussion]/page.tsx:401`:

```tsx
{currentUser?.id === thread.author_user_id && !isEditingThread && (
  <OneShotButton type="button" className="terciary" onClick={startEditingThread}>
    Edit
  </OneShotButton>
)}
```

Replace it with:

```tsx
{currentUser?.id === thread.author_user_id && !isEditingThread && (
  <>
    <OneShotButton type="button" className="terciary" onClick={startEditingThread}>
      Edit
    </OneShotButton>
    {comments.every((c) => c.author_user_id === thread.author_user_id) && (
      <OneShotButton type="button" className="terciary" onClick={deleteThreadAction}>
        Delete
      </OneShotButton>
    )}
  </>
)}
```

The `every` check covers the empty-comments case (vacuously true) and the "only author's own follow-ups" case.

- [ ] **Step 4: Type-check**

Run: `pnpm tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Manual smoke**

Start dev server (`pnpm dev`) and:
1. Sign in as author of a discussion with no comments → Delete visible → click → confirm → redirected to `/<projectId>`; the discussion no longer appears in the list.
2. Sign in as author of a discussion with another user's comment → Delete button hidden.
3. Sign in as a non-author → no Edit, no Delete.
4. (Optional) Sign in as author with only the author's own follow-up comments → Delete visible → succeeds.

- [ ] **Step 6: Commit**

```bash
git add app/[id]/[discussion]/page.tsx
git commit -m "feat(ui): delete-own-discussion button on discussion page"
```

---

### Task 5: Full test pass

- [ ] **Step 1: Run all unit tests**

Run: `pnpm vitest run`
Expected: full suite PASS.

- [ ] **Step 2: Lint / type-check**

Run: `pnpm tsc --noEmit && pnpm lint`
Expected: no errors.

- [ ] **Step 3: If clean, no further commit needed.**

---

## Self-Review Notes

- Spec coverage: permissions (T3, T4), comment gate (T1, T3, T4), hard delete (T2), UI placement (T4), edge cases (T3 tests for race/404). All covered.
- No placeholders. Every code step has full code.
- Type/name consistency: `countNonAuthorComments` / `deleteThread` referenced identically across T1, T2, T3, and the route. Route field reads `author_user_id` matching `getThread` shape (used by existing PATCH at the same path).
- File scope: matches existing patterns; no refactors.
