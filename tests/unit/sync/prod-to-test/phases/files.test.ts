import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runFilesPhase, type FilesPhaseDeps } from "@/lib/sync/prod-to-test/phases/files";
import type { PhaseCtx } from "@/lib/sync/prod-to-test/phases/types";

function makeCtx(): PhaseCtx {
  const watermarks = new Map();
  watermarks.set("files", new Date(0));
  return {
    prod: { query: vi.fn() } as any,
    test: { query: vi.fn() } as any,
    prodStorage: {} as any,
    testStorage: {} as any,
    watermarks,
    flags: { phase: null, limitPerPhase: null, noBackup: false, iKnowWhatImDoing: false },
    log: () => {},
  };
}

const sampleProdFile = {
  id: "f1",
  project_id: "p1",
  thread_id: null,
  comment_id: null,
  uploader_user_id: "prod-user-1",
  filename: "foo.png",
  mime_type: "image/png",
  size_bytes: 1234,
  dropbox_file_id: "id:old-prod-id",
  dropbox_path: "/Projects/Acme/Project-1/foo.png",
  checksum: "abc",
  thumbnail_url: null,
  bc_attachment_id: null,
  created_at: new Date("2026-04-30T00:00:00Z"),
};

describe("runFilesPhase", () => {
  const origProdRoot = process.env.PROD_DROPBOX_PROJECTS_ROOT_FOLDER;
  const origTestRoot = process.env.DROPBOX_PROJECTS_ROOT_FOLDER;
  beforeEach(() => {
    process.env.PROD_DROPBOX_PROJECTS_ROOT_FOLDER = "/Projects";
    process.env.DROPBOX_PROJECTS_ROOT_FOLDER = "/Projects-test";
  });
  afterEach(() => {
    process.env.PROD_DROPBOX_PROJECTS_ROOT_FOLDER = origProdRoot;
    process.env.DROPBOX_PROJECTS_ROOT_FOLDER = origTestRoot;
  });

  function makeDeps(
    copyResult:
      | { ok: true; newId: string; newPath: string }
      | { ok: false; reason: string }
  ): FilesPhaseDeps {
    return {
      dropbox: {
        copyFile: vi.fn(async () => {
          if (!copyResult.ok) throw new Error(copyResult.reason);
          return { id: copyResult.newId, pathDisplay: copyResult.newPath };
        }),
      },
    };
  }

  it("copies file in Dropbox via prefix rewrite, inserts row + map", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({ rows: [sampleProdFile] });
    const inserts: Array<{ sql: string; params: any[] }> = [];
    (ctx.test as any).query = vi.fn((sql: string, params: any[] = []) => {
      // matched-existing lookup: no matched projects.
      if (/from import_map_prod_projects where matched_existing/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_files/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_projects/i.test(sql)) return { rows: [{ local_id: "lp" }] };
      if (/from import_map_prod_users/i.test(sql)) return { rows: [{ local_id: "lu" }] };
      if (/insert into project_files/i.test(sql)) inserts.push({ sql, params });
      return { rows: [] };
    });
    const deps = makeDeps({
      ok: true,
      newId: "id:new-test-id",
      newPath: "/Projects-test/Acme/Project-1/foo.png",
    });
    const result = await runFilesPhase(ctx, deps);
    expect(result.inserted).toBe(1);
    expect(result.failed).toBe(0);
    const ins = inserts[0];
    expect(ins).toBeTruthy();
    expect(ins.params).toContain("id:new-test-id");
    expect(ins.params).toContain("/Projects-test/Acme/Project-1/foo.png");
    expect((deps.dropbox!.copyFile as any).mock.calls[0][0]).toEqual({
      fromPath: "/Projects/Acme/Project-1/foo.png",
      toPath: "/Projects-test/Acme/Project-1/foo.png",
      autorename: true,
    });
  });

  it("fails the row when Dropbox copy throws (no insert, watermark held)", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({ rows: [sampleProdFile] });
    (ctx.test as any).query = vi.fn((sql: string) => {
      if (/from import_map_prod_projects where matched_existing/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_files/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_projects/i.test(sql)) return { rows: [{ local_id: "lp" }] };
      if (/from import_map_prod_users/i.test(sql)) return { rows: [{ local_id: "lu" }] };
      return { rows: [] };
    });
    const result = await runFilesPhase(
      ctx,
      makeDeps({ ok: false, reason: "from_lookup/not_found/" })
    );
    expect(result.inserted).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].reason).toMatch(/from_lookup\/not_found/);
  });

  it("fails the row when dropbox_path does not start with prod root", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({
      rows: [{ ...sampleProdFile, dropbox_path: "/Other/strange/path.png" }],
    });
    (ctx.test as any).query = vi.fn((sql: string) => {
      if (/from import_map_prod_projects where matched_existing/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_files/i.test(sql)) return { rows: [] };
      if (/from import_map_prod_projects/i.test(sql)) return { rows: [{ local_id: "lp" }] };
      if (/from import_map_prod_users/i.test(sql)) return { rows: [{ local_id: "lu" }] };
      return { rows: [] };
    });
    const result = await runFilesPhase(
      ctx,
      makeDeps({ ok: true, newId: "n", newPath: "n" })
    );
    expect(result.inserted).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].reason).toMatch(/does not start with prod root/);
  });

  it("passes matched prod_project_ids as $2 exclusion array to prod query", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({ rows: [] });

    (ctx.test as any).query = vi.fn((sql: string) => {
      if (/from import_map_prod_projects where matched_existing/i.test(sql)) {
        return { rows: [{ prod_id: "matched-prod-p1" }] };
      }
      return { rows: [] };
    });

    await runFilesPhase(ctx, makeDeps({ ok: true, newId: "n", newPath: "n" }));

    const prodCall = (ctx.prod.query as any).mock.calls[0];
    expect(prodCall[1][0]).toEqual(["matched-prod-p1"]);
  });

  it("prod SELECT SQL contains active-job filter clauses", async () => {
    const ctx = makeCtx();
    (ctx.prod.query as any).mockResolvedValue({ rows: [] });
    (ctx.test as any).query = vi.fn(() => ({ rows: [] }));

    await runFilesPhase(ctx, makeDeps({ ok: true, newId: "n", newPath: "n" }));

    const prodSql: string = (ctx.prod.query as any).mock.calls[0][0];
    expect(prodSql).toMatch(/archived = false/);
    // status <> 'complete' removed — complete is workflow state, not archived
  });
});
