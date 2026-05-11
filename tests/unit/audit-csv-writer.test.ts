// tests/unit/audit-csv-writer.test.ts
import { describe, it, expect } from "vitest";
import { escapeCsvField, csvRow } from "@/lib/imports/audit/csv-writer";

describe("escapeCsvField", () => {
  it("returns plain text untouched", () => {
    expect(escapeCsvField("plain")).toBe("plain");
  });
  it("quotes fields with commas", () => {
    expect(escapeCsvField("a,b")).toBe("\"a,b\"");
  });
  it("quotes fields with newlines", () => {
    expect(escapeCsvField("line1\nline2")).toBe("\"line1\nline2\"");
  });
  it("quotes and doubles inner double-quotes", () => {
    expect(escapeCsvField("she said \"hi\"")).toBe("\"she said \"\"hi\"\"\"");
  });
  it("renders null and undefined as empty", () => {
    expect(escapeCsvField(null)).toBe("");
    expect(escapeCsvField(undefined)).toBe("");
  });
  it("renders numbers via String", () => {
    expect(escapeCsvField(42)).toBe("42");
  });
});

describe("csvRow", () => {
  it("joins escaped fields with commas and trailing newline", () => {
    expect(csvRow(["a", "b,c", null])).toBe("a,\"b,c\",\n");
  });
});
