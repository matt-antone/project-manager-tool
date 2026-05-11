export type DecisionAction = "assign" | "create" | "skip";

export interface OrphanDecision {
  bc2Id: string;
  title: string;
  action: DecisionAction | "";
  code: string;
  clientName: string;
}

export interface RowError {
  rowNumber: number; // 1-based, header counts as row 1
  bc2Id: string;
  message: string;
}

export interface ParseDecisionResult {
  decisions: OrphanDecision[];
  errors: RowError[];
}

export type ApplyOutcome =
  | { status: "assigned"; localProjectId: string; clientId: string }
  | { status: "created"; localProjectId: string; clientId: string }
  | { status: "skipped" }
  | { status: "already_mapped"; localProjectId: string };

export class ClientNotFoundError extends Error {
  constructor(public readonly code: string) {
    super(`No client found with code='${code}'`);
    this.name = "ClientNotFoundError";
  }
}
