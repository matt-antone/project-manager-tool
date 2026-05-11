import { describe, it, expect } from "vitest";
import { normalizeCode, padCodeVariants } from "../../../lib/imports/sync-prod-to-test/identity";

describe("normalizeCode", () => {
  it("uppercases prefix and strips leading zeros after dash", () => {
    expect(normalizeCode("alg-0005")).toBe("ALG-5");
    expect(normalizeCode("JFLA-0452")).toBe("JFLA-452");
    expect(normalizeCode("UNION-80")).toBe("UNION-80");
  });
  it("returns null for null/missing", () => {
    expect(normalizeCode(null)).toBeNull();
    expect(normalizeCode("")).toBeNull();
  });
  it("returns original for non-matching shapes", () => {
    expect(normalizeCode("weirdcode")).toBe("weirdcode");
  });
});

describe("padCodeVariants", () => {
  it("returns the prod code plus a 3-digit padded variant for 4-digit codes", () => {
    expect(padCodeVariants("ALG-0005")).toEqual(["ALG-0005", "ALG-005"]);
    expect(padCodeVariants("POMS-1530")).toEqual(["POMS-1530"]); // already > 999
  });
});
