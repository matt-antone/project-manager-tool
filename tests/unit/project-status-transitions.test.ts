import { describe, expect, it } from "vitest";
import {
  PROJECT_STATUS_LABELS,
  nextProjectStatuses,
  projectStatusTransitionError,
  type ProjectStatus
} from "@/lib/project-status";

const STATUSES: ProjectStatus[] = ["new", "in_progress", "blocked", "complete", "billing"];

/**
 * Independent oracle of allowed next statuses, hand-derived from the server
 * rules in app/projects/[id]/status/route.ts (which now delegates to
 * projectStatusTransitionError). Authored separately from the implementation so
 * a future change to the predicate is caught here. `billing` is reachable only
 * from a non-archived `complete`; `complete` may reopen to new/in_progress/blocked.
 */
const ALLOWED: Record<"active" | "archived", Record<ProjectStatus, ProjectStatus[]>> = {
  active: {
    new: ["new", "in_progress", "blocked", "complete"],
    in_progress: ["new", "in_progress", "blocked", "complete"],
    blocked: ["new", "in_progress", "blocked", "complete"],
    complete: ["new", "in_progress", "blocked", "complete", "billing"],
    billing: ["in_progress", "billing"]
  },
  archived: {
    new: ["new", "in_progress", "blocked", "complete"],
    in_progress: ["new", "in_progress", "blocked", "complete"],
    blocked: ["new", "in_progress", "blocked", "complete"],
    complete: ["new", "in_progress", "blocked", "complete"],
    billing: ["in_progress", "billing"]
  }
};

describe("project status transitions", () => {
  for (const current of STATUSES) {
    for (const next of STATUSES) {
      for (const archived of [false, true]) {
        const allowed = ALLOWED[archived ? "archived" : "active"][current].includes(next);
        it(`${current} -> ${next} (archived=${archived}) is ${allowed ? "allowed" : "rejected"}`, () => {
          const error = projectStatusTransitionError(current, next, archived);
          expect(error === null).toBe(allowed);
          expect(nextProjectStatuses(current, archived).includes(next)).toBe(allowed);
        });
      }
    }
  }

  it("uses the exact rejection messages", () => {
    expect(projectStatusTransitionError("in_progress", "billing", false)).toBe(
      "Projects can move to billing only from an active complete state."
    );
    expect(projectStatusTransitionError("complete", "billing", true)).toBe(
      "Projects can move to billing only from an active complete state."
    );
    expect(projectStatusTransitionError("billing", "blocked", false)).toBe(
      "Billing projects can only reopen to In Progress."
    );
  });

  it("always includes the current status as a no-op option", () => {
    for (const current of STATUSES) {
      for (const archived of [false, true]) {
        expect(projectStatusTransitionError(current, current, archived)).toBeNull();
        expect(nextProjectStatuses(current, archived)).toContain(current);
      }
    }
  });

  it("has a label for every status", () => {
    for (const status of STATUSES) {
      expect(PROJECT_STATUS_LABELS[status]).toBeTruthy();
    }
  });
});
