"use client";

import { useRouter } from "next/navigation";
import type { ProjectDialogActiveUser, ProjectDialogValues } from "@/components/project-dialog-form";
import { PageLoadingState } from "@/components/loading-shells";
import { createClientResource } from "@/lib/client-resource";
import {
  createProjectDialogValues,
  normalizeProjectColumn,
  parseProjectTags,
  type ProjectColumn
} from "@/lib/project-utils";
import { authedJsonFetch, fetchAuthSession } from "@/lib/browser-auth";
import useSWR from "swr";
import { primeProjectSwrToken, projectSwrFetcher, revalidateProjectEverywhere } from "@/lib/project-swr";
import type { FeaturedFeedPost } from "@/lib/featured-feed";
import type { ClientRecord } from "@/lib/types/client-record";
import {
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

export type Project = {
  id: string;
  name: string;
  display_name?: string | null;
  description: string | null;
  /** ISO date `YYYY-MM-DD` or timestamp from API. */
  deadline?: string | null;
  tags?: string[] | null;
  archived: boolean;
  status?: string | null;
  client_id: string | null;
  client_name?: string | null;
  client_code?: string | null;
  discussion_count?: number;
  file_count?: number;
  /** ISO timestamp from API (`projects.created_at`). */
  created_at?: string | null;
  /** PM-facing note; max 256 chars; list/board show one line when set. */
  pm_note?: string | null;
  /** Whether the CURRENT user favorited this project (per-user, server-computed). */
  favorited?: boolean;
};

export type { ProjectColumn };

/** UI sort only; API still accepts `sort=deadline` for compatibility. */
export type ProjectSort = "created" | "title";

type RefreshProjectsOptions = {
  accessToken?: string | null;
  clientId?: string | null;
  search?: string;
  sort?: ProjectSort;
  signal?: AbortSignal;
};

const PROJECT_COLUMNS: { key: ProjectColumn; title: string; subtitle: string }[] = [
  { key: "new", title: "New", subtitle: "Ready to shape" },
  { key: "in_progress", title: "In Progress", subtitle: "Actively moving" },
  { key: "blocked", title: "Blocked", subtitle: "Needs a decision" },
  { key: "complete", title: "Complete", subtitle: "Ready to file away" }
];

type ProjectsBootstrap = {
  accessToken: string | null;
  status: string;
  domainAllowed: boolean;
  userId: string | null;
  clients: ClientRecord[];
  projects: Project[];
  latestFeaturedPosts: FeaturedFeedPost[];
};

type ProjectsWorkspaceContextValue = {
  accessToken: string | null;
  setAccessToken: (t: string | null) => void;
  status: string;
  setStatus: (s: string) => void;
  domainAllowed: boolean;
  userId: string | null;
  activeUsers: ProjectDialogActiveUser[];
  selectedMemberIds: string[];
  addMember: (userId: string) => void;
  removeMember: (userId: string) => void;
  clients: ClientRecord[];
  projects: Project[];
  setProjects: Dispatch<SetStateAction<Project[]>>;
  latestFeaturedPosts: FeaturedFeedPost[];
  featuredFeedStatus: "loading" | "ready";
  projectColumns: typeof PROJECT_COLUMNS;
  activeProjects: Project[];
  filterClientId: string | null;
  setFilterClientId: Dispatch<SetStateAction<string | null>>;
  activeSearch: string;
  setActiveSearch: Dispatch<SetStateAction<string>>;
  projectSort: ProjectSort;
  setProjectSort: Dispatch<SetStateAction<ProjectSort>>;
  authedFetch: (path: string, options?: RequestInit) => Promise<unknown>;
  refreshProjects: (overrides?: RefreshProjectsOptions) => Promise<void>;
  createProject: () => Promise<void>;
  openCreateDialog: () => void;
  createDialogRef: RefObject<HTMLDialogElement | null>;
  projectForm: ProjectDialogValues;
  setProjectForm: Dispatch<SetStateAction<ProjectDialogValues>>;
  isCreatingProject: boolean;
  toggleArchive: (project: Project) => Promise<void>;
  moveProject: (projectId: string, targetColumn: ProjectColumn) => Promise<void>;
  toggleFavorite: (projectId: string, next: boolean) => Promise<void>;
  favoritingIds: Set<string>;
  getProjectClientLabel: (project: Project) => string;
  renderProjectTitle: (title: string) => ReactNode;
  getProjectStatusLabel: (project: Project) => string;
};

const ProjectsWorkspaceContext = createContext<ProjectsWorkspaceContextValue | null>(null);

/** Workspace list/board: always `includeArchived=false` — policy docs/superpowers/specs/2026-04-06-projects-workspace-include-archived-policy.md */
function buildProjectsUrl(options?: { clientId?: string | null; search?: string; sort?: ProjectSort }) {
  const params = new URLSearchParams({ includeArchived: "false" });
  const clientId = options?.clientId ?? null;
  const search = options?.search?.trim() ?? "";
  const sort = options?.sort ?? "title";

  if (clientId) {
    params.set("clientId", clientId);
  }
  if (search) {
    params.set("search", search);
  }
  // API: omit `sort` for newest-first (`created_at`); `sort=title` for A–Z.
  if (sort === "title") {
    params.set("sort", "title");
  }

  return `/projects?${params.toString()}`;
}

export function useProjectsWorkspace() {
  const ctx = useContext(ProjectsWorkspaceContext);
  if (!ctx) {
    throw new Error("useProjectsWorkspace must be used within ProjectsWorkspaceProvider");
  }
  return ctx;
}

const projectsBootstrapResource = createClientResource(loadProjectsBootstrap, () => "projects-home");

export function ProjectsWorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [initial, setInitial] = useState<ProjectsBootstrap | null>(null);

  useEffect(() => {
    let cancelled = false;
    projectsBootstrapResource.read("projects-home").then((nextState) => {
      if (!cancelled) {
        setInitial(nextState);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!initial) {
    return (
      <PageLoadingState
        label="Loading workspace"
        message="Gathering projects, clients, and the latest studio signals."
      />
    );
  }

  return <ProjectsWorkspaceInner initial={initial}>{children}</ProjectsWorkspaceInner>;
}

function ProjectsWorkspaceInner({ initial, children }: { initial: ProjectsBootstrap; children: React.ReactNode }) {
  const router = useRouter();
  const [accessToken, setAccessToken] = useState<string | null>(initial.accessToken);
  const [status, setStatus] = useState(initial.status);
  const domainAllowed = initial.domainAllowed;
  const clients = initial.clients;
  const createProjectClients = clients.filter((client) => !client.archived_at);
  const [latestFeaturedPosts, setLatestFeaturedPosts] = useState<FeaturedFeedPost[]>(initial.latestFeaturedPosts);
  const [featuredFeedStatus, setFeaturedFeedStatus] = useState<"loading" | "ready">("loading");
  const [filterClientId, setFilterClientId] = useState<string | null>(null);
  const [activeSearch, setActiveSearch] = useState("");
  const [projectSort, setProjectSort] = useState<ProjectSort>("title");
  const [favoritingIds, setFavoritingIds] = useState<Set<string>>(() => new Set());

  // Shared, revalidatable projects list. The key encodes the active filters, so
  // changing client/search/sort fetches the right slice automatically, and any
  // status mutation (here or on the detail route) can invalidate it by key —
  // this is what keeps the board and the project detail page in sync.
  const listKey = buildProjectsUrl({ clientId: filterClientId, search: activeSearch, sort: projectSort });
  const { data: listData, mutate: mutateProjectsList } = useSWR(listKey, projectSwrFetcher, {
    fallbackData: { projects: initial.projects } as Record<string, unknown>,
    keepPreviousData: true
  });
  const projects = useMemo(() => (listData?.projects ?? []) as Project[], [listData]);

  // Preserve the historical `setProjects` API used for optimistic local edits by
  // writing through the SWR cache without triggering a revalidation.
  const setProjects = useCallback<Dispatch<SetStateAction<Project[]>>>(
    (action) => {
      void mutateProjectsList(
        (current) => {
          const prev = ((current as { projects?: Project[] } | undefined)?.projects ?? []) as Project[];
          const next =
            typeof action === "function" ? (action as (p: Project[]) => Project[])(prev) : action;
          return { ...((current as Record<string, unknown>) ?? {}), projects: next };
        },
        { revalidate: false }
      );
    },
    [mutateProjectsList]
  );

  const userId = initial.userId;
  const [projectForm, setProjectForm] = useState<ProjectDialogValues>(createProjectDialogValues());
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [activeUsers, setActiveUsers] = useState<ProjectDialogActiveUser[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const activeUsersLoadedRef = useRef(false);
  const createDialogRef = useRef<HTMLDialogElement | null>(null);

  const addMember = useCallback((id: string) => {
    setSelectedMemberIds((current) => (current.includes(id) ? current : [...current, id]));
  }, []);
  const removeMember = useCallback((id: string) => {
    setSelectedMemberIds((current) => current.filter((x) => x !== id));
  }, []);
  const activeProjects = useMemo(() => projects.filter((project) => !project.archived), [projects]);

  // Keep the shared SWR fetcher seeded with the freshest token this route holds,
  // so list/detail reads across the app don't re-hit /auth/session needlessly.
  useEffect(() => {
    primeProjectSwrToken(accessToken);
  }, [accessToken]);

  const authedFetch = useCallback(async (path: string, options: RequestInit = {}) => {
    const { accessToken: nextToken, data } = await authedJsonFetch({
      accessToken,
      init: options,
      onToken: setAccessToken,
      path
    });
    if (nextToken !== accessToken) {
      setAccessToken(nextToken);
    }
    return data;
  }, [accessToken]);

  useEffect(() => {
    let cancelled = false;
    // `no-store`: never serve the browser's cached copy — `force-cache` here was
    // freezing the feed on the first-ever response in Firefox. Freshness/efficiency
    // are governed by the route's Cache-Control (CDN s-maxage) instead.
    fetch("/feeds/latest", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((feedData: { posts?: FeaturedFeedPost[] } | null) => {
        if (cancelled || !feedData) return;
        const posts = feedData.posts?.slice(0, 2) ?? [];
        startTransition(() => {
          setLatestFeaturedPosts(posts);
        });
      })
      .catch(() => {
        /* Hero keeps default copy if the feed cannot be reached. */
      })
      .finally(() => {
        if (cancelled) return;
        startTransition(() => {
          setFeaturedFeedStatus("ready");
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The active filters already live in the SWR key, so a refresh is just a
  // revalidation of the current list. Overrides are accepted for backward
  // compatibility with existing callers but are no longer needed — changing a
  // filter updates the key and refetches automatically.
  const refreshProjects = useCallback(async () => {
    await mutateProjectsList();
  }, [mutateProjectsList]);

  const createProject = useCallback(async () => {
    setIsCreatingProject(true);
    try {
      // Filter out the creator's id — server adds creator regardless.
      const memberIds = selectedMemberIds.filter((id) => id !== userId);
      const data = (await authedFetch("/projects", {
        method: "POST",
        body: JSON.stringify({
          name: projectForm.name,
          description: projectForm.description,
          deadline: projectForm.deadline || null,
          clientId: projectForm.clientId,
          tags: parseProjectTags(projectForm.tags),
          requestor: projectForm.requestor.trim() || null,
          ...(memberIds.length > 0 ? { memberIds } : {})
        })
      })) as {
        project?: { id?: string };
        warnings?: { skippedInactiveUserIds?: string[] };
      };
      const projectId = data?.project?.id;
      if (!projectId) {
        throw new Error("Project created without an id");
      }
      if (data?.warnings?.skippedInactiveUserIds?.length) {
        const skippedNames = data.warnings.skippedInactiveUserIds
          .map((id) => {
            const u = activeUsers.find((x) => x.id === id);
            if (!u) return id;
            return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email;
          })
          .join(", ");
        setStatus(`Skipped ${data.warnings.skippedInactiveUserIds.length} user(s) no longer active: ${skippedNames}`);
      }
      setProjectForm(createProjectDialogValues(createProjectClients[0]?.id ?? ""));
      setSelectedMemberIds([]);
      createDialogRef.current?.close();
      router.push(`/${projectId}`);
    } finally {
      setIsCreatingProject(false);
    }
  }, [activeUsers, authedFetch, createProjectClients, projectForm, router, selectedMemberIds, userId]);

  const openCreateDialog = useCallback(() => {
    setProjectForm(createProjectDialogValues(createProjectClients[0]?.id ?? ""));
    setSelectedMemberIds([]);
    if (!activeUsersLoadedRef.current) {
      activeUsersLoadedRef.current = true;
      authedFetch("/users/active")
        .then((data) => {
          const users = (data as { users?: ProjectDialogActiveUser[] } | null)?.users ?? [];
          setActiveUsers(users);
        })
        .catch(() => {
          activeUsersLoadedRef.current = false;
        });
    }
    createDialogRef.current?.showModal();
  }, [authedFetch, createProjectClients]);

  const toggleArchive = useCallback(
    async (project: Project) => {
      await authedFetch(`/projects/${project.id}/${project.archived ? "restore" : "archive"}`, { method: "POST" });
      // Archiving changes which projects are active; refresh the list and the
      // project's detail cache everywhere.
      await revalidateProjectEverywhere(project.id);
    },
    [authedFetch]
  );

  function runWithTransition(update: () => void) {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduceMotion && "startViewTransition" in document) {
      (document as Document & { startViewTransition?: (callback: () => void) => void }).startViewTransition?.(update);
      return;
    }
    update();
  }

  const moveProject = useCallback(
    async (projectId: string, targetColumn: ProjectColumn) => {
      const source = projects.find((project) => project.id === projectId);
      if (!source) return;
      const currentColumn = normalizeProjectColumn(source);
      if (currentColumn === targetColumn) return;

      const previousProjects = projects;
      runWithTransition(() => {
        setProjects((current) =>
          current.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  status: targetColumn
                }
              : project
          )
        );
      });

      try {
        await authedFetch(`/projects/${projectId}/status`, {
          method: "POST",
          body: JSON.stringify({ status: targetColumn })
        });
        // Refresh both this list and the project's detail cache so the change is
        // reflected wherever the project is shown, not just on the board.
        await revalidateProjectEverywhere(projectId);
      } catch (error) {
        setProjects(previousProjects);
        throw error;
      }
    },
    [authedFetch, projects, setProjects]
  );

  const toggleFavorite = useCallback(
    async (projectId: string, next: boolean) => {
      // Optimistic, mirrors moveProject. No refreshProjects: favoriting does not
      // change which projects are active, so a refetch would only cause churn.
      const previousProjects = projects;
      setFavoritingIds((current) => {
        const updated = new Set(current);
        updated.add(projectId);
        return updated;
      });
      setProjects((current) =>
        current.map((project) => (project.id === projectId ? { ...project, favorited: next } : project))
      );

      try {
        await authedFetch(`/projects/${projectId}/favorite`, { method: next ? "POST" : "DELETE" });
      } catch (error) {
        setProjects(previousProjects);
        throw error;
      } finally {
        setFavoritingIds((current) => {
          const updated = new Set(current);
          updated.delete(projectId);
          return updated;
        });
      }
    },
    [authedFetch, projects, setProjects]
  );

  const getProjectClientLabel = useCallback((project: Project) => {
    return project.client_name?.trim() || project.client_code?.trim() || "No client";
  }, []);

  const renderProjectTitle = useCallback((title: string) => {
    const codeRegex = /\b[A-Z]{2,}-\d{4}\b/g;
    const parts: ReactNode[] = [];
    let lastIndex = 0;

    for (const match of title.matchAll(codeRegex)) {
      const start = match.index ?? 0;
      const code = match[0];
      if (start > lastIndex) {
        parts.push(title.slice(lastIndex, start));
      }
      parts.push(
        <strong className="projectCodeStrong" key={`${code}-${start}`}>
          {code}
        </strong>
      );
      lastIndex = start + code.length;
    }

    if (lastIndex < title.length) {
      parts.push(title.slice(lastIndex));
    }

    return parts.length ? parts : title;
  }, []);

  const getProjectStatusLabel = useCallback((project: Project) => {
    return PROJECT_COLUMNS.find((column) => column.key === normalizeProjectColumn(project))?.title ?? "New";
  }, []);

  const value: ProjectsWorkspaceContextValue = {
    accessToken,
    setAccessToken,
    status,
    setStatus,
    domainAllowed,
    userId,
    activeUsers,
    selectedMemberIds,
    addMember,
    removeMember,
    clients,
    projects,
    setProjects,
    latestFeaturedPosts,
    featuredFeedStatus,
    projectColumns: PROJECT_COLUMNS,
    activeProjects,
    filterClientId,
    setFilterClientId,
    activeSearch,
    setActiveSearch,
    projectSort,
    setProjectSort,
    authedFetch,
    refreshProjects,
    createProject,
    openCreateDialog,
    createDialogRef,
    projectForm,
    setProjectForm,
    isCreatingProject,
    toggleArchive,
    moveProject,
    toggleFavorite,
    favoritingIds,
    getProjectClientLabel,
    renderProjectTitle,
    getProjectStatusLabel
  };

  return <ProjectsWorkspaceContext.Provider value={value}>{children}</ProjectsWorkspaceContext.Provider>;
}

function getProjectsPageAuthErrorStatus() {
  const params = new URLSearchParams(window.location.search);
  const authError = params.get("authError");
  if (authError === "workspace-domain") {
    return "Only workspace accounts can sign in.";
  }
  if (authError === "oauth-session-exchange") {
    return "Google sign-in completed, but the session exchange failed. Try again.";
  }
  if (authError === "oauth-session-missing") {
    return "Google sign-in completed without a session. Try again.";
  }
  if (authError === "oauth-missing-email") {
    return "Google did not return an email address for this account.";
  }
  if (authError === "oauth-callback-failed") {
    return "Google sign-in did not complete successfully.";
  }
  return null;
}

async function loadProjectsBootstrap(): Promise<ProjectsBootstrap> {
  /** Feed loads in `ProjectsWorkspaceInner` so session/clients/projects are not blocked on `/feeds/latest`. */
  const latestFeaturedPosts: FeaturedFeedPost[] = [];

  try {
    const session = await fetchAuthSession();
    const accessToken = session.accessToken;
    const email = session.user?.email ?? null;

    if (!accessToken || !email) {
      return {
        accessToken: null,
        status: getProjectsPageAuthErrorStatus() ?? session.status,
        domainAllowed: session.domainAllowed,
        userId: null,
        clients: [],
        projects: [],
        latestFeaturedPosts
      };
    }

    const [clientsResponse, projectsResponse] = await Promise.all([
      authedJsonFetch({ accessToken, path: "/api/clients" }),
      authedJsonFetch({ accessToken, path: buildProjectsUrl() })
    ]);

    return {
      accessToken: clientsResponse.accessToken,
      status: session.status,
      domainAllowed: session.domainAllowed,
      userId: session.user?.id ?? null,
      clients: (clientsResponse.data?.clients ?? []) as ClientRecord[],
      projects: (projectsResponse.data?.projects ?? []) as Project[],
      latestFeaturedPosts
    };
  } catch (error) {
    return {
      accessToken: null,
      status: error instanceof Error ? error.message : "Unable to load workspace",
      domainAllowed: false,
      userId: null,
      clients: [],
      projects: [],
      latestFeaturedPosts
    };
  }
}
