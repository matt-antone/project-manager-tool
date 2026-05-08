// lib/imports/audit/csv-writer.ts
import { promises as fs } from "fs";
import * as path from "path";
import type { WriteStream } from "fs";
import { createWriteStream } from "fs";

export function escapeCsvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csvRow(fields: unknown[]): string {
  return fields.map(escapeCsvField).join(",") + "\n";
}

export async function ensureOutDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export interface CsvHandle {
  path: string;
  stream: WriteStream;
  writeRow(fields: unknown[]): void;
  close(): Promise<void>;
}

export async function openCsv(
  outDir: string,
  filename: string,
  header: string[],
): Promise<CsvHandle> {
  const filePath = path.join(outDir, filename);
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  stream.write(csvRow(header));
  return {
    path: filePath,
    stream,
    writeRow(fields) {
      stream.write(csvRow(fields));
    },
    close() {
      return new Promise((resolve, reject) => {
        stream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
      });
    },
  };
}
