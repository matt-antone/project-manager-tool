"use client";

import { ProjectDialogForm } from "@/components/project-dialog-form";
import { useProjectsWorkspace } from "@/components/projects/projects-workspace-context";
import React, { type ReactNode } from "react";

const HERO_FALLBACK_KICKER = "Projects index";
const HERO_FALLBACK_TITLE = "A calmer way to see what the studio is carrying.";
const HERO_FALLBACK_INTRO =
  "The page should read like an active portfolio wall, not a template dashboard. Track what is moving, what is blocked, and which client lanes need attention next.";

function formatFeedDate(value: string | null) {
  if (!value) {
    return "No date";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "No date";
  }

  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
}

export function ProjectsWorkspaceShell({
  workbench,
  viewport,
  showHero = true
}: {
  workbench?: ReactNode;
  viewport: ReactNode;
  /** When false, hides the hero and feed rail (Billing / Archive). Default preserves main projects home. */
  showHero?: boolean;
}) {
  const {
    status,
    domainAllowed,
    latestFeaturedPosts,
    createDialogRef,
    projectForm,
    setProjectForm,
    clients,
    isCreatingProject,
    createProject,
    setStatus,
    featuredFeedStatus,
    userId,
    activeUsers,
    selectedMemberIds,
    addMember,
    removeMember
  } = useProjectsWorkspace();

  const dialogMembers = selectedMemberIds.flatMap((id) => {
    const u = activeUsers.find((x) => x.id === id);
    return u ? [{ user_id: u.id, email: u.email, first_name: u.first_name, last_name: u.last_name }] : [];
  });

  const featuredHeroPost = latestFeaturedPosts[0] ?? null;
  const feedRailPosts = latestFeaturedPosts.length > 1 ? latestFeaturedPosts.slice(1) : latestFeaturedPosts;
  const creatableClients = clients.filter((client) => !client.archived_at);
  const heroKicker = featuredHeroPost ? `Latest from ${featuredHeroPost.sourceName}` : HERO_FALLBACK_KICKER;
  const heroTitle = featuredHeroPost?.title ?? HERO_FALLBACK_TITLE;
  const heroIntro = featuredHeroPost?.description ?? HERO_FALLBACK_INTRO;

  const showHeroFeedLoading = showHero && featuredFeedStatus === "loading";

  return (
    <main className={`page projectsExperience${showHero ? "" : " projectsExperienceNoHero"}`}>
      {showHero ? (
        showHeroFeedLoading ? (
          <section className="projectsHero projectsHeroFeedLoading">
            <div className="projectsHeroCopy">
              <p className={`projectsSessionNote ${domainAllowed && status.startsWith("Signed in as") ? "projectsSessionNoteQuiet" : ""}`}>
                {status}
              </p>
              <div className="projectsHeroLoadingPanel" role="status" aria-live="polite" aria-label="Loading latest posts">
                <span className="loadingStateSpinner" aria-hidden="true" />
              </div>
            </div>
            <aside className="projectsFeedRail" aria-label="Latest feed posts">
              <div className="projectsFeedRailLoading">
                <span className="loadingStateSpinner" aria-hidden="true" />
              </div>
            </aside>
          </section>
        ) : (
          <section className="projectsHero">
            <div className="projectsHeroCopy">
              <p className={`projectsSessionNote ${domainAllowed && status.startsWith("Signed in as") ? "projectsSessionNoteQuiet" : ""}`}>
                {status}
              </p>
              <>
                <p className="projectsKicker">{heroKicker}</p>
                <h1 className={`projectsHeroTitle ${featuredHeroPost ? "projectsHeroTitleFeed" : ""}`}>{heroTitle}</h1>
                <p className={`projectsHeroIntro ${featuredHeroPost ? "projectsHeroIntroFeed" : ""}`}>{heroIntro}</p>
                {featuredHeroPost && (
                  <div className="projectsHeroUtilityRow">
                    <div className="projectsHeaderActions">
                      <a href={featuredHeroPost.url} target="_blank" rel="noreferrer" className="projectPrimaryButton projectPrimaryButtonLink">
                        Read more
                      </a>
                    </div>
                  </div>
                )}
              </>
            </div>
            <aside className="projectsFeedRail" aria-label="Latest feed posts">
              <p className="projectsFeedEyebrow">Latest posts</p>
              {feedRailPosts.length > 0 ? (
                <ul className="projectsFeedList">
                  {feedRailPosts.map((post) => (
                    <li key={`${post.url}-${post.publishedAt ?? "undated"}`} className="projectsFeedItem">
                      <div className="projectsFeedMeta">
                        <span>{post.sourceName}</span>
                        <span>{formatFeedDate(post.publishedAt)}</span>
                      </div>
                      <a href={post.url} target="_blank" rel="noreferrer" className="projectsFeedLink">
                        {post.title}
                      </a>
                      <p className="projectsFeedDescription">{post.description}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="projectsFeedFallback">
                  <p>The feeds are quiet right now, so the homepage is keeping the focus on your project index.</p>
                </div>
              )}
            </aside>
          </section>
        )
      ) : null}

      {domainAllowed && workbench !== undefined && workbench !== null ? (
        <section className="projectsWorkbench">{workbench}</section>
      ) : null}

      {domainAllowed ? <div className="projectsViewport">{viewport}</div> : null}

      <dialog ref={createDialogRef} className="dialog">
        <ProjectDialogForm
          title="Create Project"
          submitLabel="Create"
          values={projectForm}
          clients={creatableClients}
          submitting={isCreatingProject}
          members={dialogMembers}
          activeUsers={activeUsers}
          currentUserId={userId ?? undefined}
          onAddMember={addMember}
          onRemoveMember={removeMember}
          onChange={setProjectForm}
          onSubmit={() => createProject().catch((error) => setStatus(error instanceof Error ? error.message : "Create failed"))}
          onCancel={() => createDialogRef.current?.close()}
        />
      </dialog>
    </main>
  );
}
