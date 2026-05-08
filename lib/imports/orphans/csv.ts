import type {
  DecisionAction,
  OrphanDecision,
  ParseDecisionResult,
  RowError,
} from "./types";

const REQUIRED_COLS = ["bc2_id", "title", "action", "code", "client_name"] as const;

function escapeField(v: string): string {
  if (/[",\n\r]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function parseLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  let field = "";
  let inQuotes = false;
  while (i < line.length) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field.length === 0) {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      out.push(field);
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  out.push(field);
  return out;
}

function splitRows(text: string): string[] {
  // Handle both LF and CRLF; preserve quoted newlines.
  const rows: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQuotes = !inQuotes;
    if ((c === "\n" || c === "\r") && !inQuotes) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (current.length > 0) rows.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

function validateRow(d: OrphanDecision): string | null {
  if (d.action === "") return "action is required (assign|create|skip)";
  if (d.action !== "assign" && d.action !== "create" && d.action !== "skip") {
    return `unknown action '${d.action}' (must be assign|create|skip)`;
  }
  if (d.action === "assign") {
    if (d.code.trim() === "") return "assign requires a non-empty code";
  }
  if (d.action === "create") {
    if (d.code.trim() === "") return "create requires a non-empty code";
    if (d.clientName.trim() === "") return "create requires a non-empty client_name";
  }
  if (d.action === "skip") {
    if (d.code.trim() !== "" || d.clientName.trim() !== "") {
      return "skip must have empty code and client_name";
    }
  }
  return null;
}

export function parseDecisionCsv(text: string): ParseDecisionResult {
  const decisions: OrphanDecision[] = [];
  const errors: RowError[] = [];

  const rows = splitRows(text);
  if (rows.length === 0) return { decisions, errors };

  const header = parseLine(rows[0]).map((s) => s.trim().toLowerCase());
  for (const required of REQUIRED_COLS) {
    if (!header.includes(required)) {
      errors.push({
        rowNumber: 1,
        bc2Id: "",
        message: `missing required column '${required}'`,
      });
    }
  }
  if (errors.length > 0) return { decisions, errors };

  const idx = (name: string) => header.indexOf(name);

  for (let r = 1; r < rows.length; r++) {
    const fields = parseLine(rows[r]);
    const bc2Id = (fields[idx("bc2_id")] ?? "").trim();
    const decision: OrphanDecision = {
      bc2Id,
      title: fields[idx("title")] ?? "",
      action: ((fields[idx("action")] ?? "").trim().toLowerCase()) as DecisionAction | "",
      code: (fields[idx("code")] ?? "").trim(),
      clientName: (fields[idx("client_name")] ?? "").trim(),
    };
    const err = validateRow(decision);
    if (err) {
      errors.push({ rowNumber: r + 1, bc2Id, message: err });
      continue;
    }
    decisions.push(decision);
  }

  return { decisions, errors };
}

export function formatDecisionCsv(decisions: OrphanDecision[]): string {
  const header = REQUIRED_COLS.join(",") + "\n";
  const body = decisions
    .map((d) =>
      [d.bc2Id, d.title, d.action, d.code, d.clientName]
        .map((v) => escapeField(String(v)))
        .join(","),
    )
    .join("\n");
  return body.length > 0 ? header + body + "\n" : header;
}
