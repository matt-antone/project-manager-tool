import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ProjectDialogValues } from "@/components/project-dialog-form";
import { ProjectsWorkspaceShell } from "@/components/projects/projects-workspace-shell";

const emptyProjectForm: ProjectDialogValues = {
  name: "",
  description: "",
  deadline: "",
  requestor: "",
  tags: "",
  clientId: "",
  pm_note: ""
};

const baseWorkspace = {
  status: "Signed in as test@example.com",
  domainAllowed: true,
  latestFeaturedPosts: [] as {
    url: string;
    sourceName: string;
    title: string;
    description: string;
    publishedAt: string | null;
  }[],
  createDialogRef: { current: null },
  projectForm: emptyProjectForm,
  setProjectForm: vi.fn(),
  clients: [],
  isCreatingProject: false,
  createProject: vi.fn(),
  setStatus: vi.fn(),
  userId: null,
  activeUsers: [],
  selectedMemberIds: [],
  addMember: vi.fn(),
  removeMember: vi.fn()
};

vi.mock("@/components/projects/projects-workspace-context", () => ({
  useProjectsWorkspace: vi.fn()
}));

vi.mock("@/components/project-dialog-form", () => ({
  ProjectDialogForm: () => null
}));

import { useProjectsWorkspace } from "@/components/projects/projects-workspace-context";

describe("ProjectsWorkspaceShell hero feed loading", () => {
  beforeEach(() => {
    vi.mocked(useProjectsWorkspace).mockReturnValue({
      ...baseWorkspace,
      featuredFeedStatus: "loading"
    } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not render default hero title while feed is loading", () => {
    const markup = renderToStaticMarkup(<ProjectsWorkspaceShell viewport={<div />} />);
    expect(markup).not.toContain("A calmer way to see what the studio is carrying.");
    expect(markup).toContain("projectsHeroFeedLoading");
    expect(markup).toContain("loadingStateSpinner");
  });

  it("renders default hero title when feed is ready and empty", () => {
    vi.mocked(useProjectsWorkspace).mockReturnValue({
      ...baseWorkspace,
      featuredFeedStatus: "ready",
      latestFeaturedPosts: []
    } as never);

    const markup = renderToStaticMarkup(<ProjectsWorkspaceShell viewport={<div />} />);
    expect(markup).toContain("A calmer way to see what the studio is carrying.");
    expect(markup).not.toContain("projectsHeroFeedLoading");
  });
});
