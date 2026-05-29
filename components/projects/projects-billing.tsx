"use client";

import { useEffect, useState } from "react";
import { OneShotButton } from "@/components/one-shot-button";
import { BillingProjectRow, type BillingProjectItem } from "@/components/projects/billing-project-row";
import { useProjectsWorkspace } from "@/components/projects/projects-workspace-context";
import { ProjectsWorkspaceShell } from "@/components/projects/projects-workspace-shell";
import { authedJsonFetch } from "@/lib/browser-auth";
import type { ProjectUserHours } from "@/lib/repositories";

type BillingRow = BillingProjectItem & { user_hours_breakdown?: ProjectUserHours[] | null };

type BillingResult = {
  projects: BillingRow[];
};

export function ProjectsBilling() {
  const { accessToken, setAccessToken, openCreateDialog, domainAllowed, filterClientId } = useProjectsWorkspace();
  const [result, setResult] = useState<BillingResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({
      billingOnly: "true",
      includeArchived: "false"
    });
    if (filterClientId) {
      params.set("clientId", filterClientId);
    }

    authedJsonFetch({ accessToken, onToken: setAccessToken, path: `/projects?${params.toString()}` })
      .then(({ data }) => {
        if (cancelled) return;
        setResult(data as BillingResult);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load billing projects");
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, filterClientId, refreshKey, setAccessToken]);

  async function handleArchive(project: BillingProjectItem) {
    await authedJsonFetch({
      accessToken,
      onToken: setAccessToken,
      path: `/projects/${project.id}/archive`,
      init: { method: "POST" }
    });
    setRefreshKey((value) => value + 1);
  }

  async function handleReopen(project: BillingProjectItem) {
    await authedJsonFetch({
      accessToken,
      onToken: setAccessToken,
      path: `/projects/${project.id}/status`,
      init: {
        method: "POST",
        body: JSON.stringify({ status: "in_progress" })
      }
    });
    setRefreshKey((value) => value + 1);
  }

  const projects = result?.projects ?? [];

  const viewport = domainAllowed ? (
    <div className="archiveTabRoot">
      <div className="projectsHeader">
        <h1>Billing</h1>
        <OneShotButton type="button" className="projectPrimaryButton" onClick={openCreateDialog}>
          New project
        </OneShotButton>
      </div>

      {!loading && !error && (
        <section className="projectsFilterShelf">
          <div className="projectsResultsMeta">
            <p className="projectsResultsNote">
              {projects.length} billing project{projects.length === 1 ? "" : "s"}
            </p>
          </div>
        </section>
      )}

      {loading && (
        <div className="archiveLoadingState">
          <p>Loading billing projects…</p>
        </div>
      )}

      {!loading && error && (
        <div className="archiveErrorState">
          <p>{error}</p>
        </div>
      )}

      {!loading && !error && projects.length === 0 && (
        <section className="projectsEmptyState">
          <p className="projectsEmptyEyebrow">Billing</p>
          <h2>No projects are waiting on billing right now.</h2>
          <p>Completed work sent here will stay visible until you archive it or reopen the job.</p>
        </section>
      )}

      {!loading && !error && projects.length > 0 && (
        <ul className="archiveProjectList">
          {projects.map((project) => (
            <BillingProjectRow
              key={project.id}
              project={project}
              onArchive={(item) => {
                void handleArchive(item).catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : "Failed to archive billing project");
                });
              }}
              onReopen={(item) => {
                void handleReopen(item).catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : "Failed to reopen billing project");
                });
              }}
            />
          ))}
        </ul>
      )}
    </div>
  ) : null;

  return <ProjectsWorkspaceShell showHero={false} viewport={viewport} />;
}
