import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatedCsv } from "../../../lib/imports/sync-prod-to-test/csv-writer";

describe("createDatedCsv", () => {
  it("writes a CSV with header + rows and returns path inside given dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-csv-"));
    const path = createDatedCsv(
      dir,
      "projects.csv",
      ["a", "b"],
      [{ a: "1", b: "two,with comma" }, { a: "", b: null }],
    );
    expect(path).toBe(join(dir, "projects.csv"));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(
      'a,b\n1,"two,with comma"\n,\n',
    );
  });

  it("escapes quotes and newlines", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-csv-"));
    const path = createDatedCsv(dir, "x.csv", ["v"], [{ v: 'he said "hi"\nbye' }]);
    expect(readFileSync(path, "utf8")).toBe('v\n"he said ""hi""\nbye"\n');
  });
});
