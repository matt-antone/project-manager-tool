# Delete own discussion (no third-party comments)

Date: 2026-05-13
Status: Draft

## Goal

Allow a discussion's author to delete it from the UI, provided no other user has commented.

## Rules

- **Permissions**: only the author (`discussion_threads.author_user_id === requester.id`) can delete.
- **Comment gate**: deletion blocked if any `discussion_comments` row exists for the thread where `author_user_id <> thread.author_user_id`. The author's own follow-up comments do not block deletion (they cascade-delete with the thread).
- **Mode**: hard delete. Row removed from `discussion_threads`.
- **Cascade behavior** (existing schema, unchanged):
  - `discussion_comments.thread_id` FK → `on delete cascade` — the author's own comments are removed automatically.
  - `project_files.thread_id` / `project_files.comment_id` FK → `on delete set null` — attached files remain in the project, unlinked from the deleted thread/comments.

## Backend

### Route — `app/projects/[id]/threads/[threadId]/route.ts`

Add `DELETE` handler mirroring the existing `PATCH` auth pattern:

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

### Repository — `lib/repositories.ts`

Two new functions placed adjacent to `editThread` / `getThread`:

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

export async function deleteThread(args: { projectId: string; threadId: string }) {
  await query(
    `delete from discussion_threads where id = $1 and project_id = $2`,
    [args.threadId, args.projectId]
  );
  await touchProjectActivity(args.projectId);
}
```

`discussion_comments` cascades automatically. `project_files` rows have `thread_id`/`comment_id` set to null (existing FK rule).

## Frontend — `app/[id]/[discussion]/page.tsx`

State and handler:

- Derive `canDelete = thread.author_user_id === currentUserId && comments.every(c => c.author_user_id === thread.author_user_id)`.
- Show a **Delete** button next to the existing **Edit** button when `canDelete` is true and the thread is not in edit mode.
- Click handler:
  1. `if (!window.confirm("Delete this discussion? This cannot be undone.")) return;`
  2. `DELETE /projects/{projectId}/threads/{discussionId}` via `authedFetch`.
  3. On success: `router.push("/${projectId}")` (project page where discussions list lives). On failure: surface status string from the response.

## Edge cases

- **Race**: another user posts a comment after the UI computed `canDelete` but before the request lands. Server re-checks and returns 403; frontend shows the error and the page refreshes the thread state on next navigation.
- **Thread already deleted in another tab**: server returns 404; frontend redirects to project page.
- **Attachments uploaded to the thread body**: not deleted from `project_files`; their `thread_id` becomes null. Acceptable — files remain accessible from the project's files view.

## Test plan

Manual:
- Author, zero comments → Delete visible → confirm → redirected to project → thread gone.
- Author, only author's own follow-up comments → Delete visible → succeeds.
- Author, one comment from another user → Delete button hidden in UI; direct DELETE request returns 403.
- Non-author viewing thread → Delete button never shown; direct DELETE request returns 403.
- Two tabs: tab A has Delete visible; user B posts a comment from tab C; tab A's Delete → 403.

## Out of scope

- Soft delete / restoration.
- Admin override.
- Bulk deletion from the discussions list.
