"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { AttachmentCollections } from "@/components/discussions/attachment-collections";
import { DiscussionComposer } from "@/components/discussions/discussion-composer";
import { MarkdownHtml } from "@/components/discussions/markdown-html";
import { InlineLoadingState, PageLoadingState } from "@/components/loading-shells";
import { OneShotButton } from "@/components/one-shot-button";
import { authedJsonFetch, ensureAccessToken, fetchAuthSession } from "@/lib/browser-auth";
import { uploadAttachment } from "@/lib/attachment-upload";
import { triggerBrowserDownload } from "@/lib/browser-download";
import { createClientResource } from "@/lib/client-resource";
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";

const MarkdownEditor = dynamic(() => import("@/components/markdown-editor"), {
  ssr: false,
  loading: () => <InlineLoadingState label="Loading editor" message="Preparing the writing surface." />
});

type SessionUser = {
  id: string;
  email?: string;
};

type Comment = {
  id: string;
  body_markdown: string;
  body_html: string;
  created_at: string;
  edited_at: string | null;
  author_user_id: string;
  author_email: string | null;
  author_first_name: string | null;
  author_last_name: string | null;
  attachments?: CommentAttachment[];
};

type CommentAttachment = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  thumbnail_url?: string | null;
  created_at: string;
};

type ThreadDetail = {
  id: string;
  title: string;
  body_html: string;
  body_markdown: string;
  edited_at: string | null;
  author_user_id: string;
  starter_email?: string | null;
  starter_first_name?: string | null;
  starter_last_name?: string | null;
  threadAttachments?: CommentAttachment[];
  comments: Comment[];
};

type PendingAttachment = {
  id: string;
  file: File;
  progress: number;
  stage: "queued" | "hashing" | "uploading" | "done" | "error";
  error?: string;
};

type DiscussionProjectSummary = {
  display_name?: string | null;
  name: string;
};

type DiscussionBootstrap = {
  currentUser: SessionUser | null;
  token: string | null;
  status: string;
  project: DiscussionProjectSummary | null;
  thread: ThreadDetail | null;
};

const discussionBootstrapResource = createClientResource(
  loadDiscussionBootstrap,
  ({ projectId, discussionId }) => `${projectId}:${discussionId}`
);

export default function DiscussionPage() {
  const params = useParams<{ id: string; discussion: string }>();
  const projectId = params?.id ?? "";
  const discussionId = params?.discussion ?? "";
  const [initial, setInitial] = useState<DiscussionBootstrap | null>(null);

  useEffect(() => {
    let cancelled = false;

    setInitial(null);
    discussionBootstrapResource.read({ projectId, discussionId }).then((nextState) => {
      if (!cancelled) {
        setInitial(nextState);
      }
    });

    return () => {
      cancelled = true;
      discussionBootstrapResource.clear({ projectId, discussionId });
    };
  }, [discussionId, projectId]);

  if (!initial) {
    return (
      <PageLoadingState
        label="Loading discussion"
        message="Bringing in the thread, comments, and attachments."
      />
    );
  }

  return <DiscussionPageContent projectId={projectId} discussionId={discussionId} initial={initial} />;
}

function DiscussionPageContent(props: {
  projectId: string;
  discussionId: string;
  initial: DiscussionBootstrap;
}) {
  const { projectId, discussionId, initial } = props;
  const projectDisplayName = initial.project?.display_name?.trim() || initial.project?.name?.trim() || "Project";
  const [currentUser] = useState<SessionUser | null>(initial.currentUser);
  const [token, setToken] = useState(initial.token);
  const [status, setStatus] = useState(initial.status);
  const [thread, setThread] = useState<ThreadDetail | null>(initial.thread);
  const [commentBody, setCommentBody] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isAttachmentDragActive, setIsAttachmentDragActive] = useState(false);
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const [newCommentEditorKey, setNewCommentEditorKey] = useState(0);
  const [isEditingThread, setIsEditingThread] = useState(false);
  const [editThreadTitle, setEditThreadTitle] = useState("");
  const [editThreadBody, setEditThreadBody] = useState("");
  const [isSavingThread, setIsSavingThread] = useState(false);
  const commentFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const threadTitle = thread?.title?.trim();
    if (threadTitle) document.title = `${threadTitle} — ${projectDisplayName}`;
    else document.title = projectDisplayName;
  }, [thread?.title, projectDisplayName]);

  async function authedFetch(accessToken: string, path: string, options: RequestInit = {}) {
    const { accessToken: nextToken, data } = await authedJsonFetch({
      accessToken,
      init: options,
      onToken: setToken,
      path
    });
    if (nextToken !== token) {
      setToken(nextToken);
    }
    return data;
  }

  async function load(accessToken: string, id: string, discussion: string) {
    const data = await authedFetch(accessToken, `/projects/${id}/threads/${discussion}`);
    setThread((data?.thread ?? null) as ThreadDetail | null);
    setStatus("Ready");
  }

  async function addComment() {
    if (!token) {
      throw new Error("Your session expired. Refresh and sign in again.");
    }
    if (!projectId || !discussionId) {
      throw new Error("Missing discussion context. Reload the page and try again.");
    }
    const attachmentsToUpload = pendingAttachments.filter((attachment) => attachment.stage !== "done");
    let failedUploads = 0;
    const created = await authedFetch(token, `/projects/${projectId}/threads/${discussionId}/comments`, {
      method: "POST",
      body: JSON.stringify({ bodyMarkdown: commentBody })
    });
    const createdCommentId =
      created && typeof created === "object" && "comment" in created
        ? ((created.comment as { id?: string } | null | undefined)?.id ?? undefined)
        : undefined;
    if (createdCommentId && attachmentsToUpload.length > 0) {
      setIsUploadingAttachments(true);
      try {
        for (const attachment of attachmentsToUpload) {
          try {
            setPendingAttachmentState(attachment.id, { stage: "hashing", progress: 10, error: undefined });
            await uploadAttachment({
              token,
              onToken: setToken,
              projectId,
              threadId: discussionId,
              commentId: createdCommentId,
              file: attachment.file,
              onUploadProgress: (uploadProgress) =>
                setPendingAttachmentState(attachment.id, {
                  stage: "uploading",
                  progress: Math.max(20, Math.min(95, Math.round(20 + uploadProgress * 75)))
                })
            });
            setPendingAttachmentState(attachment.id, { stage: "done", progress: 100, error: undefined });
          } catch (error) {
            failedUploads += 1;
            setPendingAttachmentState(attachment.id, {
              stage: "error",
              error: error instanceof Error ? error.message : "Upload failed"
            });
          }
        }
        if (failedUploads > 0) {
          setStatus(`Comment saved. ${failedUploads} attachment(s) failed to upload.`);
        }
      } finally {
        setIsUploadingAttachments(false);
      }
    }
    setCommentBody("");
    if (failedUploads === 0) {
      setPendingAttachments([]);
    } else {
      setPendingAttachments((current) => current.filter((attachment) => attachment.stage === "error"));
    }
    if (commentFileInputRef.current && failedUploads === 0) {
      commentFileInputRef.current.value = "";
    }
    setNewCommentEditorKey((current) => current + 1);
    await load(token, projectId, discussionId);
  }

  async function saveEditedComment() {
    if (!token) {
      throw new Error("Your session expired. Refresh and sign in again.");
    }
    if (!projectId || !discussionId || !editingCommentId || !editingBody.trim()) {
      throw new Error("Unable to save comment edits. Reload and try again.");
    }
    await authedFetch(token, `/projects/${projectId}/threads/${discussionId}/comments/${editingCommentId}`, {
      method: "PATCH",
      body: JSON.stringify({ bodyMarkdown: editingBody })
    });
    setEditingCommentId(null);
    setEditingBody("");
    await load(token, projectId, discussionId);
  }

  function startEditingComment(comment: Comment) {
    setEditingCommentId(comment.id);
    setEditingBody(comment.body_markdown);
  }

  function startEditingThread() {
    if (!thread) return;
    setEditThreadTitle(thread.title);
    setEditThreadBody(thread.body_markdown ?? "");
    setIsEditingThread(true);
  }

  function cancelEditingThread() {
    setIsEditingThread(false);
  }

  const router = useRouter();

  async function deleteThreadAction() {
    if (!projectId || !discussionId) return;
    if (!window.confirm("Delete this discussion? This cannot be undone.")) return;
    try {
      if (!token) throw new Error("Sign in to delete this discussion.");
      await authedFetch(token, `/projects/${projectId}/threads/${discussionId}`, {
        method: "DELETE"
      });
      router.push(`/${projectId}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete discussion");
    }
  }

  async function saveThreadEdit() {
    if (!thread || !token) return;
    setIsSavingThread(true);
    try {
      const data = await authedFetch(token, `/projects/${projectId}/threads/${thread.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: editThreadTitle, bodyMarkdown: editThreadBody })
      });
      const updated = (data as { thread?: typeof thread }).thread;
      if (updated) {
        setThread((prev) => (prev ? { ...prev, ...updated } : prev));
      }
      setIsEditingThread(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save discussion edit");
    } finally {
      setIsSavingThread(false);
    }
  }

  async function openDownload(fileId: string) {
    if (!token || !projectId) return;
    const data = await authedFetch(token, `/projects/${projectId}/files/${fileId}/download-link`);
    const downloadUrl = typeof data?.url === "string" ? data.url : "";
    const filename = typeof data?.filename === "string" ? data.filename : "";
    if (downloadUrl && filename) {
      await triggerBrowserDownload({ url: downloadUrl, filename });
    } else if (downloadUrl) {
      window.open(downloadUrl, "_blank", "noopener,noreferrer");
    }
  }

  function setPendingAttachmentState(id: string, partial: Partial<PendingAttachment>) {
    setPendingAttachments((current) =>
      current.map((attachment) => (attachment.id === id ? { ...attachment, ...partial } : attachment))
    );
  }

  function addPendingFiles(files: FileList | File[]) {
    const nextFiles = Array.from(files);
    if (nextFiles.length === 0) return;

    setPendingAttachments((current) => {
      const existingKeys = new Set(
        current.map((attachment) => `${attachment.file.name}:${attachment.file.size}:${attachment.file.lastModified}`)
      );
      const additions: PendingAttachment[] = [];
      for (const file of nextFiles) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (existingKeys.has(key)) {
          continue;
        }
        existingKeys.add(key);
        additions.push({
          id: crypto.randomUUID(),
          file,
          progress: 0,
          stage: "queued"
        });
      }
      return [...current, ...additions];
    });
  }

  function removePendingAttachment(id: string) {
    setPendingAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  function getPersonLabel(person: {
    author_email?: string | null;
    author_first_name?: string | null;
    author_last_name?: string | null;
    starter_email?: string | null;
    starter_first_name?: string | null;
    starter_last_name?: string | null;
  }) {
    const firstName = (person.author_first_name ?? person.starter_first_name ?? "").trim();
    const lastName = (person.author_last_name ?? person.starter_last_name ?? "").trim();
    const fullName = `${firstName} ${lastName}`.trim();
    return fullName || person.author_email || person.starter_email || "Team member";
  }

  function getPersonInitials(person: Parameters<typeof getPersonLabel>[0]) {
    const firstName = (person.author_first_name ?? person.starter_first_name ?? "").trim();
    const lastName = (person.author_last_name ?? person.starter_last_name ?? "").trim();
    if (firstName || lastName) {
      return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase() || "TM";
    }

    const emailLocal = (person.author_email ?? person.starter_email ?? "team.member").split("@")[0];
    const parts = emailLocal.split(/[._\-\s]+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
    }

    return emailLocal.slice(0, 2).toUpperCase() || "TM";
  }

  return (
    <main className="page">
      <header className="header discussionPageHeader">
        <div className="discussionPageHeaderTitles">
          <h1 className="discussionProjectTitle">
            <Link href={`/${projectId}`}>{projectDisplayName}</Link>
          </h1>
          <h2 className="discussionThreadTitle">{thread?.title ?? "Discussion"}</h2>
        </div>
        <div className="row">
          <Link href={`/${projectId}`} className="linkButton">
            Back to Project
          </Link>
          <Link href="/" className="linkButton secondaryLink">
            All Projects
          </Link>
        </div>
      </header>

      <p className="status">{status}</p>

      {thread && (
        <>
          <section className="discussionSection">
            <div className="discussionLeadMeta">
              <span className="discussionAvatarFallback" aria-hidden="true">
                {getPersonInitials(thread)}
              </span>
              <div className="discussionLeadMetaCopy">
                <strong>{getPersonLabel(thread)}</strong>
                <small>
                  Started the thread
                  {thread.edited_at ? " (edited)" : ""}
                </small>
                {currentUser?.id === thread.author_user_id && !isEditingThread && (
                  <>
                    <OneShotButton type="button" className="terciary" onClick={startEditingThread}>
                      Edit
                    </OneShotButton>
                    {thread.comments.every((c) => c.author_user_id === thread.author_user_id) && (
                      <OneShotButton type="button" className="terciary" onClick={deleteThreadAction}>
                        Delete
                      </OneShotButton>
                    )}
                  </>
                )}
              </div>
            </div>
            {isEditingThread ? (
              <div className="editorWrap">
                <input
                  className="dialogField"
                  value={editThreadTitle}
                  onChange={(e) => setEditThreadTitle(e.target.value)}
                  aria-label="Edit discussion title"
                />
                <MarkdownEditor
                  key={`edit-thread-${thread.id}`}
                  markdown={editThreadBody}
                  onChange={setEditThreadBody}
                  placeholder="Edit discussion in markdown"
                />
                <div className="row">
                  <OneShotButton
                    type="button"
                    onClick={saveThreadEdit}
                    disabled={!editThreadTitle.trim() || !editThreadBody.trim() || isSavingThread}
                  >
                    {isSavingThread ? "Saving…" : "Save"}
                  </OneShotButton>
                  <OneShotButton type="button" className="secondary" onClick={cancelEditingThread} disabled={isSavingThread}>
                    Cancel
                  </OneShotButton>
                </div>
              </div>
            ) : (
              <>
                <MarkdownHtml html={thread.body_html} />
                {(thread.threadAttachments?.length ?? 0) > 0 && (
                  <div className="commentAttachmentStack">
                    <AttachmentCollections
                      attachments={thread.threadAttachments ?? []}
                      projectId={projectId}
                      token={token}
                      onToken={setToken}
                      onDownload={openDownload}
                      onError={setStatus}
                    />
                  </div>
                )}
              </>
            )}
          </section>

          <section className="discussionSection">
            <ul className="discussionCommentList">
              {thread.comments.map((comment) => (
                <li key={comment.id} className="discussionCommentRow">
                  <span className="discussionAvatarFallback" aria-hidden="true">
                    {getPersonInitials(comment)}
                  </span>
                  <div className="projectMain">
                    <div className="discussionCommentHeader">
                      <div className="discussionCommentMeta">
                        <strong>{getPersonLabel(comment)}</strong>
                        <small>
                          {new Date(comment.created_at).toLocaleString()}
                          {comment.edited_at ? " (edited)" : ""}
                        </small>
                        {currentUser?.id === comment.author_user_id && editingCommentId !== comment.id && (
                          <OneShotButton type="button" className="terciary" onClick={() => startEditingComment(comment)}>
                            Edit
                          </OneShotButton>
                        )}
                      </div>
                    </div>
                    {editingCommentId === comment.id ? (
                      <div className="editorWrap">
                        <MarkdownEditor
                          key={`edit-${comment.id}`}
                          markdown={editingBody}
                          onChange={setEditingBody}
                          placeholder="Edit comment in markdown"
                        />
                        <div className="row">
                          <OneShotButton
                            onClick={() => saveEditedComment().catch((error) => setStatus(error.message))}
                            disabled={!editingBody.trim()}
                          >
                            Save
                          </OneShotButton>
                          <OneShotButton
                            type="button"
                            className="secondary"
                            onClick={() => {
                              setEditingCommentId(null);
                              setEditingBody("");
                            }}
                          >
                            Cancel
                          </OneShotButton>
                        </div>
                      </div>
                    ) : (
                      <>
                        <MarkdownHtml html={comment.body_html} />
                        {(comment.attachments?.length ?? 0) > 0 && (
                          <div className="commentAttachmentStack">
                            <AttachmentCollections
                              attachments={comment.attachments ?? []}
                              projectId={projectId}
                              token={token}
                              onToken={setToken}
                              onDownload={openDownload}
                              onError={setStatus}
                            />
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
          <DiscussionComposer
            editor={(
              <MarkdownEditor
                key={`new-${newCommentEditorKey}`}
                markdown={commentBody}
                onChange={setCommentBody}
                placeholder="Reply in markdown"
              />
            )}
            commentFileInputRef={commentFileInputRef}
            pendingAttachments={pendingAttachments}
            isAttachmentDragActive={isAttachmentDragActive}
            isUploadingAttachments={isUploadingAttachments}
            canSubmit={Boolean(commentBody.trim()) && !isUploadingAttachments}
            submitLabel={isUploadingAttachments ? "Uploading..." : "Add Comment"}
            onSetAttachmentDragActive={setIsAttachmentDragActive}
            onAddPendingFiles={addPendingFiles}
            onRemovePendingAttachment={removePendingAttachment}
            onSubmit={() => addComment().catch((error) => setStatus(error.message))}
            formatAttachmentStage={formatAttachmentStage}
          />
        </>
      )}
    </main>
  );
}

function formatAttachmentStage(attachment: PendingAttachment) {
  if (attachment.stage === "queued") return "Queued";
  if (attachment.stage === "hashing") return "Preparing";
  if (attachment.stage === "uploading") return `${attachment.progress}%`;
  if (attachment.stage === "done") return "Uploaded";
  return "Failed";
}

async function loadDiscussionBootstrap(params: {
  projectId: string;
  discussionId: string;
}): Promise<DiscussionBootstrap> {
  const { projectId, discussionId } = params;

  if (!projectId || !discussionId) {
    return {
      currentUser: null,
      token: null,
      status: "Loading discussion…",
      project: null,
      thread: null
    };
  }

  try {
    const session = await fetchAuthSession();
    const accessToken = session.accessToken;

    if (!accessToken) {
      return {
        currentUser: null,
        token: null,
        status: session.status || "Sign in first",
        project: null,
        thread: null
      };
    }

    const [threadResponse, projectResponse] = await Promise.all([
      authedJsonFetch({
        accessToken,
        path: `/projects/${projectId}/threads/${discussionId}`
      }),
      authedJsonFetch({
        accessToken,
        path: `/projects/${projectId}`
      })
    ]);
    const project = (projectResponse.data?.project ?? null) as DiscussionProjectSummary | null;
    return {
      currentUser: session.user,
      token: projectResponse.accessToken,
      status: session.status,
      project,
      thread: (threadResponse.data?.thread ?? null) as ThreadDetail | null
    };
  } catch (error) {
    return {
      currentUser: null,
      token: null,
      status: error instanceof Error ? error.message : "Load failed",
      project: null,
      thread: null
    };
  }
}
