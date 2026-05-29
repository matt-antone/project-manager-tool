"use client";

import Link from "next/link";
import { OneShotButton } from "@/components/one-shot-button";
import { ProjectTagList } from "@/components/project-tag-list";
import { hasMissingHours, normalizeProjectColumn } from "@/lib/project-utils";
import type { ProjectUserHours } from "@/lib/repositories";

export type BillingProjectItem = {
  id: string;
  name: string;
  display_name?: string | null;
  description: string | null;
  tags?: string[] | null;
  status?: string | null;
  client_name?: string | null;
  client_code?: string | null;
  total_hours?: number | string | null;
};

type Props = {
  project: BillingProjectItem & { user_hours_breakdown?: ProjectUserHours[] | null };
  onArchive: (project: BillingProjectItem) => void;
  onReopen: (project: BillingProjectItem) => void;
};

const formatHours = (v: number | string | null | undefined): string =>
  v === null || v === undefined || v === "" || Number.isNaN(Number(v))
    ? "0.00"
    : Number(v).toFixed(2);

function BillingProjectUserHoursTable({
  rows,
  totalHours,
  projectTitle,
}: {
  rows: ProjectUserHours[];
  totalHours: number | string | null | undefined;
  projectTitle: string;
}) {
  return (
    <div className="archiveProjectHoursInner">
      <table className="archiveProjectHoursTable" aria-label={`Hours breakdown for ${projectTitle}`}>
        <thead>
          <tr>
            <th scope="col" className="archiveProjectHoursName">Name</th>
            <th scope="col" className="archiveProjectHoursValue">Hours</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const displayName =
              `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || row.email;
            return (
              <tr key={row.userId}>
                <td className="archiveProjectHoursName">{displayName}</td>
                <td className="archiveProjectHoursValue">{formatHours(row.hours)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td className="archiveProjectHoursName archiveProjectHoursTotal">Total</td>
            <td className="archiveProjectHoursValue archiveProjectHoursTotal">{formatHours(totalHours)}</td>
          </tr>
        </tfoot>
      </table>
      {rows.length === 200 && (
        <p className="archiveProjectHoursFootnote">
          Showing first 200 users (sorted by last name).
        </p>
      )}
    </div>
  );
}

export function BillingProjectRow({ project, onArchive, onReopen }: Props) {
  const column = normalizeProjectColumn(project);
  const clientLabel = project.client_name?.trim() || project.client_code?.trim() || null;
  const title = project.display_name ?? project.name;
  const missingHours = hasMissingHours(project);
  const breakdown = project.user_hours_breakdown;
  const hasBreakdown = Array.isArray(breakdown) && breakdown.length > 0;

  return (
    <li className={`archiveProjectRow${hasBreakdown ? " archiveProjectRow--withBreakdown" : ""}`}>
      <div className={`archiveProjectStatus tone-${column}`} aria-label={column.replace("_", " ")} />
      <div className="archiveProjectBody">
        <div className="archiveProjectMeta">
          {clientLabel && <span className="archiveProjectClient">{clientLabel}</span>}
          {missingHours && (
            <span className="projectMissingHours" role="status">
              Missing hours
            </span>
          )}
        </div>
        <h3 className="archiveProjectTitle">
          <Link href={`/${project.id}`} className="archiveProjectLink">
            {title}
          </Link>
        </h3>
        {project.description && <p className="archiveProjectDescription">{project.description}</p>}
        {project.tags && project.tags.length > 0 && <ProjectTagList tags={project.tags} />}
      </div>
      {hasBreakdown && (
        <div className="archiveProjectHours">
          <BillingProjectUserHoursTable rows={breakdown} totalHours={project.total_hours} projectTitle={title} />
        </div>
      )}
      <div className="archiveProjectActions projectFlowCardActions">
        <OneShotButton type="button" className="archiveRestoreButton" onClick={() => onArchive(project)}>
          Archive
        </OneShotButton>
        <OneShotButton type="button" className="archiveRestoreButton" onClick={() => onReopen(project)}>
          Reopen work
        </OneShotButton>
      </div>
    </li>
  );
}
