import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { dumpOrphanDecisions } from "@/scripts/dump-orphan-decisions";

describe("dumpOrphanDecisions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orphan-dump-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("filters status=failed and emits stub rows", async () => {
    const auditCsv = path.join(tmpDir, "projects.csv");
    await fs.writeFile(
      auditCsv,
      [
        "bc2_id,name,archived,status,local_project_id,reason",
        '100,"Mapped Project",true,mapped,uuid-1,',
        '200,"Orphan One",true,failed,,orphan title (no client match): Orphan One',
        '300,"Orphan Two: Phase",true,failed,,orphan title (no client match): Orphan Two',
        '400,"Skipped Unsupported",false,skipped_unsupported,,',
      ].join("\n") + "\n",
    );
    const out = path.join(tmpDir, "decisions.csv");
    const r = await dumpOrphanDecisions({ auditCsvPath: auditCsv, outPath: out, force: false });
    expect(r.count).toBe(2);
    const written = await fs.readFile(out, "utf8");
    expect(written).toContain("bc2_id,title,action,code,client_name");
    expect(written).toContain('200,Orphan One,,,');
    expect(written).toContain('300,Orphan Two: Phase,,,');
    expect(written).not.toContain("100,");
  });

  it("refuses to overwrite without force", async () => {
    const auditCsv = path.join(tmpDir, "projects.csv");
    await fs.writeFile(auditCsv, "bc2_id,name,archived,status,local_project_id,reason\n");
    const out = path.join(tmpDir, "decisions.csv");
    await fs.writeFile(out, "previous\n");
    await expect(
      dumpOrphanDecisions({ auditCsvPath: auditCsv, outPath: out, force: false }),
    ).rejects.toThrow(/already exists/);
  });

  it("overwrites when force=true", async () => {
    const auditCsv = path.join(tmpDir, "projects.csv");
    await fs.writeFile(
      auditCsv,
      "bc2_id,name,archived,status,local_project_id,reason\n200,Orphan,true,failed,,\n",
    );
    const out = path.join(tmpDir, "decisions.csv");
    await fs.writeFile(out, "previous\n");
    const r = await dumpOrphanDecisions({ auditCsvPath: auditCsv, outPath: out, force: true });
    expect(r.count).toBe(1);
    const written = await fs.readFile(out, "utf8");
    expect(written).not.toContain("previous");
  });
});
