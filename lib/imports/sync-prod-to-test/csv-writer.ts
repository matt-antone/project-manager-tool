// lib/imports/sync-prod-to-test/csv-writer.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

function esc(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function createDatedCsv<T extends Record<string, unknown>>(
  dir: string,
  filename: string,
  headers: readonly string[],
  rows: readonly T[],
): string {
  const path = join(dir, filename);
  mkdirSync(dirname(path), { recursive: true });
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(","));
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

export function isoStamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
