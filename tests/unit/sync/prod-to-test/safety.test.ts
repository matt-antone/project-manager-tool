import { describe, it, expect } from "vitest";
import { assertEnvSafe, SafetyError } from "@/lib/sync/prod-to-test/safety";

describe("assertEnvSafe", () => {
  it("throws if PROD_DATABASE_URL equals DATABASE_URL", () => {
    expect(() =>
      assertEnvSafe({
        prodUrl: "postgres://x@h/db",
        testUrl: "postgres://x@h/db",
        prodHostHint: undefined,
      })
    ).toThrow(SafetyError);
  });

  it("throws if test url host contains the prod host hint", () => {
    expect(() =>
      assertEnvSafe({
        prodUrl: "postgres://x@prod.example.com/db",
        testUrl: "postgres://x@prod-staging.example.com/db",
        prodHostHint: "prod",
      })
    ).toThrow(/looks like prod/i);
  });

  it("passes when urls differ and host hint not matched", () => {
    expect(() =>
      assertEnvSafe({
        prodUrl: "postgres://x@prod.example.com/db",
        testUrl: "postgres://x@test.example.com/db",
        prodHostHint: "prod",
      })
    ).not.toThrow();
  });

  it("passes when host hint env is unset", () => {
    expect(() =>
      assertEnvSafe({
        prodUrl: "postgres://x@a.example.com/db",
        testUrl: "postgres://x@b.example.com/db",
        prodHostHint: undefined,
      })
    ).not.toThrow();
  });
});
