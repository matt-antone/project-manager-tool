// tests/unit/audit-reader.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import {
  readPeople,
  readProjects,
  readTopicsForProject,
  readCommentsForTopic,
  readCommentDetailsForTopic,
  readAttachmentsForProject,
  listProjectIds,
} from "@/lib/imports/audit/reader";
import { makeFixtureDump } from "../support/dump-fixture";

describe("audit reader", () => {
  let dumpDir: string;

  beforeAll(async () => {
    dumpDir = await makeFixtureDump();
  });

  afterAll(async () => {
    await fs.rm(dumpDir, { recursive: true, force: true });
  });

  it("readPeople returns dump rows with ids", async () => {
    const people = await readPeople(dumpDir);
    expect(people).toEqual([{ bc2Id: 1, email: "a@b.com", name: "Alice" }]);
  });

  it("readProjects merges active + archived with archive flag", async () => {
    const projects = await readProjects(dumpDir);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ bc2Id: 1001, name: "ALG-001: Test", archived: false });
  });

  it("listProjectIds yields ids from by-project dirs", async () => {
    const ids = await listProjectIds(dumpDir);
    expect(ids).toEqual([1001]);
  });

  it("readTopicsForProject returns topic summaries", async () => {
    const topics = await readTopicsForProject(dumpDir, 1001);
    expect(topics).toEqual([
      {
        bc2ProjectId: 1001,
        bc2TopicId: 50,
        topicableType: "Message",
        title: "Hello",
      },
    ]);
  });

  it("readCommentsForTopic returns comments from the topic detail file", async () => {
    const comments = await readCommentsForTopic(dumpDir, 1001, "Message", 50);
    expect(comments).toEqual([
      { bc2ProjectId: 1001, bc2TopicId: 50, bc2CommentId: 60 },
    ]);
  });

  it("readAttachmentsForProject returns empty array when no attachments", async () => {
    const attachments = await readAttachmentsForProject(dumpDir, 1001);
    expect(attachments).toEqual([]);
  });

  it("readTopicsForProject returns empty array when topics.json missing", async () => {
    const ghostId = 9999;
    const topics = await readTopicsForProject(dumpDir, ghostId);
    expect(topics).toEqual([]);
  });
});

describe("readCommentDetailsForTopic", () => {
  const dumpDir = path.resolve(__dirname, "../fixtures/bc2-dump-stranded");

  it("returns full comment payloads in dump order", async () => {
    const result = await readCommentDetailsForTopic(dumpDir, 100, "Message", 200);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 5001,
      content: "First comment body",
      creator: { id: 9001, name: "Alice" },
      created_at: "2025-01-15T10:00:00.000Z",
    });
    expect(result[1].id).toBe(5002);
  });

  it("returns [] for unsupported topicable types", async () => {
    const result = await readCommentDetailsForTopic(dumpDir, 100, "Calendar", 200);
    expect(result).toEqual([]);
  });

  it("returns [] when detail JSON is missing", async () => {
    const result = await readCommentDetailsForTopic(dumpDir, 100, "Message", 999);
    expect(result).toEqual([]);
  });
});
