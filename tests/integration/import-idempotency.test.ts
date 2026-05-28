import { beforeEach, describe, expect, it, vi } from "vitest";

const maps = {
  projects: new Map<string, string>(),
  threads: new Map<string, string>(),
  comments: new Map<string, string>(),
  files: new Map<string, string>()
};
const fileRecords = new Map<string, string>();

const job = {
  status: "running",
  total: 0,
  success: 0,
  failed: 0
};

vi.mock("@/lib/db", () => ({
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes("select local_project_id from import_map_projects")) {
      const id = values[0] as string;
      return { rows: maps.projects.get(id) ? [{ local_project_id: maps.projects.get(id) }] : [] };
    }
    if (sql.includes("insert into import_map_projects")) {
      maps.projects.set(values[0] as string, values[1] as string);
      return { rows: [] };
    }
    if (sql.includes("select local_thread_id from import_map_threads")) {
      const id = values[0] as string;
      return { rows: maps.threads.get(id) ? [{ local_thread_id: maps.threads.get(id) }] : [] };
    }
    if (sql.includes("insert into import_map_threads")) {
      maps.threads.set(values[0] as string, values[1] as string);
      return { rows: [] };
    }
    if (sql.includes("select local_comment_id from import_map_comments")) {
      const id = values[0] as string;
      return { rows: maps.comments.get(id) ? [{ local_comment_id: maps.comments.get(id) }] : [] };
    }
    if (sql.includes("insert into import_map_comments")) {
      maps.comments.set(values[0] as string, values[1] as string);
      return { rows: [] };
    }
    if (sql.includes("select local_file_id from import_map_files")) {
      const id = values[0] as string;
      return { rows: maps.files.get(id) ? [{ local_file_id: maps.files.get(id) }] : [] };
    }
    if (sql.includes("insert into import_map_files")) {
      maps.files.set(values[0] as string, values[1] as string);
      return { rows: [] };
    }
    if (sql.includes("select * from project_files where project_id = $1 and dropbox_file_id = $2 limit 1")) {
      const key = `${values[0] as string}:${values[1] as string}`;
      return { rows: fileRecords.has(key) ? [{ id: fileRecords.get(key) }] : [] };
    }
    if (sql.includes("select local_project_id from import_map_projects where basecamp_project_id")) {
      const id = values[0] as string;
      return { rows: maps.projects.get(id) ? [{ local_project_id: maps.projects.get(id) }] : [] };
    }
    if (sql.includes("select local_thread_id from import_map_threads where basecamp_thread_id")) {
      const id = values[0] as string;
      return { rows: maps.threads.get(id) ? [{ local_thread_id: maps.threads.get(id) }] : [] };
    }
    if (sql.includes("update import_jobs")) {
      if (sql.includes("success_count")) {
        job.success += Number(values[1] ?? 0);
        job.failed += Number(values[2] ?? 0);
        job.total += Number(values[1] ?? 0) + Number(values[2] ?? 0);
      }
      if (sql.includes("set status = $2")) {
        job.status = values[1] as string;
      }
      return { rows: [] };
    }
    return { rows: [] };
  })
}));

vi.mock("@/lib/repositories", () => ({
  createProject: vi.fn(async () => ({
    project: { id: "local-project-1" },
    skippedInactiveUserIds: [],
    addedMemberEmails: []
  })),
  getProject: vi.fn(async () => ({ id: "local-project-1" })),
  createThread: vi.fn(async () => ({ id: "local-thread-1" })),
  createComment: vi.fn(async () => ({ id: "local-comment-1" })),
  createFileMetadata: vi.fn(async (args: { projectId: string; dropboxFileId: string }) => {
    const key = `${args.projectId}:${args.dropboxFileId}`;
    const id = fileRecords.get(key) ?? "local-file-1";
    fileRecords.set(key, id);
    return { id };
  })
}));

beforeEach(() => {
  maps.projects.clear();
  maps.threads.clear();
  maps.comments.clear();
  maps.files.clear();
  fileRecords.clear();
  job.status = "running";
  job.total = 0;
  job.success = 0;
  job.failed = 0;
});

describe("basecamp import idempotency", () => {
  it("can rerun safely without duplicate mappings", async () => {
    const { runBasecampImport } = await import("@/lib/imports/basecamp2-import");

    const payload = {
      projects: [{ id: "p1", name: "Project 1", createdBy: "user-1" }],
      threads: [{ id: "t1", projectId: "p1", title: "Thread", body: "Body", authorUserId: "user-1" }],
      comments: [{ id: "c1", threadId: "t1", projectId: "p1", body: "Comment", authorUserId: "user-1" }],
      files: [
        {
          id: "f1",
          projectId: "p1",
          filename: "a.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          checksum: "abc",
          dropboxFileId: "db1",
          dropboxPath: "/BasecampClone/project/a.txt",
          uploaderUserId: "user-1"
        }
      ]
    };

    await runBasecampImport("job-1", payload);
    await runBasecampImport("job-1", payload);

    expect(maps.projects.size).toBe(1);
    expect(maps.threads.size).toBe(1);
    expect(maps.comments.size).toBe(1);
    expect(maps.files.size).toBe(1);
    expect(job.status).toBe("completed");
  });
});
