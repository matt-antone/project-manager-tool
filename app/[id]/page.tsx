"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { CreateDiscussionDialog } from "@/components/discussions/create-discussion-dialog";
import { InlineLoadingState, PageLoadingState } from "@/components/loading-shells";
import { OneShotButton } from "@/components/one-shot-button";
import { ProjectDialogForm, type ProjectDialogValues } from "@/components/project-dialog-form";
// import { ProjectTagList } from "@/components/project-tag-list";
import { ProjectFilesPanel } from "@/components/projects/project-files-panel";
import { authedJsonFetch, fetchAuthSession } from "@/lib/browser-auth";
import { triggerBrowserDownload } from "@/lib/browser-download";
import { createClientResource } from "@/lib/client-resource";
import { calculateProjectExpensesTotalUsd, formatUsdInput, formatUsdMoney } from "@/lib/project-financials";
import {
  collectNewOrUpdatedIds,
  collectNewIds,
  hasDirtyProjectPageDrafts,
  isNewerProjectUpdate
} from "@/lib/project-page-polling";
import { renderMarkdown } from "@/lib/markdown";
import { createProjectDialogValues, formatProjectDeadlineLocal, normalizeProjectColumn, parseProjectTags } from "@/lib/project-utils";
import type { ClientRecord } from "@/lib/types/client-record";
import { postBytesToDropbox, uploadAttachment } from "@/lib/attachment-upload";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

const MarkdownEditor = dynamic(() => import("@/components/markdown-editor"), {
  ssr: false,
  loading: () => <InlineLoadingState label="Loading editor" message="Preparing the writing surface." />
});

type Project = {
  id: string;
  name: string;
  display_name?: string | null;
  description: string | null;
  deadline?: string | null;
  tags?: string[] | null;
  status?: string | null;
  archived?: boolean;
  client_id: string | null;
  client_name?: string | null;
  client_code?: string | null;
  requestor?: string | null;
  updated_at?: string | null;
  last_activity_at?: string | null;
  /** PM-facing note (max 256); optional until migration applied. */
  pm_note?: string | null;
  my_hours?: number | string | null;
};

type ProjectUserHoursEntry = {
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
};

type Thread = {
  id: string;
  title: string;
  body_html: string;
  created_at: string;
  updated_at?: string | null;
  activity_updated_at?: string | null;
  starter_email: string | null;
  starter_first_name: string | null;
  starter_last_name: string | null;
};

type ProjectFile = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  thumbnail_url?: string | null;
  created_at: string;
};

type ViewerProfile = {
  email: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
};

type ProjectPageBootstrap = {
  token: string | null;
  status: string;
  project: Project | null;
  userHours: ProjectUserHoursEntry[];
  expenseLines: ProjectExpenseLine[];
  clients: ClientRecord[];
  viewerProfile: ViewerProfile | null;
  threads: Thread[];
  files: ProjectFile[];
};

const projectBootstrapResource = createClientResource(loadProjectBootstrap, (projectId) => projectId);
const PROJECT_PAGE_POLL_INTERVAL_MS = 5 * 60 * 1000;

export default function ProjectPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const [initial, setInitial] = useState<ProjectPageBootstrap | null>(null);

  useEffect(() => {
    let cancelled = false;

    setInitial(null);
    projectBootstrapResource.read(projectId).then((nextState) => {
      if (!cancelled) {
        setInitial(nextState);
      }
    });

    return () => {
      cancelled = true;
      projectBootstrapResource.clear(projectId);
    };
  }, [projectId]);

  if (!initial) {
    return (
      <PageLoadingState
        label="Loading project"
        message="Pulling together project details, discussions, and files."
      />
    );
  }

  return <ProjectPageContent projectId={projectId} initial={initial} />;
}

function ProjectPageContent({ projectId, initial }: { projectId: string; initial: ProjectPageBootstrap }) {
  const [token, setToken] = useState(initial.token);
  const [, setStatus] = useState(initial.status);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [project, setProject] = useState<Project | null>(initial.project);
  const [userHours, setUserHours] = useState<ProjectUserHoursEntry[]>(initial.userHours);
  const [expenseLines, setExpenseLines] = useState<ProjectExpenseLine[]>(initial.expenseLines);
  const [clients, setClients] = useState<ClientRecord[]>(initial.clients);
  const [viewerProfile, setViewerProfile] = useState<ViewerProfile | null>(initial.viewerProfile);
  const [threads, setThreads] = useState<Thread[]>(initial.threads);
  const [files, setFiles] = useState<ProjectFile[]>(initial.files);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isFileDragActive, setIsFileDragActive] = useState(false);
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [isSavingMyHours, setIsSavingMyHours] = useState(false);
  const [isRestoringProject, setIsRestoringProject] = useState(false);
  const [savingArchivedHoursUserId, setSavingArchivedHoursUserId] = useState<string | null>(null);
  const [savingExpenseLineId, setSavingExpenseLineId] = useState<string | null>(null);
  const [deletingExpenseLineId, setDeletingExpenseLineId] = useState<string | null>(null);
  const [isCreatingExpenseLine, setIsCreatingExpenseLine] = useState(false);
  const [projectForm, setProjectForm] = useState<ProjectDialogValues>(createProjectDialogValues());
  const [title, setTitle] = useState("");
  const [bodyMarkdown, setBodyMarkdown] = useState("");
  const [myHoursInput, setMyHoursInput] = useState("");
  const [archivedHoursInputs, setArchivedHoursInputs] = useState<Record<string, string>>({});
  const [expenseLineDrafts, setExpenseLineDrafts] = useState<Record<string, { label: string; amount: string }>>({});
  const [newExpenseLine, setNewExpenseLine] = useState({ label: "", amount: "" });
  const [createDiscussionEditorKey, setCreateDiscussionEditorKey] = useState(0);

  type DiscussionPendingAttachment = {
    id: string;
    file: File;
    progress: number;
    stage: "queued" | "uploading" | "done" | "error";
    error?: string;
  };

  const [discussionAttachments, setDiscussionAttachments] = useState<DiscussionPendingAttachment[]>([]);
  const [isUploadingDiscussionAttachments, setIsUploadingDiscussionAttachments] = useState(false);
  const discussionFileInputRef = useRef<HTMLInputElement | null>(null);

  function setDiscussionAttachmentState(attId: string, partial: Partial<DiscussionPendingAttachment>) {
    setDiscussionAttachments((current) =>
      current.map((a) => (a.id === attId ? { ...a, ...partial } : a))
    );
  }

  function addDiscussionPendingFiles(files: FileList | File[]) {
    const nextFiles = Array.from(files);
    if (nextFiles.length === 0) return;
    setDiscussionAttachments((current) => {
      const existingKeys = new Set(
        current.map((a) => `${a.file.name}:${a.file.size}:${a.file.lastModified}`)
      );
      const additions: DiscussionPendingAttachment[] = [];
      for (const file of nextFiles) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        additions.push({ id: crypto.randomUUID(), file, progress: 0, stage: "queued" });
      }
      return [...current, ...additions];
    });
  }

  function removeDiscussionAttachment(attId: string) {
    setDiscussionAttachments((current) => current.filter((a) => a.id !== attId));
  }

  const [members, setMembers] = useState<{
    user_id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
  }[]>([]);
  const [activeUsers, setActiveUsers] = useState<{
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
  }[]>([]);
  const projectActivityUpdatedDateRef = useRef(getProjectActivityUpdatedDate(initial.project));
  const pendingProjectRefreshRef = useRef<string | null>(null);
  const seenThreadIdsRef = useRef(new Set(initial.threads.map((thread) => thread.id)));
  const seenThreadActivityUpdatedAtRef = useRef(createThreadActivityMap(initial.threads));
  const seenFileIdsRef = useRef(new Set(initial.files.map((file) => file.id)));
  const seenExpenseLineIdsRef = useRef(new Set(initial.expenseLines.map((line) => line.id)));
  const [newThreadIds, setNewThreadIds] = useState<Set<string>>(() => new Set());
  const [newFileIds, setNewFileIds] = useState<Set<string>>(() => new Set());
  const [newExpenseLineIds, setNewExpenseLineIds] = useState<Set<string>>(() => new Set());
  const editProjectDialogRef = useRef<HTMLDialogElement | null>(null);
  const createDiscussionDialogRef = useRef<HTMLDialogElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  const load = useCallback(async (accessToken: string, id: string) => {
    const nextState = await loadProjectData(accessToken, id);
    setProject(nextState.project);
    setUserHours(nextState.userHours);
    setExpenseLines(nextState.expenseLines);
    setThreads(nextState.threads);
    setFiles(nextState.files);
    setClients(nextState.clients);
    setViewerProfile(nextState.viewerProfile);
    nextState.threads.forEach((thread) => {
      seenThreadIdsRef.current.add(thread.id);
      updateSeenThreadActivity(thread, seenThreadActivityUpdatedAtRef.current);
    });
    nextState.files.forEach((file) => seenFileIdsRef.current.add(file.id));
    nextState.expenseLines.forEach((line) => seenExpenseLineIdsRef.current.add(line.id));
    projectActivityUpdatedDateRef.current = getProjectActivityUpdatedDate(nextState.project);
    setStatus("Ready");
  }, []);

  const applyPolledProjectData = useCallback((
    nextState: Awaited<ReturnType<typeof loadProjectData>>,
    updatedDate: string
  ) => {
    const nextNewThreadIds = collectNewOrUpdatedIds(
      nextState.threads,
      seenThreadIdsRef.current,
      seenThreadActivityUpdatedAtRef.current,
      getThreadActivityUpdatedAt
    );
    const nextNewFileIds = collectNewIds(nextState.files, seenFileIdsRef.current);
    const nextNewExpenseLineIds = collectNewIds(nextState.expenseLines, seenExpenseLineIdsRef.current);

    setNewThreadIds((current) => new Set([...current, ...nextNewThreadIds]));
    setNewFileIds((current) => new Set([...current, ...nextNewFileIds]));
    setNewExpenseLineIds((current) => new Set([...current, ...nextNewExpenseLineIds]));

    setProject(nextState.project);
    setUserHours(nextState.userHours);
    setExpenseLines(nextState.expenseLines);
    setThreads(nextState.threads);
    setFiles(nextState.files);
    setClients(nextState.clients);
    setViewerProfile(nextState.viewerProfile);

    nextState.threads.forEach((thread) => {
      seenThreadIdsRef.current.add(thread.id);
      updateSeenThreadActivity(thread, seenThreadActivityUpdatedAtRef.current);
    });
    nextState.files.forEach((file) => seenFileIdsRef.current.add(file.id));
    nextState.expenseLines.forEach((line) => seenExpenseLineIdsRef.current.add(line.id));
    projectActivityUpdatedDateRef.current = updatedDate;
    pendingProjectRefreshRef.current = null;
  }, []);

  useEffect(() => {
    setProjectForm(createProjectDialogValues(project?.client_id ?? "", project));
    setMyHoursInput(formatHoursInput(project?.my_hours));
  }, [project]);

  useEffect(() => {
    const title = project?.display_name?.trim() || project?.name?.trim();
    if (title) document.title = title;
  }, [project?.display_name, project?.name]);

  useEffect(() => {
    setArchivedHoursInputs(
      Object.fromEntries(userHours.map((entry) => [entry.userId, formatHoursInput(entry.hours)]))
    );
  }, [userHours]);

  useEffect(() => {
    setExpenseLineDrafts(
      Object.fromEntries(
        expenseLines.map((entry) => [
          entry.id,
          {
            label: entry.label,
            amount: formatUsdInput(entry.amount)
          }
        ])
      )
    );
  }, [expenseLines]);

  const isProjectPageDirty = hasDirtyProjectPageDrafts({
    projectFormDirty: JSON.stringify(projectForm) !== JSON.stringify(createProjectDialogValues(project?.client_id ?? "", project)),
    myHoursDirty: myHoursInput !== formatHoursInput(project?.my_hours),
    archivedHoursDirty: userHours.some(
      (entry) => archivedHoursInputs[entry.userId] !== formatHoursInput(entry.hours)
    ),
    expenseDraftsDirty: expenseLines.some((line) => {
      const draft = expenseLineDrafts[line.id] ?? {
        label: line.label,
        amount: formatUsdInput(line.amount)
      };
      return draft.label !== line.label || draft.amount !== formatUsdInput(line.amount);
    }),
    newExpenseDirty: newExpenseLine.label.trim() !== "" || newExpenseLine.amount.trim() !== "",
    fileQueued: selectedFile !== null,
    createDiscussionDirty: title.trim() !== "" || bodyMarkdown.trim() !== "",
    mutationInFlight: isUploading ||
      isSavingProject ||
      isSavingMyHours ||
      isRestoringProject ||
      savingArchivedHoursUserId !== null ||
      savingExpenseLineId !== null ||
      deletingExpenseLineId !== null ||
      isCreatingExpenseLine
  });

  useEffect(() => {
    if (!token || !projectId) return;

    let cancelled = false;

    async function pollProjectUpdatedDate() {
      if (!token || !projectId) return;
      const data = await authedFetch(token, `/projects/${projectId}/updated-date`);
      if (cancelled) return;
      const updatedDate = typeof data?.updatedDate === "string" ? data.updatedDate : null;
      if (!isNewerProjectUpdate(updatedDate, projectActivityUpdatedDateRef.current)) {
        return;
      }
      if (isProjectPageDirty) {
        pendingProjectRefreshRef.current = updatedDate;
        return;
      }

      const nextState = await loadProjectData(token, projectId);
      if (cancelled) return;
      if (updatedDate) {
        applyPolledProjectData(nextState, updatedDate);
      }
    }

    const intervalId = window.setInterval(() => {
      pollProjectUpdatedDate().catch((error) => {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : "Project refresh failed");
        }
      });
    }, PROJECT_PAGE_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [token, projectId, load, isProjectPageDirty, applyPolledProjectData]);

  useEffect(() => {
    if (!token || !projectId || isProjectPageDirty) return;

    const pendingUpdatedDate = pendingProjectRefreshRef.current;
    if (!pendingUpdatedDate) return;

    if (!isNewerProjectUpdate(pendingUpdatedDate, projectActivityUpdatedDateRef.current)) {
      pendingProjectRefreshRef.current = null;
      return;
    }

    let cancelled = false;

    loadProjectData(token, projectId)
      .then((nextState) => {
        if (!cancelled) {
          applyPolledProjectData(nextState, pendingUpdatedDate);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : "Project refresh failed");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token, projectId, isProjectPageDirty, applyPolledProjectData]);

  function getStarterLabel(thread: Thread) {
    const fullName = `${thread.starter_first_name ?? ""} ${thread.starter_last_name ?? ""}`.trim();
    return fullName || thread.starter_email || "Starter";
  }

  function getStarterInitials(thread: Thread) {
    const first = (thread.starter_first_name ?? "").trim();
    const last = (thread.starter_last_name ?? "").trim();
    if (first || last) {
      return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase() || "S";
    }

    const emailLocalPart = (thread.starter_email ?? "starter").split("@")[0];
    const emailWords = emailLocalPart.split(/[._\-\s]+/).filter(Boolean);
    if (emailWords.length >= 2) {
      return `${emailWords[0].charAt(0)}${emailWords[1].charAt(0)}`.toUpperCase();
    }

    return emailLocalPart.slice(0, 2).toUpperCase() || "S";
  }

  async function createDiscussion() {
    if (!token) {
      throw new Error("Your session expired. Refresh and sign in again.");
    }
    if (!projectId) return;
    const created = await authedFetch(token, `/projects/${projectId}/threads`, {
      method: "POST",
      body: JSON.stringify({ title, bodyMarkdown })
    });
    const thread = (created?.thread ?? null) as Thread | null;
    if (thread) {
      seenThreadIdsRef.current.add(thread.id);
      updateSeenThreadActivity(thread, seenThreadActivityUpdatedAtRef.current);
    }
    const newThreadId =
      created && typeof created === "object" && "thread" in created
        ? ((created.thread as { id?: string } | null | undefined)?.id ?? undefined)
        : undefined;

    let failedUploads = 0;
    const attachmentsToUpload = discussionAttachments.filter((a) => a.stage !== "done");
    if (newThreadId && attachmentsToUpload.length > 0) {
      setIsUploadingDiscussionAttachments(true);
      try {
        for (const attachment of attachmentsToUpload) {
          try {
            setDiscussionAttachmentState(attachment.id, { stage: "uploading", progress: 10, error: undefined });
            await uploadAttachment({
              token,
              onToken: setToken,
              projectId,
              threadId: newThreadId,
              file: attachment.file,
              onUploadProgress: (uploadProgress) =>
                setDiscussionAttachmentState(attachment.id, {
                  stage: "uploading",
                  progress: Math.max(20, Math.min(95, Math.round(20 + uploadProgress * 75)))
                })
            });
            setDiscussionAttachmentState(attachment.id, { stage: "done", progress: 100, error: undefined });
          } catch (error) {
            failedUploads += 1;
            setDiscussionAttachmentState(attachment.id, {
              stage: "error",
              error: error instanceof Error ? error.message : "Upload failed"
            });
          }
        }
        if (failedUploads > 0) {
          setStatus(`Discussion saved. ${failedUploads} attachment(s) failed to upload.`);
        }
      } finally {
        setIsUploadingDiscussionAttachments(false);
      }
    }

    setTitle("");
    setBodyMarkdown("");
    if (failedUploads === 0) {
      setDiscussionAttachments([]);
    } else {
      setDiscussionAttachments((current) => current.filter((a) => a.stage === "error"));
    }
    if (discussionFileInputRef.current && failedUploads === 0) {
      discussionFileInputRef.current.value = "";
    }
    setCreateDiscussionEditorKey((k) => k + 1);
    createDiscussionDialogRef.current?.close();

    if (token) {
      await load(token, projectId);
    }
  }

  async function saveProject() {
    if (!token || !projectId || !project || !project.client_id) return;

    setIsSavingProject(true);
    try {
      await authedFetch(token, `/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: projectForm.name,
          description: projectForm.description,
          deadline: projectForm.deadline || null,
          clientId: project.client_id,
          tags: parseProjectTags(projectForm.tags),
          requestor: projectForm.requestor.trim() || null,
          pm_note: projectForm.pm_note.trim() || null
        })
      });
      await load(token, projectId);
      editProjectDialogRef.current?.close();
      setStatus("Project updated");
    } finally {
      setIsSavingProject(false);
    }
  }

  async function saveMyHours() {
    if (!token || !projectId) return;

    const trimmedHours = myHoursInput.trim();
    const parsedHours = trimmedHours ? Number(trimmedHours) : Number.NaN;
    if (trimmedHours && (!Number.isFinite(parsedHours) || parsedHours < 0)) {
      throw new Error("My hours must be a non-negative number");
    }

    setIsSavingMyHours(true);
    try {
      const data = await authedFetch(token, `/projects/${projectId}/my-hours`, {
        method: "PATCH",
        body: JSON.stringify({
          hours: trimmedHours ? parsedHours : null
        })
      });
      setProject((data?.project ?? null) as Project | null);
      setUserHours(((data?.userHours ?? []) as ProjectUserHoursEntry[]));
      setStatus("My hours saved");
    } finally {
      setIsSavingMyHours(false);
    }
  }

  async function saveArchivedHours(userId: string) {
    if (!token || !projectId) return;

    const inputValue = (archivedHoursInputs[userId] ?? "").trim();
    const parsedHours = inputValue ? Number(inputValue) : Number.NaN;
    if (inputValue && (!Number.isFinite(parsedHours) || parsedHours < 0)) {
      throw new Error("Team hours must be a non-negative number");
    }

    setSavingArchivedHoursUserId(userId);
    try {
      const data = await authedFetch(token, `/projects/${projectId}/archived-hours`, {
        method: "PATCH",
        body: JSON.stringify({
          userId,
          hours: inputValue ? parsedHours : null
        })
      });
      setProject((data?.project ?? null) as Project | null);
      setUserHours(((data?.userHours ?? []) as ProjectUserHoursEntry[]));
      setStatus("Team hours saved");
    } finally {
      setSavingArchivedHoursUserId(null);
    }
  }

  async function createExpenseLine() {
    if (!token || !projectId) return;

    const label = newExpenseLine.label.trim();
    const amountValue = newExpenseLine.amount.trim();
    const amount = amountValue ? Number(amountValue) : Number.NaN;
    if (!label) {
      throw new Error("Expense label is required");
    }
    if (!amountValue || !Number.isFinite(amount) || amount < 0) {
      throw new Error("Expense amount must be a non-negative number");
    }

    setIsCreatingExpenseLine(true);
    try {
      const data = await authedFetch(token, `/projects/${projectId}/expense-lines`, {
        method: "POST",
        body: JSON.stringify({
          label,
          amount
        })
      });
      const created = (data?.expenseLine ?? null) as ProjectExpenseLine | null;
      if (created) {
        seenExpenseLineIdsRef.current.add(created.id);
        setExpenseLines((current) => [...current, created]);
        setNewExpenseLine({ label: "", amount: "" });
      }
      setStatus("Expense line added");
    } finally {
      setIsCreatingExpenseLine(false);
    }
  }

  async function saveExpenseLine(lineId: string) {
    if (!token || !projectId) return;

    const draft = expenseLineDrafts[lineId];
    const label = draft?.label.trim() ?? "";
    const amountValue = draft?.amount.trim() ?? "";
    const amount = amountValue ? Number(amountValue) : Number.NaN;
    const existing = expenseLines.find((entry) => entry.id === lineId);
    if (!existing) {
      return;
    }
    if (!label) {
      throw new Error("Expense label is required");
    }
    if (!amountValue || !Number.isFinite(amount) || amount < 0) {
      throw new Error("Expense amount must be a non-negative number");
    }

    setSavingExpenseLineId(lineId);
    try {
      const data = await authedFetch(token, `/projects/${projectId}/expense-lines/${lineId}`, {
        method: "PATCH",
        body: JSON.stringify({
          label,
          amount,
          sortOrder: existing.sortOrder
        })
      });
      const updated = (data?.expenseLine ?? null) as ProjectExpenseLine | null;
      if (updated) {
        setExpenseLines((current) => current.map((entry) => (entry.id === lineId ? updated : entry)));
      }
      setStatus("Expense line saved");
    } finally {
      setSavingExpenseLineId(null);
    }
  }

  async function deleteExpenseLine(lineId: string) {
    if (!token || !projectId) return;

    setDeletingExpenseLineId(lineId);
    try {
      await authedFetch(token, `/projects/${projectId}/expense-lines/${lineId}`, {
        method: "DELETE"
      });
      setExpenseLines((current) => current.filter((entry) => entry.id !== lineId));
      setExpenseLineDrafts((current) => {
        const next = { ...current };
        delete next[lineId];
        return next;
      });
      setStatus("Expense line deleted");
    } finally {
      setDeletingExpenseLineId(null);
    }
  }

  async function restoreArchivedProject() {
    if (!token || !projectId) return;

    setIsRestoringProject(true);
    try {
      await authedFetch(token, `/projects/${projectId}/restore`, { method: "POST" });
      await load(token, projectId);
      setStatus("Project restored");
    } finally {
      setIsRestoringProject(false);
    }
  }

  async function loadMembersAndActiveUsers() {
    if (!token || !projectId) return;
    try {
      const [membersBody, usersBody] = await Promise.all([
        authedFetch(token, `/projects/${projectId}/members`) as Promise<{ members?: typeof members }>,
        authedFetch(token, `/users/active`) as Promise<{ users?: typeof activeUsers }>
      ]);
      if (Array.isArray(membersBody?.members)) setMembers(membersBody.members);
      if (Array.isArray(usersBody?.users)) setActiveUsers(usersBody.users);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load members");
    }
  }

  function openEditProjectDialog() {
    setProjectForm(createProjectDialogValues(project?.client_id ?? "", project));
    loadMembersAndActiveUsers();
    editProjectDialogRef.current?.showModal();
  }

  async function handleAddMember(userId: string) {
    if (!token) return;
    const target = activeUsers.find((u) => u.id === userId);
    if (!target) return;
    const previous = members;
    setMembers((prev) => [
      ...prev,
      { user_id: target.id, email: target.email, first_name: target.first_name, last_name: target.last_name }
    ]);
    try {
      await authedFetch(token, `/projects/${projectId}/members`, {
        method: "POST",
        body: JSON.stringify({ userId })
      });
    } catch (error) {
      setMembers(previous);
      setStatus(error instanceof Error ? error.message : "Could not add member");
    }
  }

  async function handleRemoveMember(userId: string) {
    if (!token) return;
    const previous = members;
    setMembers((prev) => prev.filter((m) => m.user_id !== userId));
    try {
      await authedFetch(token, `/projects/${projectId}/members/${userId}`, {
        method: "DELETE"
      });
    } catch (error) {
      setMembers(previous);
      setStatus(error instanceof Error ? error.message : "Could not remove member");
    }
  }

  function openCreateDiscussionDialog() {
    setTitle("");
    setBodyMarkdown("");
    setCreateDiscussionEditorKey((current) => current + 1);
    createDiscussionDialogRef.current?.showModal();
  }

  async function uploadSelectedFile() {
    if (!token || !projectId || !selectedFile) return;
    setIsUploading(true);
    setUploadError(null);
    let targetPath: string | undefined;
    try {
      // 1. Mint a Dropbox temporary upload link.
      const initRes = await authedFetch(token, `/projects/${projectId}/files/upload-init`, {
        method: "POST",
        body: JSON.stringify({
          filename: selectedFile.name,
          mimeType: selectedFile.type || "application/octet-stream",
          sizeBytes: selectedFile.size
        })
      });
      const { uploadUrl, requestId } = initRes as { uploadUrl: string; targetPath: string; requestId: string };
      targetPath = (initRes as { targetPath: string }).targetPath;

      // 2. POST bytes directly to Dropbox (shared XHR helper handles parsing; no
      //    progress UI on this surface).
      await postBytesToDropbox(uploadUrl, selectedFile);

      // 3. Tell the server to finalize via path-keyed metadata lookup.
      const completeRes = await authedFetch(token, `/projects/${projectId}/files/upload-complete`, {
        method: "POST",
        headers: { "x-original-mime-type": selectedFile.type || "application/octet-stream" },
        body: JSON.stringify({
          targetPath,
          requestId
        })
      });
      const uploadedFile = (completeRes?.file ?? null) as ProjectFile | null;
      if (uploadedFile) {
        seenFileIdsRef.current.add(uploadedFile.id);
      }

      setUploadError(null);
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await load(token, projectId);
    } catch (err) {
      console.error("upload_failed", err);
      // The temporary upload link may have committed bytes before failing. Delete that orphan
      // (best effort) so the original filename is free again on retry.
      if (targetPath) {
        try {
          await authedFetch(token, `/projects/${projectId}/files/upload-abort`, {
            method: "POST",
            body: JSON.stringify({ targetPath })
          });
        } catch {
          // best effort — never mask the original upload error
        }
      }
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }

  async function downloadFile(fileId: string) {
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

  async function openProjectFolder() {
    if (!token || !projectId) return;
    const data = await authedFetch(token, `/projects/${projectId}/folder-link`);
    const folderUrl = typeof data?.url === "string" ? data.url : "";
    if (folderUrl) {
      window.open(folderUrl, "_blank", "noopener,noreferrer");
    }
  }

  function handleFileInputSelection(list: FileList | null) {
    setSelectedFile(list?.[0] ?? null);
  }

  const projectTitle = project?.display_name ?? project?.name ?? "Project";
  const requestor = project?.requestor?.trim() ?? "";
  const projectDescription = project?.description?.trim() ?? "";
  const totalArchivedHours = userHours.reduce((sum, entry) => sum + parseHoursNumber(entry.hours), 0);
  const expenseSubtotalUsd = calculateProjectExpensesTotalUsd(expenseLines);

  return (
    <main className="page">
      <header className="header">
        <div className={`projectHeaderCopy projectStatusTone tone-${normalizeProjectColumn(project)}`}>
          <h1 className="projectHeaderTitle">
            <span>{projectTitle}</span>
            {requestor ? (
              <span className="projectHeaderRequestor">
                <span aria-hidden="true" className="projectHeaderRequestorSeparator">
                  {" "}
                  -
                </span>
                {requestor}
              </span>
            ) : null}
          </h1>
          {project?.deadline ? <p className="headerSubtitle">Deadline: {formatProjectDeadlineLocal(project.deadline) ?? project.deadline}</p> : null}
          {projectDescription ? (
            <div
              className="markdownContent headerSubtitle"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(projectDescription) }}
            />
          ) : null}
          {/* <ProjectTagList tags={project?.tags} className="projectHeaderTags" /> */}
          <div className="projectHoursRow">
            {project?.archived ? (
              <div className="projectArchivedHours">
                <p className="projectArchivedHoursLabel">Team Hours</p>
                {userHours.length > 0 ? (
                  <div className="projectArchivedHoursBody">
                    <ul className="projectArchivedHoursList">
                      {userHours.map((entry) => (
                        <li key={entry.userId} className="projectArchivedHoursRow">
                          <span className="projectArchivedHoursUser">
                            <span className="projectHoursAvatar projectHoursAvatarFallback">{getHoursEntryInitials(entry)}</span>
                            <span className="projectArchivedHoursName">
                              {getHoursEntryLabel(entry)}
                            </span>
                          </span>
                          <div className="projectArchivedHoursEditor">
                            <input
                              type="number"
                              min="0"
                              step="0.25"
                              inputMode="decimal"
                              className="projectArchivedHoursInput"
                              value={archivedHoursInputs[entry.userId] ?? ""}
                              onChange={(event) =>
                                setArchivedHoursInputs((current) => ({
                                  ...current,
                                  [entry.userId]: event.target.value
                                }))
                              }
                              placeholder="0"
                              aria-label={`${getHoursEntryLabel(entry)} hours`}
                            />
                            <OneShotButton
                              type="button"
                              className="secondary projectArchivedHoursSave"
                              disabled={
                                savingArchivedHoursUserId === entry.userId ||
                                (archivedHoursInputs[entry.userId] ?? "") === formatHoursInput(entry.hours)
                              }
                              onClick={() => saveArchivedHours(entry.userId).catch((error) => setStatus(error.message))}
                            >
                              {savingArchivedHoursUserId === entry.userId ? "Saving..." : "Save"}
                            </OneShotButton>
                          </div>
                        </li>
                      ))}
                    </ul>
                    <div className="projectArchivedHoursTotal">
                      <span>Total</span>
                      <strong>{formatHoursValue(totalArchivedHours)}</strong>
                    </div>
                  </div>
                ) : (
                  <p className="projectArchivedHoursEmpty">No hours logged for this archived project.</p>
                )}
              </div>
            ) : (
              <form
                className="projectHoursForm"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveMyHours().catch((error) => setStatus(error.message));
                }}
              >
                <label className="projectHoursField">
                  <span>My Hours</span>
                  <span className="projectHoursFieldInput">
                    <span className="projectHoursAvatar projectHoursAvatarFallback">{getViewerInitials(viewerProfile)}</span>
                    <input
                      type="number"
                      min="0"
                      step="0.25"
                      inputMode="decimal"
                      value={myHoursInput}
                      onChange={(event) => setMyHoursInput(event.target.value)}
                      placeholder="0"
                    />
                  </span>
                </label>
                <OneShotButton
                  type="submit"
                  className="secondary"
                  disabled={isSavingMyHours || myHoursInput === formatHoursInput(project?.my_hours)}
                >
                  {isSavingMyHours ? "Saving..." : "Save"}
                </OneShotButton>
              </form>
            )}
          </div>
        </div>
        <div className="row">
          <Link href="/" className="linkButton">
            All Projects
          </Link>
          {project?.archived ? (
            <OneShotButton
              type="button"
              className="secondary"
              onClick={() => restoreArchivedProject().catch((error) => setStatus(error.message))}
              disabled={isRestoringProject}
            >
              {isRestoringProject ? "Restoring..." : "Restore Project"}
            </OneShotButton>
          ) : null}
          <OneShotButton type="button" className="iconButton" aria-label="Edit project" onClick={openEditProjectDialog}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                fill="currentColor"
                d="M19.14 12.94a7.66 7.66 0 0 0 .05-.94 7.66 7.66 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.3 7.3 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.58.23-1.12.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.48a.5.5 0 0 0 .12.64l2.03 1.58c-.03.31-.05.62-.05.94s.02.63.05.94L2.82 14.16a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.51.4 1.05.71 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.58-.23 1.12-.54 1.63-.94l2.39.96c.22.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"
              />
            </svg>
          </OneShotButton>
        </div>
      </header>

      <section className="stackSection">
        <div className="sectionHeader">
          <h2>Discussions</h2>
          <OneShotButton
            className="iconButton"
            aria-label="Create discussion"
            onClick={openCreateDiscussionDialog}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path fill="currentColor" d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2h6Z" />
            </svg>
          </OneShotButton>
        </div>
        <ul>
          {threads.map((thread) => (
            <li key={thread.id} className="projectRow">
              <span className="discussionAvatarFallback" aria-label={`${getStarterLabel(thread)} initials`}>
                {getStarterInitials(thread)}
              </span>
              <div className="projectMain">
                <Link href={`/${projectId}/${thread.id}`} className="projectLink projectLinkRow">
                  <span>{thread.title}</span>
                  {newThreadIds.has(thread.id) ? <span className="newItemPill">New</span> : null}
                </Link>
                <small>{new Date(thread.created_at).toLocaleString()}</small>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {uploadError && (
        <p role="alert" className="uploadErrorBanner">
          <span>{uploadError}</span>
          <button
            type="button"
            onClick={() => setUploadError(null)}
            className="uploadErrorBannerDismiss"
            aria-label="Dismiss upload error"
          >
            ×
          </button>
        </p>
      )}
      <ProjectFilesPanel
        projectId={projectId}
        token={token}
        onToken={setToken}
        files={files}
        selectedFile={selectedFile}
        isUploading={isUploading}
        isFileDragActive={isFileDragActive}
        fileInputRef={fileInputRef}
        onFileInputSelection={handleFileInputSelection}
        onSetFileDragActive={setIsFileDragActive}
        onOpenProjectFolder={() => openProjectFolder().catch((error) => setStatus(error.message))}
        onUploadSelectedFile={() => uploadSelectedFile().catch((error) => setStatus(error.message))}
        onClearSelectedFile={() => {
          setSelectedFile(null);
          if (fileInputRef.current) {
            fileInputRef.current.value = "";
          }
          setUploadError(null);
        }}
        onDownloadFile={(fileId) => downloadFile(fileId).catch((error) => setStatus(error.message))}
        getFileBadgeLabel={getFileBadgeLabel}
        newFileIds={newFileIds}
      />

      <section className="stackSection">
        <div className="sectionHeader">
          <h2>Financial Rollup</h2>
        </div>

        <div className="projectFinancialGrid">
          <section className="projectFinancialCard">
            <div className="projectFinancialCardHeader">
              <h3>Hours</h3>
              <span>{formatHoursValue(totalArchivedHours)}</span>
            </div>
            {userHours.length > 0 ? (
              <div className="projectFinancialTable" role="table" aria-label="Hours rollup">
                {userHours.map((entry) => (
                  <div key={entry.userId} className="projectFinancialRow projectFinancialRowHoursOnly" role="row">
                    <div className="projectFinancialPerson" role="cell">
                      <span className="projectHoursAvatar projectHoursAvatarFallback">{getHoursEntryInitials(entry)}</span>
                      <span>{getHoursEntryLabel(entry)}</span>
                    </div>
                    <span role="cell">{formatHoursValue(entry.hours)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="projectFinancialEmpty">No hours logged yet.</p>
            )}
          </section>

          <section className="projectFinancialCard">
            <div className="projectFinancialCardHeader">
              <h3>Expense Lines</h3>
              <span>{expenseLines.length} items</span>
            </div>
            <div className="projectExpenseComposer">
              <input
                value={newExpenseLine.label}
                onChange={(event) => setNewExpenseLine((current) => ({ ...current, label: event.target.value }))}
                placeholder="Expense label"
                aria-label="New expense label"
              />
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={newExpenseLine.amount}
                onChange={(event) => setNewExpenseLine((current) => ({ ...current, amount: event.target.value }))}
                placeholder="0.00"
                aria-label="New expense amount"
              />
              <OneShotButton
                type="button"
                className="secondary"
                disabled={isCreatingExpenseLine}
                onClick={() => createExpenseLine().catch((error) => setStatus(error.message))}
              >
                {isCreatingExpenseLine ? "Adding..." : "Add expense"}
              </OneShotButton>
            </div>
            {expenseLines.length > 0 ? (
              <div className="projectExpenseList">
                {expenseLines.map((line) => {
                  const draft = expenseLineDrafts[line.id] ?? {
                    label: line.label,
                    amount: formatUsdInput(line.amount)
                  };
                  const isDirty = draft.label !== line.label || draft.amount !== formatUsdInput(line.amount);

                  return (
                    <div key={line.id} className="projectExpenseRow">
                      <div className="projectExpenseLabelCell">
                        <input
                          value={draft.label}
                          onChange={(event) =>
                            setExpenseLineDrafts((current) => ({
                              ...current,
                              [line.id]: {
                                ...draft,
                                label: event.target.value
                              }
                            }))
                          }
                          aria-label={`${line.label} label`}
                        />
                        {newExpenseLineIds.has(line.id) ? <span className="newItemPill">New</span> : null}
                      </div>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={draft.amount}
                        onChange={(event) =>
                          setExpenseLineDrafts((current) => ({
                            ...current,
                            [line.id]: {
                              ...draft,
                              amount: event.target.value
                            }
                          }))
                        }
                        aria-label={`${line.label} amount`}
                      />
                      <OneShotButton
                        type="button"
                        className="secondary"
                        disabled={savingExpenseLineId === line.id || !isDirty}
                        onClick={() => saveExpenseLine(line.id).catch((error) => setStatus(error.message))}
                      >
                        {savingExpenseLineId === line.id ? "Saving..." : "Save"}
                      </OneShotButton>
                      <OneShotButton
                        type="button"
                        className="secondary"
                        disabled={deletingExpenseLineId === line.id}
                        onClick={() => deleteExpenseLine(line.id).catch((error) => setStatus(error.message))}
                      >
                        {deletingExpenseLineId === line.id ? "Deleting..." : "Delete"}
                      </OneShotButton>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="projectFinancialEmpty">No expense lines yet.</p>
            )}
            <div className="projectFinancialSummary">
              <span>Expense subtotal</span>
              <strong>{formatUsdMoney(expenseSubtotalUsd)}</strong>
            </div>
          </section>
        </div>

        <div className="projectFinancialGrandTotal">
          <span>Total (expenses)</span>
          <strong>{formatUsdMoney(expenseSubtotalUsd)}</strong>
        </div>
      </section>

      <CreateDiscussionDialog
        dialogRef={createDiscussionDialogRef}
        title={title}
        bodyMarkdown={bodyMarkdown}
        onTitleChange={setTitle}
        onCreate={() => createDiscussion().catch((error) => setStatus(error.message))}
        onCancel={() => {
          setTitle("");
          setBodyMarkdown("");
          setDiscussionAttachments([]);
          setCreateDiscussionEditorKey((current) => current + 1);
          createDiscussionDialogRef.current?.close();
        }}
        canSubmit={Boolean(title.trim()) && Boolean(bodyMarkdown.trim()) && !isUploadingDiscussionAttachments}
        submitLabel={isUploadingDiscussionAttachments ? "Uploading..." : "Create"}
        editor={(
          <MarkdownEditor
            key={`create-discussion-${createDiscussionEditorKey}`}
            markdown={bodyMarkdown}
            onChange={setBodyMarkdown}
            placeholder="Write the discussion body in markdown"
            overlayContainer={createDiscussionDialogRef.current}
          />
        )}
        attachmentsSlot={(
          <div className="commentUploadArea">
            <label className="commentFileLabel">Attach files (optional)</label>
            <input
              ref={discussionFileInputRef}
              type="file"
              multiple
              className="commentFileInputHidden"
              onChange={(event) => addDiscussionPendingFiles(event.target.files ?? [])}
            />
            <div
              className="commentDropZone"
              onClick={() => discussionFileInputRef.current?.click()}
              onDragEnter={(e) => e.preventDefault()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                addDiscussionPendingFiles(e.dataTransfer.files);
              }}
            >
              <p className="commentDropZoneTitle">Drag files here</p>
              <p className="commentDropZoneSubtle">or click to browse from your device</p>
            </div>
            {discussionAttachments.length > 0 && (
              <ul className="commentUploadQueue">
                {discussionAttachments.map((a) => (
                  <li key={a.id} className="commentUploadQueueItem">
                    <div className="commentUploadQueueHead">
                      <span>{a.file.name}</span>
                      <small>
                        {Math.round(a.file.size / 1024)} KB &bull; {a.stage === "uploading" ? `${a.progress}%` : a.stage}
                      </small>
                    </div>
                    {a.error && <small className="commentUploadError">{a.error}</small>}
                    {!isUploadingDiscussionAttachments && (
                      <OneShotButton
                        type="button"
                        className="secondary"
                        onClick={(event) => {
                          event.stopPropagation();
                          removeDiscussionAttachment(a.id);
                        }}
                      >
                        Remove
                      </OneShotButton>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      />

      <dialog ref={editProjectDialogRef} className="dialog">
        <ProjectDialogForm
          title="Edit Project"
          submitLabel="Save Changes"
          values={projectForm}
          clients={clients}
          submitting={isSavingProject}
          clientDisabled
          showPmNote
          onChange={setProjectForm}
          onSubmit={() => saveProject().catch((error) => setStatus(error.message))}
          onCancel={() => editProjectDialogRef.current?.close()}
          members={members}
          activeUsers={activeUsers}
          onAddMember={handleAddMember}
          onRemoveMember={handleRemoveMember}
        />
      </dialog>
    </main >
  );
}

function getFileBadgeLabel(file: ProjectFile) {
  const mime = file.mime_type.toLowerCase();
  if (mime.includes("pdf")) return "PDF";
  if (mime.includes("spreadsheet") || mime.includes("excel") || mime.includes("csv")) return "SHEET";
  if (mime.includes("word") || mime.includes("document")) return "DOC";
  if (mime.includes("zip") || mime.includes("compressed")) return "ZIP";
  const extension = file.filename.split(".").pop()?.trim().toUpperCase();
  return extension && extension.length <= 5 ? extension : "FILE";
}

function getProjectActivityUpdatedDate(project: Project | null) {
  if (!project) return null;
  const candidates = [project.updated_at, project.last_activity_at].filter(Boolean) as string[];
  return candidates.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;
}

function getThreadActivityUpdatedAt(thread: Thread) {
  return thread.activity_updated_at ?? thread.updated_at ?? thread.created_at;
}

function createThreadActivityMap(threads: Thread[]) {
  const activityMap = new Map<string, string>();
  threads.forEach((thread) => updateSeenThreadActivity(thread, activityMap));
  return activityMap;
}

function updateSeenThreadActivity(thread: Thread, activityMap: Map<string, string>) {
  const activityUpdatedAt = getThreadActivityUpdatedAt(thread);
  if (activityUpdatedAt) {
    activityMap.set(thread.id, activityUpdatedAt);
  }
}

function formatHoursInput(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  const numericValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numericValue) ? String(numericValue) : "";
}

function parseHoursNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }

  const numericValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function formatHoursValue(value: number | string | null | undefined) {
  const numericValue = parseHoursNumber(value);
  return `${numericValue.toFixed(numericValue % 1 === 0 ? 0 : 2)}h`;
}

function getViewerInitials(profile: ViewerProfile | null) {
  const firstName = (profile?.first_name ?? "").trim();
  const lastName = (profile?.last_name ?? "").trim();
  if (firstName || lastName) {
    return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase() || "U";
  }

  const emailLocalPart = (profile?.email ?? "user").split("@")[0];
  return emailLocalPart.slice(0, 2).toUpperCase() || "U";
}

function getHoursEntryLabel(entry: ProjectUserHoursEntry) {
  const fullName = `${entry.firstName ?? ""} ${entry.lastName ?? ""}`.trim();
  return fullName || entry.email;
}

function getHoursEntryInitials(entry: ProjectUserHoursEntry) {
  const firstName = (entry.firstName ?? "").trim();
  const lastName = (entry.lastName ?? "").trim();
  if (firstName || lastName) {
    return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase() || "U";
  }

  return entry.email.split("@")[0].slice(0, 2).toUpperCase() || "U";
}

async function loadProjectData(accessToken: string, projectId: string) {
  const [projectRes, threadsRes, filesRes, clientsRes, profileRes, expenseLinesRes] = await Promise.all([
    authedJsonFetch({ accessToken, path: `/projects/${projectId}` }),
    authedJsonFetch({ accessToken, path: `/projects/${projectId}/threads` }),
    authedJsonFetch({ accessToken, path: `/projects/${projectId}/files` }),
    authedJsonFetch({ accessToken, path: "/api/clients" }),
    authedJsonFetch({ accessToken, path: "/profile" }),
    authedJsonFetch({ accessToken, path: `/projects/${projectId}/expense-lines` })
  ]);

  return {
    accessToken: projectRes.accessToken,
    project: (projectRes.data?.project ?? null) as Project | null,
    userHours: (projectRes.data?.userHours ?? []) as ProjectUserHoursEntry[],
    expenseLines: (expenseLinesRes.data?.expenseLines ?? []) as ProjectExpenseLine[],
    threads: (threadsRes.data?.threads ?? []) as Thread[],
    files: (filesRes.data?.files ?? []) as ProjectFile[],
    clients: (clientsRes.data?.clients ?? []) as ClientRecord[],
    viewerProfile: (profileRes.data?.profile ?? null) as ViewerProfile | null
  };
}

async function loadProjectBootstrap(projectId: string): Promise<ProjectPageBootstrap> {
  if (!projectId) {
    return {
      token: null,
      status: "Loading project…",
      project: null,
      userHours: [],
      expenseLines: [],
      clients: [],
      viewerProfile: null,
      threads: [],
      files: []
    };
  }

  try {
    const session = await fetchAuthSession();
    const accessToken = session.accessToken;

    if (!accessToken) {
      return {
        token: null,
        status: session.status || "Sign in first",
        project: null,
        userHours: [],
        expenseLines: [],
        clients: [],
        viewerProfile: null,
        threads: [],
        files: []
      };
    }

    const nextState = await loadProjectData(accessToken, projectId);
    return {
      token: nextState.accessToken,
      status: session.status,
      ...nextState
    };
  } catch (error) {
    return {
      token: null,
      status: error instanceof Error ? error.message : "Load failed",
      project: null,
      userHours: [],
      expenseLines: [],
      clients: [],
      viewerProfile: null,
      threads: [],
      files: []
    };
  }
}
