/** Allowed `projects.status` values (matches DB CHECK). */
const PROJECT_STATUSES = ["new", "in_progress", "blocked", "complete", "billing"] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Non-readonly tuple for Zod `z.enum`. */
export const PROJECT_STATUSES_ZOD = PROJECT_STATUSES as unknown as [ProjectStatus, ...ProjectStatus[]];

export function isProjectStatus(value: string): value is ProjectStatus {
  return (PROJECT_STATUSES as readonly string[]).includes(value);
}

/** Narrow an arbitrary stored value to a ProjectStatus, defaulting to "new". */
export function resolveProjectStatus(rawStatus: unknown): ProjectStatus {
  return typeof rawStatus === "string" && isProjectStatus(rawStatus) ? rawStatus : "new";
}

/** Human-readable labels, matching the board column wording. */
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  new: "New",
  in_progress: "In Progress",
  blocked: "Blocked",
  complete: "Complete",
  billing: "Billing"
};

/**
 * Pure port of the server's `validateProjectStatusTransition`
 * (app/projects/[id]/status/route.ts). Returns the same error string the route
 * would return, or null when the transition is allowed. Kept in lockstep with
 * the route by tests/unit/project-status-transitions.test.ts.
 */
export function projectStatusTransitionError(
  currentStatus: ProjectStatus,
  nextStatus: ProjectStatus,
  archived: boolean
): string | null {
  if (currentStatus === nextStatus) {
    return null;
  }

  if (nextStatus === "billing") {
    if (currentStatus !== "complete" || archived) {
      return "Projects can move to billing only from an active complete state.";
    }
    return null;
  }

  if (currentStatus === "billing") {
    if (nextStatus === "in_progress") {
      return null;
    }
    return "Billing projects can only reopen to In Progress.";
  }

  if (nextStatus === "new" || nextStatus === "in_progress" || nextStatus === "blocked" || nextStatus === "complete") {
    return null;
  }

  return "Invalid project status transition.";
}

/** Statuses reachable from `currentStatus` (always includes the current one). */
export function nextProjectStatuses(currentStatus: ProjectStatus, archived: boolean): ProjectStatus[] {
  return PROJECT_STATUSES.filter(
    (status) => projectStatusTransitionError(currentStatus, status, archived) === null
  );
}
