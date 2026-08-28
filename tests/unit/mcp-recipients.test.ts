// tests/unit/mcp-recipients.test.ts
import { describe, it, expect } from "vitest";
import { listProjectMemberRecipients } from "../../supabase/functions/basecamp-mcp/db.ts";

// Minimal PostgREST stub. Any `select()` naming an embed is rejected the way
// the real API does (PGRST200) — project_members has no FK to user_profiles.
function fakeSupabase(rows: Record<string, any[]>) {
  const selects: string[] = [];
  return {
    selects,
    from(table: string) {
      let data = rows[table] ?? [];
      const q: any = {
        select(cols: string) {
          selects.push(`${table}:${cols}`);
          if (cols.includes("(")) {
            return Promise.resolve({
              data: null,
              error: { code: "PGRST200", message: "Could not find a relationship" },
            });
          }
          return q;
        },
        eq(col: string, val: unknown) {
          data = data.filter((r) => r[col] === val);
          return q;
        },
        in(col: string, vals: unknown[]) {
          data = data.filter((r) => vals.includes(r[col]));
          return q;
        },
        not(col: string, _op: string, _val: unknown) {
          data = data.filter((r) => r[col] != null);
          return q;
        },
        then: (res: any) => Promise.resolve({ data, error: null }).then(res),
      };
      return q;
    },
  } as any;
}

const rows = {
  project_members: [
    { project_id: "p-1", user_id: "u-current" },
    { project_id: "p-1", user_id: "u-legacy" },
    { project_id: "p-1", user_id: "u-actor" },
    { project_id: "p-2", user_id: "u-other" },
  ],
  user_profiles: [
    { id: "u-current", email: "real@example.com", first_name: "Real", last_name: "User", is_legacy: false },
    { id: "u-legacy", email: "old@example.com", first_name: "Old", last_name: null, is_legacy: true },
    { id: "u-actor", email: "actor@example.com", first_name: "Actor", last_name: null, is_legacy: false },
  ],
};

describe("listProjectMemberRecipients", () => {
  it("regression: resolves members without a PostgREST embed", async () => {
    const supabase = fakeSupabase(rows);
    const recipients = await listProjectMemberRecipients(supabase, "p-1", null);

    // The embed form returned PGRST200 in production, so every notification
    // silently fell back to zero recipients.
    expect(supabase.selects.every((s: string) => !s.includes("("))).toBe(true);
    expect(recipients).toEqual([
      { email: "real@example.com", name: "Real User" },
      { email: "actor@example.com", name: "Actor" },
    ]);
  });

  it("drops legacy profiles and honours excludeUserId", async () => {
    const recipients = await listProjectMemberRecipients(fakeSupabase(rows), "p-1", "u-actor");
    expect(recipients).toEqual([{ email: "real@example.com", name: "Real User" }]);
  });
});
