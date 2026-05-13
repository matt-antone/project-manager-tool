"use client";

import type { ClientRecord } from "@/lib/types/client-record";
import type { ClientDetailStats } from "@/lib/types/client-stats";

function repoHref(repo: string): string {
  if (repo.startsWith("http://") || repo.startsWith("https://")) return repo;
  return `https://github.com/${repo}`;
}

export function ClientHeader({
  client,
  stats,
  onEdit
}: {
  client: ClientRecord;
  stats: ClientDetailStats;
  onEdit: () => void;
}) {
  const isArchived = Boolean(client.archived_at);
  const repos = client.github_repos ?? [];
  const domains = client.domains ?? [];
  const lastActivity = stats.lastActivityAt
    ? new Date(stats.lastActivityAt).toISOString().slice(0, 10)
    : null;

  return (
    <header className="clientHeader">
      <div className="clientHeaderMain">
        <h1>
          {client.name}
          {isArchived ? <span className="clientArchivedBadge">Archived</span> : null}
        </h1>
        {repos.length > 0 ? (
          <p className="clientHeaderLine">
            <strong>Repos:</strong>{" "}
            {repos.map((r, i) => (
              <span key={`${i}-${r}`}>
                <a href={repoHref(r)} target="_blank" rel="noreferrer">{r}</a>
                {i < repos.length - 1 ? ", " : ""}
              </span>
            ))}
          </p>
        ) : null}
        {domains.length > 0 ? (
          <p className="clientHeaderLine">
            <strong>Domains:</strong> {domains.join(", ")}
          </p>
        ) : null}
        <p className="clientHeaderLine">
          <strong>{stats.activeProjectCount} active</strong>
          {" · "}
          <strong>{stats.archivedProjectCount} archived</strong> projects
          {lastActivity ? ` · last activity ${lastActivity}` : ""}
        </p>
      </div>
      <button type="button" className="clientHeaderEdit" onClick={onEdit}>
        Edit
      </button>
    </header>
  );
}
