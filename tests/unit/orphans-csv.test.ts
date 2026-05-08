import { describe, it, expect } from "vitest";
import { parseDecisionCsv, formatDecisionCsv } from "@/lib/imports/orphans/csv";

const HEADER = "bc2_id,title,action,code,client_name\n";

describe("parseDecisionCsv", () => {
  it("parses a valid file with all three actions", () => {
    const text =
      HEADER +
      `100,"Some Project",assign,ABC,\n` +
      `200,"Other Project",create,NEW,New Client Inc.\n` +
      `300,"Skipped Project",skip,,\n`;
    const r = parseDecisionCsv(text);
    expect(r.errors).toEqual([]);
    expect(r.decisions).toEqual([
      { bc2Id: "100", title: "Some Project", action: "assign", code: "ABC", clientName: "" },
      { bc2Id: "200", title: "Other Project", action: "create", code: "NEW", clientName: "New Client Inc." },
      { bc2Id: "300", title: "Skipped Project", action: "skip", code: "", clientName: "" },
    ]);
  });

  it("returns empty arrays for header-only file", () => {
    const r = parseDecisionCsv(HEADER);
    expect(r.decisions).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("flags missing required column header", () => {
    const r = parseDecisionCsv("bc2_id,title,action,code\n100,P,assign,ABC\n");
    expect(r.errors[0].message).toMatch(/missing required column.*client_name/i);
  });

  it("flags empty action cell", () => {
    const r = parseDecisionCsv(HEADER + `100,"Some Project",,,\n`);
    expect(r.errors[0]).toEqual({
      rowNumber: 2,
      bc2Id: "100",
      message: "action is required (assign|create|skip)",
    });
  });

  it("flags assign without code", () => {
    const r = parseDecisionCsv(HEADER + `100,"Some Project",assign,,\n`);
    expect(r.errors[0].message).toMatch(/assign requires a non-empty code/);
  });

  it("flags create without client_name", () => {
    const r = parseDecisionCsv(HEADER + `100,"Some Project",create,NEW,\n`);
    expect(r.errors[0].message).toMatch(/create requires a non-empty client_name/);
  });

  it("flags skip with non-empty code or client_name", () => {
    const r = parseDecisionCsv(HEADER + `100,"Some Project",skip,ABC,\n`);
    expect(r.errors[0].message).toMatch(/skip must have empty code and client_name/);
  });

  it("flags unknown action", () => {
    const r = parseDecisionCsv(HEADER + `100,"Some Project",bogus,,\n`);
    expect(r.errors[0].message).toMatch(/unknown action 'bogus'/);
  });

  it("parses titles with commas and double-quotes", () => {
    const text =
      HEADER + `100,"Levato (Summit LA), ""Logo"" & Stationery",assign,SUMMIT,\n`;
    const r = parseDecisionCsv(text);
    expect(r.errors).toEqual([]);
    expect(r.decisions[0].title).toBe(`Levato (Summit LA), "Logo" & Stationery`);
  });

  it("formatDecisionCsv round-trips parsed rows back to text", () => {
    const decisions = [
      { bc2Id: "100", title: `Has, "quotes"`, action: "assign" as const, code: "ABC", clientName: "" },
      { bc2Id: "200", title: "Plain", action: "skip" as const, code: "", clientName: "" },
    ];
    const text = formatDecisionCsv(decisions);
    const r = parseDecisionCsv(text);
    expect(r.errors).toEqual([]);
    expect(r.decisions).toEqual(decisions);
  });
});
