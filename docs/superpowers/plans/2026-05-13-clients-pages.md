# Clients Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/clients` (list, Active/Archive tabs) and `/clients/[id]` (per-client header + project tabs) so any authenticated member can browse clients and drill into their projects.

**Architecture:** Match existing codebase pattern — pages are client components (`"use client"`) using `fetchAuthSession` + `authedJsonFetch`. New GET endpoints extend the existing `/clients` and `/clients/[id]` routes with a `?stats=1` flag and add `/clients/[id]/projects`. Stats aggregation lives in new repository functions in `lib/repositories.ts`. Edit button on the detail page opens an inline dialog that PATCHes the existing `/clients/[id]` route.

**Tech Stack:** Next.js App Router, React 18 client components, PostgreSQL via `lib/db` (`query(sql, params)`), Zod for request validation, Vitest + happy-dom for tests.

**Spec:** `docs/superpowers/specs/2026-05-13-clients-pages-design.md`

---

## File Structure

**Create:**
- `lib/types/client-stats.ts` — shared types for stats payloads.
- `app/clients/[id]/projects/route.ts` — list a client's projects filtered by archive state.
- `app/clients/page.tsx` — list page.
- `app/clients/[id]/page.tsx` — detail page.
- `components/clients/clients-table.tsx`
- `components/clients/client-projects-table.tsx`
- `components/clients/client-tabs.tsx`
- `components/clients/client-header.tsx`
- `components/clients/client-edit-dialog.tsx`
- `components/clients/client-status-badge.tsx` — small project-status pill used in the detail table.
- `tests/unit/clients-repository-stats.test.ts`
- `tests/unit/clients-list-stats-route.test.ts`
- `tests/unit/clients-detail-stats-route.test.ts`
- `tests/unit/clients-projects-route.test.ts`
- `tests/unit/clients-table.test.tsx`
- `tests/unit/client-projects-table.test.tsx`
- `tests/unit/client-tabs.test.tsx`
- `tests/unit/client-header.test.tsx`

**Modify:**
- `lib/repositories.ts` — add `listClientsWithStats`, `getClientTabCounts`, `getClientWithStats`, `listClientProjects`.
- `app/clients/route.ts` — extend `GET` to honor `?stats=1`.
- `app/clients/[id]/route.ts` — extend `GET` to honor `?stats=1`.
- `app/header.tsx` — add `Clients` nav link.

---

## Task 1: Stats types

**Files:**
- Create: `lib/types/client-stats.ts`

- [ ] **Step 1: Create the types file**

```ts
// lib/types/client-stats.ts
import type { ClientRecord } from "@/lib/types/client-record";

export type ClientWithStats = ClientRecord & {
  active_project_count: number;
  last_activity_at: string | null;
};

export type ClientDetailStats = {
  activeProjectCount: number;
  archivedProjectCount: number;
  lastActivityAt: string | null;
};

export type ClientProjectRow = {
  id: string;
  name: string;
  status: string | null;
  last_activity_at: string | null;
  deadline: string | null;
  created_at: string;
};

export type ClientTabCounts = { active: number; archived: number };
```

- [ ] **Step 2: Commit**

```bash
git add lib/types/client-stats.ts
git commit -m "feat(types): client stats payload types"
```

---

## Task 2: Repository — `listClientsWithStats`

**Files:**
- Modify: `lib/repositories.ts`
- Test: `tests/unit/clients-repository-stats.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/clients-repository-stats.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("@/lib/db", () => ({
  query: queryMock
}));

describe("listClientsWithStats", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("filters by active and returns rows with active project count and last activity", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "c1",
          name: "Acme",
          code: "ACME",
          github_repos: [],
          domains: [],
          created_at: "2026-01-01T00:00:00.000Z",
          archived_at: null,
          active_project_count: "3",
          last_activity_at: "2026-05-10T12:00:00.000Z"
        }
      ]
    });

    const { listClientsWithStats } = await import("@/lib/repositories");
    const rows = await listClientsWithStats("active");

    expect(rows).toEqual([
      expect.objectContaining({
        id: "c1",
        active_project_count: 3,
        last_activity_at: "2026-05-10T12:00:00.000Z"
      })
    ]);

    const [sql] = queryMock.mock.calls[0];
    expect(sql).toMatch(/where c\.archived_at is null/i);
    expect(sql).toMatch(/count\(p\.id\) filter \(where p\.archived = false\)/i);
    expect(sql).toMatch(/max\(p\.last_activity_at\) filter \(where p\.archived = false\)/i);
  });

  it("filters by archived using 'is not null'", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { listClientsWithStats } = await import("@/lib/repositories");
    await listClientsWithStats("archived");
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toMatch(/where c\.archived_at is not null/i);
  });

  it("normalizes string counts to numbers", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: "c2", name: "B", code: "B", github_repos: [], domains: [],
        created_at: "2026-01-01T00:00:00.000Z", archived_at: null,
        active_project_count: "0", last_activity_at: null
      }]
    });
    const { listClientsWithStats } = await import("@/lib/repositories");
    const rows = await listClientsWithStats("active");
    expect(rows[0].active_project_count).toBe(0);
    expect(rows[0].last_activity_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm vitest run tests/unit/clients-repository-stats.test.ts`
Expected: FAIL — `listClientsWithStats` not exported.

- [ ] **Step 3: Implement in `lib/repositories.ts`**

Add at the end of the clients section (just after `updateClient`):

```ts
import type {
  ClientWithStats,
  ClientDetailStats,
  ClientProjectRow,
  ClientTabCounts
} from "@/lib/types/client-stats";

export async function listClientsWithStats(
  filter: "active" | "archived"
): Promise<ClientWithStats[]> {
  const archivedClause =
    filter === "archived" ? "c.archived_at is not null" : "c.archived_at is null";

  const result = await query(
    `select
       c.id, c.name, c.code, c.github_repos, c.domains, c.created_at, c.archived_at,
       count(p.id) filter (where p.archived = false) as active_project_count,
       max(p.last_activity_at) filter (where p.archived = false) as last_activity_at
     from clients c
     left join projects p on p.client_id = c.id
     where ${archivedClause}
     group by c.id
     order by c.name asc`
  );

  return result.rows.map((row: any) => ({
    ...row,
    active_project_count: Number(row.active_project_count ?? 0),
    last_activity_at: row.last_activity_at ?? null
  })) as ClientWithStats[];
}
```

If the existing `import` for ClientRecord is already at the top of the file, leave it. Add the new `import type` line at the top alongside the existing type imports.

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm vitest run tests/unit/clients-repository-stats.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/repositories.ts tests/unit/clients-repository-stats.test.ts
git commit -m "feat(repo): listClientsWithStats with active project count and last activity"
```

---

## Task 3: Repository — `getClientTabCounts`

**Files:**
- Modify: `lib/repositories.ts`
- Test: `tests/unit/clients-repository-stats.test.ts` (extend)

- [ ] **Step 1: Add failing test**

Append to `tests/unit/clients-repository-stats.test.ts`:

```ts
describe("getClientTabCounts", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("returns active and archived client counts as numbers", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ active: "12", archived: "5" }]
    });
    const { getClientTabCounts } = await import("@/lib/repositories");
    const counts = await getClientTabCounts();
    expect(counts).toEqual({ active: 12, archived: 5 });
  });

  it("returns zero counts when no clients", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ active: "0", archived: "0" }]
    });
    const { getClientTabCounts } = await import("@/lib/repositories");
    expect(await getClientTabCounts()).toEqual({ active: 0, archived: 0 });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm vitest run tests/unit/clients-repository-stats.test.ts`

- [ ] **Step 3: Implement**

Add to `lib/repositories.ts`:

```ts
export async function getClientTabCounts(): Promise<ClientTabCounts> {
  const result = await query(
    `select
       count(*) filter (where archived_at is null) as active,
       count(*) filter (where archived_at is not null) as archived
     from clients`
  );
  const row = result.rows[0] ?? { active: 0, archived: 0 };
  return { active: Number(row.active ?? 0), archived: Number(row.archived ?? 0) };
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add lib/repositories.ts tests/unit/clients-repository-stats.test.ts
git commit -m "feat(repo): getClientTabCounts for tab labels"
```

---

## Task 4: Repository — `getClientWithStats`

**Files:**
- Modify: `lib/repositories.ts`
- Test: `tests/unit/clients-repository-stats.test.ts` (extend)

- [ ] **Step 1: Add failing test**

Append:

```ts
describe("getClientWithStats", () => {
  beforeEach(() => { queryMock.mockReset(); });

  it("returns null when client missing", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { getClientWithStats } = await import("@/lib/repositories");
    expect(await getClientWithStats("missing")).toBeNull();
  });

  it("returns client row plus computed stats", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: "c1", name: "Acme", code: "ACME", github_repos: ["acme/web"], domains: ["acme.com"],
        created_at: "2026-01-01T00:00:00.000Z", archived_at: null,
        active_project_count: "7",
        archived_project_count: "3",
        last_activity_at: "2026-05-10T12:00:00.000Z"
      }]
    });
    const { getClientWithStats } = await import("@/lib/repositories");
    const result = await getClientWithStats("c1");
    expect(result).toEqual({
      client: expect.objectContaining({ id: "c1", github_repos: ["acme/web"], domains: ["acme.com"] }),
      stats: { activeProjectCount: 7, archivedProjectCount: 3, lastActivityAt: "2026-05-10T12:00:00.000Z" }
    });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```ts
export async function getClientWithStats(
  id: string
): Promise<{ client: ClientRecord; stats: ClientDetailStats } | null> {
  const result = await query(
    `select
       c.id, c.name, c.code, c.github_repos, c.domains, c.created_at, c.archived_at,
       count(p.id) filter (where p.archived = false) as active_project_count,
       count(p.id) filter (where p.archived = true)  as archived_project_count,
       max(p.last_activity_at) filter (where p.archived = false) as last_activity_at
     from clients c
     left join projects p on p.client_id = c.id
     where c.id = $1
     group by c.id`,
    [id]
  );

  const row = result.rows[0];
  if (!row) return null;

  const {
    active_project_count,
    archived_project_count,
    last_activity_at,
    ...client
  } = row as any;

  return {
    client: client as ClientRecord,
    stats: {
      activeProjectCount: Number(active_project_count ?? 0),
      archivedProjectCount: Number(archived_project_count ?? 0),
      lastActivityAt: last_activity_at ?? null
    }
  };
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add lib/repositories.ts tests/unit/clients-repository-stats.test.ts
git commit -m "feat(repo): getClientWithStats with active/archived counts and last activity"
```

---

## Task 5: Repository — `listClientProjects`

**Files:**
- Modify: `lib/repositories.ts`
- Test: `tests/unit/clients-repository-stats.test.ts` (extend)

- [ ] **Step 1: Add failing test**

```ts
describe("listClientProjects", () => {
  beforeEach(() => { queryMock.mockReset(); });

  it("filters active projects", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: "p1", name: "Web", status: "in_progress",
        last_activity_at: "2026-05-10T00:00:00.000Z",
        deadline: "2026-06-01", created_at: "2026-03-14T00:00:00.000Z"
      }]
    });
    const { listClientProjects } = await import("@/lib/repositories");
    const rows = await listClientProjects("c1", "active");
    expect(rows).toEqual([
      {
        id: "p1", name: "Web", status: "in_progress",
        last_activity_at: "2026-05-10T00:00:00.000Z",
        deadline: "2026-06-01", created_at: "2026-03-14T00:00:00.000Z"
      }
    ]);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/where client_id = \$1\s+and archived = \$2/i);
    expect(params).toEqual(["c1", false]);
  });

  it("filters archived projects", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { listClientProjects } = await import("@/lib/repositories");
    await listClientProjects("c1", "archived");
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(["c1", true]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```ts
export async function listClientProjects(
  clientId: string,
  filter: "active" | "archived"
): Promise<ClientProjectRow[]> {
  const result = await query(
    `select id, name, status, last_activity_at, deadline, created_at
     from projects
     where client_id = $1
       and archived = $2
     order by name asc`,
    [clientId, filter === "archived"]
  );
  return result.rows as ClientProjectRow[];
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add lib/repositories.ts tests/unit/clients-repository-stats.test.ts
git commit -m "feat(repo): listClientProjects filtered by archive state"
```

---

## Task 6: API — extend `GET /clients` with `?stats=1`

**Files:**
- Modify: `app/clients/route.ts`
- Test: `tests/unit/clients-list-stats-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/clients-list-stats-route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "u1" })
}));

const listClientsMock = vi.fn();
const listClientsWithStatsMock = vi.fn();
const getClientTabCountsMock = vi.fn();
const createClientMock = vi.fn();

vi.mock("@/lib/repositories", () => ({
  listClients: listClientsMock,
  listClientsWithStats: listClientsWithStatsMock,
  getClientTabCounts: getClientTabCountsMock,
  createClient: createClientMock
}));

describe("GET /clients with ?stats=1", () => {
  beforeEach(() => {
    listClientsMock.mockReset();
    listClientsWithStatsMock.mockReset();
    getClientTabCountsMock.mockReset();
  });

  it("returns plain client list without stats=1 (existing behavior)", async () => {
    listClientsMock.mockResolvedValue([{ id: "c1", name: "Acme" }]);
    const { GET } = await import("@/app/clients/route");
    const res = await GET(new Request("http://localhost/clients"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ clients: [{ id: "c1", name: "Acme" }] });
    expect(listClientsWithStatsMock).not.toHaveBeenCalled();
  });

  it("returns both filtered lists + counts when stats=1", async () => {
    listClientsWithStatsMock
      .mockResolvedValueOnce([{ id: "c1", active_project_count: 3, last_activity_at: null }])
      .mockResolvedValueOnce([{ id: "c2", active_project_count: 0, last_activity_at: null }]);
    getClientTabCountsMock.mockResolvedValue({ active: 1, archived: 1 });

    const { GET } = await import("@/app/clients/route");
    const res = await GET(new Request("http://localhost/clients?stats=1"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.counts).toEqual({ active: 1, archived: 1 });
    expect(body.active).toEqual([{ id: "c1", active_project_count: 3, last_activity_at: null }]);
    expect(body.archived).toEqual([{ id: "c2", active_project_count: 0, last_activity_at: null }]);
    expect(listClientsWithStatsMock).toHaveBeenNthCalledWith(1, "active");
    expect(listClientsWithStatsMock).toHaveBeenNthCalledWith(2, "archived");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm vitest run tests/unit/clients-list-stats-route.test.ts`

- [ ] **Step 3: Modify `app/clients/route.ts`**

Replace existing `GET` body to branch on `?stats=1`:

```ts
import { requireUser } from "@/lib/auth";
import { badRequest, ok, serverError, unauthorized } from "@/lib/http";
import {
  createClient,
  listClients,
  listClientsWithStats,
  getClientTabCounts
} from "@/lib/repositories";
import { z } from "zod";

const clientStringListSchema = z.array(z.string().trim().min(1));
const createClientSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1).max(16).regex(/^[A-Za-z0-9_-]+$/),
  github_repos: clientStringListSchema.optional().default([]),
  domains: clientStringListSchema.optional().default([])
});

export async function GET(request: Request) {
  try {
    await requireUser(request);
    const url = new URL(request.url);
    if (url.searchParams.get("stats") === "1") {
      const [active, archived, counts] = await Promise.all([
        listClientsWithStats("active"),
        listClientsWithStats("archived"),
        getClientTabCounts()
      ]);
      return ok({ active, archived, counts });
    }
    const clients = await listClients();
    return ok({ clients });
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    return serverError();
  }
}

// (keep existing POST handler unchanged below)
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add app/clients/route.ts tests/unit/clients-list-stats-route.test.ts
git commit -m "feat(api): GET /clients?stats=1 returns active+archived lists with counts"
```

---

## Task 7: API — extend `GET /clients/[id]` with `?stats=1`

**Files:**
- Modify: `app/clients/[id]/route.ts`
- Test: `tests/unit/clients-detail-stats-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/clients-detail-stats-route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "u1" })
}));

const getClientByIdMock = vi.fn();
const getClientWithStatsMock = vi.fn();
const updateClientMock = vi.fn();

vi.mock("@/lib/repositories", () => ({
  getClientById: getClientByIdMock,
  getClientWithStats: getClientWithStatsMock,
  updateClient: updateClientMock
}));

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /clients/[id] with ?stats=1", () => {
  beforeEach(() => {
    getClientByIdMock.mockReset();
    getClientWithStatsMock.mockReset();
  });

  it("returns plain client without stats=1", async () => {
    getClientByIdMock.mockResolvedValue({ id: "c1", name: "Acme" });
    const { GET } = await import("@/app/clients/[id]/route");
    const res = await GET(new Request("http://localhost/clients/c1"), paramsFor("c1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ client: { id: "c1", name: "Acme" } });
    expect(getClientWithStatsMock).not.toHaveBeenCalled();
  });

  it("returns 404 when stats=1 client missing", async () => {
    getClientWithStatsMock.mockResolvedValue(null);
    const { GET } = await import("@/app/clients/[id]/route");
    const res = await GET(new Request("http://localhost/clients/c1?stats=1"), paramsFor("c1"));
    expect(res.status).toBe(404);
  });

  it("returns client + stats when stats=1", async () => {
    getClientWithStatsMock.mockResolvedValue({
      client: { id: "c1", name: "Acme" },
      stats: { activeProjectCount: 7, archivedProjectCount: 3, lastActivityAt: "2026-05-10T12:00:00.000Z" }
    });
    const { GET } = await import("@/app/clients/[id]/route");
    const res = await GET(new Request("http://localhost/clients/c1?stats=1"), paramsFor("c1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      client: { id: "c1", name: "Acme" },
      stats: { activeProjectCount: 7, archivedProjectCount: 3, lastActivityAt: "2026-05-10T12:00:00.000Z" }
    });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Modify `app/clients/[id]/route.ts`**

Replace the existing `GET` handler (leave PATCH untouched). Add `getClientWithStats` to imports:

```ts
import { getClientById, getClientWithStats, updateClient } from "@/lib/repositories";
```

Then:

```ts
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser(request);
    const { id } = await params;
    const url = new URL(request.url);
    if (url.searchParams.get("stats") === "1") {
      const result = await getClientWithStats(id);
      if (!result) return notFound("Client not found");
      return ok(result);
    }
    const client = await getClientById(id);
    if (!client) return notFound("Client not found");
    return ok({ client });
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    return serverError();
  }
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add app/clients/[id]/route.ts tests/unit/clients-detail-stats-route.test.ts
git commit -m "feat(api): GET /clients/[id]?stats=1 returns client with stats"
```

---

## Task 8: API — new `GET /clients/[id]/projects?filter=`

**Files:**
- Create: `app/clients/[id]/projects/route.ts`
- Test: `tests/unit/clients-projects-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/clients-projects-route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "u1" })
}));

const listClientProjectsMock = vi.fn();
vi.mock("@/lib/repositories", () => ({
  listClientProjects: listClientProjectsMock
}));

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /clients/[id]/projects", () => {
  beforeEach(() => { listClientProjectsMock.mockReset(); });

  it("returns active projects", async () => {
    listClientProjectsMock.mockResolvedValue([{ id: "p1", name: "Web" }]);
    const { GET } = await import("@/app/clients/[id]/projects/route");
    const res = await GET(new Request("http://localhost/clients/c1/projects?filter=active"), paramsFor("c1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projects: [{ id: "p1", name: "Web" }] });
    expect(listClientProjectsMock).toHaveBeenCalledWith("c1", "active");
  });

  it("returns archived projects", async () => {
    listClientProjectsMock.mockResolvedValue([]);
    const { GET } = await import("@/app/clients/[id]/projects/route");
    const res = await GET(new Request("http://localhost/clients/c1/projects?filter=archived"), paramsFor("c1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projects: [] });
    expect(listClientProjectsMock).toHaveBeenCalledWith("c1", "archived");
  });

  it("400s on invalid filter", async () => {
    const { GET } = await import("@/app/clients/[id]/projects/route");
    const res = await GET(new Request("http://localhost/clients/c1/projects?filter=junk"), paramsFor("c1"));
    expect(res.status).toBe(400);
    expect(listClientProjectsMock).not.toHaveBeenCalled();
  });

  it("400s when filter missing", async () => {
    const { GET } = await import("@/app/clients/[id]/projects/route");
    const res = await GET(new Request("http://localhost/clients/c1/projects"), paramsFor("c1"));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm vitest run tests/unit/clients-projects-route.test.ts`

- [ ] **Step 3: Create `app/clients/[id]/projects/route.ts`**

```ts
import { requireUser } from "@/lib/auth";
import { badRequest, ok, serverError, unauthorized } from "@/lib/http";
import { listClientProjects } from "@/lib/repositories";
import { z } from "zod";

const filterSchema = z.enum(["active", "archived"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireUser(request);
    const { id } = await params;
    const url = new URL(request.url);
    const filter = filterSchema.parse(url.searchParams.get("filter"));
    const projects = await listClientProjects(id, filter);
    return ok({ projects });
  } catch (error) {
    if (error instanceof Error && /auth|token|workspace/i.test(error.message)) {
      return unauthorized(error.message);
    }
    if (error instanceof z.ZodError) {
      return badRequest("filter must be 'active' or 'archived'");
    }
    return serverError();
  }
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add app/clients/[id]/projects/route.ts tests/unit/clients-projects-route.test.ts
git commit -m "feat(api): GET /clients/[id]/projects with filter"
```

---

## Task 9: Component — `<ClientTabs />`

**Files:**
- Create: `components/clients/client-tabs.tsx`
- Test: `tests/unit/client-tabs.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/client-tabs.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClientTabs } from "@/components/clients/client-tabs";

describe("<ClientTabs />", () => {
  it("renders both labels with counts", () => {
    render(
      <ClientTabs current="active" counts={{ active: 12, archived: 5 }} onChange={() => {}} />
    );
    expect(screen.getByRole("tab", { name: /Active \(12\)/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Archived \(5\)/ })).toBeTruthy();
  });

  it("marks the current tab as selected", () => {
    render(
      <ClientTabs current="archived" counts={{ active: 12, archived: 5 }} onChange={() => {}} />
    );
    expect(screen.getByRole("tab", { selected: true }).textContent).toMatch(/Archived/);
  });

  it("calls onChange when clicking the other tab", () => {
    const onChange = vi.fn();
    render(
      <ClientTabs current="active" counts={{ active: 1, archived: 1 }} onChange={onChange} />
    );
    fireEvent.click(screen.getByRole("tab", { name: /Archived/ }));
    expect(onChange).toHaveBeenCalledWith("archived");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```tsx
"use client";

import type { ClientTabCounts } from "@/lib/types/client-stats";

type Tab = "active" | "archived";

export function ClientTabs({
  current,
  counts,
  onChange
}: {
  current: Tab;
  counts: ClientTabCounts;
  onChange: (next: Tab) => void;
}) {
  return (
    <div role="tablist" className="clientTabs">
      <button
        type="button"
        role="tab"
        aria-selected={current === "active"}
        onClick={() => onChange("active")}
      >
        Active ({counts.active})
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={current === "archived"}
        onClick={() => onChange("archived")}
      >
        Archived ({counts.archived})
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add components/clients/client-tabs.tsx tests/unit/client-tabs.test.tsx
git commit -m "feat(ui): ClientTabs primitive with count labels"
```

---

## Task 10: Component — `<ClientsTable />`

**Files:**
- Create: `components/clients/clients-table.tsx`
- Test: `tests/unit/clients-table.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/clients-table.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClientsTable } from "@/components/clients/clients-table";
import type { ClientWithStats } from "@/lib/types/client-stats";

const row = (overrides: Partial<ClientWithStats> = {}): ClientWithStats => ({
  id: "c1",
  name: "Acme Corp",
  code: "ACME",
  github_repos: [],
  domains: [],
  created_at: "2026-01-01T00:00:00.000Z",
  archived_at: null,
  active_project_count: 7,
  last_activity_at: "2026-05-10T12:00:00.000Z",
  ...overrides
});

describe("<ClientsTable />", () => {
  it("renders row with name link to detail page", () => {
    render(<ClientsTable rows={[row()]} tab="active" />);
    const link = screen.getByRole("link", { name: /Acme Corp/ });
    expect(link.getAttribute("href")).toBe("/clients/c1");
  });

  it("renders active project count and last activity", () => {
    render(<ClientsTable rows={[row()]} tab="active" />);
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText(/2026-05-10/)).toBeTruthy();
  });

  it("renders em dash for null last activity", () => {
    render(<ClientsTable rows={[row({ last_activity_at: null })]} tab="active" />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("renders active empty state", () => {
    render(<ClientsTable rows={[]} tab="active" />);
    expect(screen.getByText(/No active clients/i)).toBeTruthy();
  });

  it("renders archived empty state", () => {
    render(<ClientsTable rows={[]} tab="archived" />);
    expect(screen.getByText(/No archived clients/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```tsx
"use client";

import Link from "next/link";
import type { ClientWithStats } from "@/lib/types/client-stats";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

export function ClientsTable({
  rows,
  tab
}: {
  rows: ClientWithStats[];
  tab: "active" | "archived";
}) {
  if (rows.length === 0) {
    return (
      <p className="clientsTableEmpty">
        {tab === "active" ? "No active clients." : "No archived clients."}
      </p>
    );
  }

  return (
    <table className="clientsTable">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Active projects</th>
          <th scope="col">Last activity</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>
              <Link href={`/clients/${r.id}`} prefetch={false}>
                {r.name}
              </Link>
            </td>
            <td>{r.active_project_count}</td>
            <td>{formatDate(r.last_activity_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add components/clients/clients-table.tsx tests/unit/clients-table.test.tsx
git commit -m "feat(ui): ClientsTable with name/projects/last-activity columns"
```

---

## Task 11: Component — `<ClientStatusBadge />`

**Files:**
- Create: `components/clients/client-status-badge.tsx`

- [ ] **Step 1: Implement (no separate test — covered by projects-table tests)**

```tsx
// components/clients/client-status-badge.tsx
export function ClientStatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="clientStatusBadge tone-unknown">—</span>;
  const label = status.replace(/_/g, " ");
  return (
    <span className={`clientStatusBadge tone-${status}`} aria-label={label}>
      {label}
    </span>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add components/clients/client-status-badge.tsx
git commit -m "feat(ui): ClientStatusBadge pill for project status"
```

---

## Task 12: Component — `<ClientProjectsTable />`

**Files:**
- Create: `components/clients/client-projects-table.tsx`
- Test: `tests/unit/client-projects-table.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/client-projects-table.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClientProjectsTable } from "@/components/clients/client-projects-table";
import type { ClientProjectRow } from "@/lib/types/client-stats";

const row = (o: Partial<ClientProjectRow> = {}): ClientProjectRow => ({
  id: "p1",
  name: "Website redesign",
  status: "in_progress",
  last_activity_at: "2026-05-10T00:00:00.000Z",
  deadline: "2026-06-01",
  created_at: "2026-03-14T00:00:00.000Z",
  ...o
});

describe("<ClientProjectsTable />", () => {
  it("renders project row linking to /projects/[id]", () => {
    render(<ClientProjectsTable rows={[row()]} tab="active" />);
    const link = screen.getByRole("link", { name: /Website redesign/ });
    expect(link.getAttribute("href")).toBe("/projects/p1");
  });

  it("renders status badge with the status label", () => {
    render(<ClientProjectsTable rows={[row()]} tab="active" />);
    expect(screen.getByLabelText("in progress")).toBeTruthy();
  });

  it("renders em dash for null deadline and null last_activity_at", () => {
    render(
      <ClientProjectsTable rows={[row({ deadline: null, last_activity_at: null })]} tab="active" />
    );
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it("renders active empty state", () => {
    render(<ClientProjectsTable rows={[]} tab="active" />);
    expect(screen.getByText(/No active projects for this client/i)).toBeTruthy();
  });

  it("renders archived empty state", () => {
    render(<ClientProjectsTable rows={[]} tab="archived" />);
    expect(screen.getByText(/No archived projects for this client/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```tsx
"use client";

import Link from "next/link";
import type { ClientProjectRow } from "@/lib/types/client-stats";
import { ClientStatusBadge } from "@/components/clients/client-status-badge";

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

export function ClientProjectsTable({
  rows,
  tab
}: {
  rows: ClientProjectRow[];
  tab: "active" | "archived";
}) {
  if (rows.length === 0) {
    return (
      <p className="clientProjectsTableEmpty">
        {tab === "active"
          ? "No active projects for this client."
          : "No archived projects for this client."}
      </p>
    );
  }
  return (
    <table className="clientProjectsTable">
      <thead>
        <tr>
          <th>Project</th>
          <th>Status</th>
          <th>Last activity</th>
          <th>Due</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>
              <Link href={`/projects/${r.id}`} prefetch={false}>
                {r.name}
              </Link>
            </td>
            <td><ClientStatusBadge status={r.status} /></td>
            <td>{fmt(r.last_activity_at)}</td>
            <td>{r.deadline ? r.deadline : "—"}</td>
            <td>{fmt(r.created_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add components/clients/client-projects-table.tsx tests/unit/client-projects-table.test.tsx
git commit -m "feat(ui): ClientProjectsTable with status badge"
```

---

## Task 13: Component — `<ClientHeader />`

**Files:**
- Create: `components/clients/client-header.tsx`
- Test: `tests/unit/client-header.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/client-header.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClientHeader } from "@/components/clients/client-header";

const baseClient = {
  id: "c1",
  name: "Acme",
  code: "ACME",
  github_repos: [] as string[],
  domains: [] as string[],
  created_at: "2026-01-01T00:00:00.000Z",
  archived_at: null as string | null
};

describe("<ClientHeader />", () => {
  it("renders name and counts line", () => {
    render(
      <ClientHeader
        client={baseClient}
        stats={{ activeProjectCount: 7, archivedProjectCount: 3, lastActivityAt: null }}
        onEdit={() => {}}
      />
    );
    expect(screen.getByRole("heading", { name: /Acme/ })).toBeTruthy();
    expect(screen.getByText(/7 active/)).toBeTruthy();
    expect(screen.getByText(/3 archived/)).toBeTruthy();
  });

  it("shows archived badge only when archived_at set", () => {
    const { rerender } = render(
      <ClientHeader client={baseClient}
        stats={{ activeProjectCount: 0, archivedProjectCount: 0, lastActivityAt: null }}
        onEdit={() => {}} />
    );
    expect(screen.queryByText("Archived")).toBeNull();

    rerender(
      <ClientHeader client={{ ...baseClient, archived_at: "2026-04-01T00:00:00.000Z" }}
        stats={{ activeProjectCount: 0, archivedProjectCount: 0, lastActivityAt: null }}
        onEdit={() => {}} />
    );
    expect(screen.getByText("Archived")).toBeTruthy();
  });

  it("omits repos line when github_repos empty", () => {
    render(
      <ClientHeader client={baseClient}
        stats={{ activeProjectCount: 0, archivedProjectCount: 0, lastActivityAt: null }}
        onEdit={() => {}} />
    );
    expect(screen.queryByText(/Repos:/)).toBeNull();
  });

  it("renders repos line when github_repos has items", () => {
    render(
      <ClientHeader client={{ ...baseClient, github_repos: ["acme/web", "acme/api"] }}
        stats={{ activeProjectCount: 0, archivedProjectCount: 0, lastActivityAt: null }}
        onEdit={() => {}} />
    );
    expect(screen.getByText("Repos:")).toBeTruthy();
    expect(screen.getByRole("link", { name: "acme/web" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "acme/api" })).toBeTruthy();
  });

  it("omits domains line when empty; renders when populated", () => {
    const { rerender } = render(
      <ClientHeader client={baseClient}
        stats={{ activeProjectCount: 0, archivedProjectCount: 0, lastActivityAt: null }}
        onEdit={() => {}} />
    );
    expect(screen.queryByText(/Domains:/)).toBeNull();

    rerender(
      <ClientHeader client={{ ...baseClient, domains: ["acme.com", "app.acme.com"] }}
        stats={{ activeProjectCount: 0, archivedProjectCount: 0, lastActivityAt: null }}
        onEdit={() => {}} />
    );
    expect(screen.getByText("Domains:")).toBeTruthy();
    expect(screen.getByText("acme.com, app.acme.com")).toBeTruthy();
  });

  it("clicking Edit calls onEdit", () => {
    const onEdit = vi.fn();
    render(
      <ClientHeader client={baseClient}
        stats={{ activeProjectCount: 0, archivedProjectCount: 0, lastActivityAt: null }}
        onEdit={onEdit} />
    );
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    expect(onEdit).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```tsx
"use client";

import type { ClientRecord } from "@/lib/types/client-record";
import type { ClientDetailStats } from "@/lib/types/client-stats";

function repoHref(repo: string): string {
  if (repo.startsWith("http://") || repo.startsWith("https://")) return repo;
  return `https://github.com/${repo}`;
}

export function ClientHeader({
  client,
  stats,
  onEdit
}: {
  client: ClientRecord;
  stats: ClientDetailStats;
  onEdit: () => void;
}) {
  const isArchived = Boolean(client.archived_at);
  const repos = client.github_repos ?? [];
  const domains = client.domains ?? [];
  const lastActivity = stats.lastActivityAt
    ? new Date(stats.lastActivityAt).toISOString().slice(0, 10)
    : null;

  return (
    <header className="clientHeader">
      <div className="clientHeaderMain">
        <h1>
          {client.name}
          {isArchived ? <span className="clientArchivedBadge">Archived</span> : null}
        </h1>
        {repos.length > 0 ? (
          <p className="clientHeaderLine">
            <strong>Repos:</strong>{" "}
            {repos.map((r, i) => (
              <span key={r}>
                <a href={repoHref(r)} target="_blank" rel="noreferrer">{r}</a>
                {i < repos.length - 1 ? ", " : ""}
              </span>
            ))}
          </p>
        ) : null}
        {domains.length > 0 ? (
          <p className="clientHeaderLine">
            <strong>Domains:</strong> {domains.join(", ")}
          </p>
        ) : null}
        <p className="clientHeaderLine">
          <strong>{stats.activeProjectCount} active</strong>
          {" · "}
          <strong>{stats.archivedProjectCount} archived</strong> projects
          {lastActivity ? ` · last activity ${lastActivity}` : ""}
        </p>
      </div>
      <button type="button" className="clientHeaderEdit" onClick={onEdit}>
        Edit
      </button>
    </header>
  );
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add components/clients/client-header.tsx tests/unit/client-header.test.tsx
git commit -m "feat(ui): ClientHeader with badge, repos, domains, counts, edit button"
```

---

## Task 14: Component — `<ClientEditDialog />`

**Files:**
- Create: `components/clients/client-edit-dialog.tsx`

Scope note: for v1 the dialog reproduces the existing settings form's relevant fields (name, github_repos, domains) without extracting the settings form. Extraction can happen later. The dialog calls `PATCH /clients/[id]` with the same payload shape the settings page uses.

- [ ] **Step 1: Implement**

```tsx
"use client";

import { useEffect, useState } from "react";
import { authedJsonFetch } from "@/lib/browser-auth";
import type { ClientRecord } from "@/lib/types/client-record";

function listToText(values: string[] | null | undefined): string {
  return (values ?? []).join("\n");
}

function textToList(raw: string): string[] {
  return raw
    .split(/\r?\n|,/g)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function ClientEditDialog({
  client,
  accessToken,
  open,
  onClose,
  onSaved
}: {
  client: ClientRecord;
  accessToken: string;
  open: boolean;
  onClose: () => void;
  onSaved: (next: ClientRecord) => void;
}) {
  const [name, setName] = useState(client.name);
  const [reposText, setReposText] = useState(listToText(client.github_repos));
  const [domainsText, setDomainsText] = useState(listToText(client.domains));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(client.name);
      setReposText(listToText(client.github_repos));
      setDomainsText(listToText(client.domains));
      setError(null);
    }
  }, [open, client]);

  if (!open) return null;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await authedJsonFetch({
        accessToken,
        path: `/clients/${client.id}`,
        init: {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            github_repos: textToList(reposText),
            domains: textToList(domainsText)
          })
        }
      });
      onSaved((data as { client: ClientRecord }).client);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" className="clientEditDialog">
      <form onSubmit={handleSubmit}>
        <h2>Edit client</h2>
        <label>
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label>
          GitHub repos (one per line)
          <textarea
            value={reposText}
            onChange={(e) => setReposText(e.target.value)}
            rows={3}
          />
        </label>
        <label>
          Domains (one per line)
          <textarea
            value={domainsText}
            onChange={(e) => setDomainsText(e.target.value)}
            rows={3}
          />
        </label>
        {error ? <p role="alert" className="clientEditDialogError">{error}</p> : null}
        <div className="clientEditDialogActions">
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" disabled={submitting || !name.trim()}>
            {submitting ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add components/clients/client-edit-dialog.tsx
git commit -m "feat(ui): ClientEditDialog with name/repos/domains PATCH"
```

---

## Task 15: Page — `app/clients/page.tsx`

**Files:**
- Create: `app/clients/page.tsx`

- [ ] **Step 1: Implement**

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authedJsonFetch, fetchAuthSession } from "@/lib/browser-auth";
import { PageLoadingState } from "@/components/loading-shells";
import { ClientTabs } from "@/components/clients/client-tabs";
import { ClientsTable } from "@/components/clients/clients-table";
import type { ClientTabCounts, ClientWithStats } from "@/lib/types/client-stats";

type Tab = "active" | "archived";

function parseTab(raw: string | null): Tab {
  return raw === "archived" ? "archived" : "active";
}

export default function ClientsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = parseTab(searchParams.get("tab"));

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [data, setData] = useState<{
    active: ClientWithStats[];
    archived: ClientWithStats[];
    counts: ClientTabCounts;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const session = await fetchAuthSession();
        if (!session?.accessToken) {
          setError("Sign in required");
          return;
        }
        if (cancelled) return;
        setAccessToken(session.accessToken);
        const { data: payload } = await authedJsonFetch({
          accessToken: session.accessToken,
          path: "/clients?stats=1"
        });
        if (cancelled) return;
        setData(payload as typeof data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load clients");
        }
      }
    }
    bootstrap();
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    return tab === "active" ? data.active : data.archived;
  }, [data, tab]);

  function handleTabChange(next: Tab) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`/clients?${params.toString()}`);
  }

  if (error) return <p role="alert">{error}</p>;
  if (!data || !accessToken) return <PageLoadingState label="Clients" message="Loading clients..." />;

  return (
    <div className="clientsPage">
      <h1>Clients</h1>
      <ClientTabs current={tab} counts={data.counts} onChange={handleTabChange} />
      <ClientsTable rows={rows} tab={tab} />
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/clients/page.tsx
git commit -m "feat(ui): /clients list page with active/archive tabs"
```

---

## Task 16: Page — `app/clients/[id]/page.tsx`

**Files:**
- Create: `app/clients/[id]/page.tsx`

- [ ] **Step 1: Implement**

```tsx
"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { authedJsonFetch, fetchAuthSession } from "@/lib/browser-auth";
import { PageLoadingState } from "@/components/loading-shells";
import { ClientHeader } from "@/components/clients/client-header";
import { ClientTabs } from "@/components/clients/client-tabs";
import { ClientProjectsTable } from "@/components/clients/client-projects-table";
import { ClientEditDialog } from "@/components/clients/client-edit-dialog";
import type { ClientRecord } from "@/lib/types/client-record";
import type {
  ClientDetailStats,
  ClientProjectRow
} from "@/lib/types/client-stats";

type Tab = "active" | "archived";

function parseTab(raw: string | null): Tab {
  return raw === "archived" ? "archived" : "active";
}

export default function ClientDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const clientId = String(params?.id ?? "");
  const tab = parseTab(searchParams.get("tab"));

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [client, setClient] = useState<ClientRecord | null>(null);
  const [stats, setStats] = useState<ClientDetailStats | null>(null);
  const [projects, setProjects] = useState<ClientProjectRow[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const session = await fetchAuthSession();
        if (!session?.accessToken) {
          setError("Sign in required");
          return;
        }
        if (cancelled) return;
        setAccessToken(session.accessToken);
        const res = await fetch(`/clients/${clientId}?stats=1`, {
          headers: { Authorization: `Bearer ${session.accessToken}` },
          credentials: "same-origin"
        });
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`Failed: ${res.status}`);
        const payload = (await res.json()) as {
          client: ClientRecord;
          stats: ClientDetailStats;
        };
        if (cancelled) return;
        setClient(payload.client);
        setStats(payload.stats);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      }
    }
    if (clientId) bootstrap();
    return () => { cancelled = true; };
  }, [clientId]);

  useEffect(() => {
    if (!accessToken || !clientId) return;
    let cancelled = false;
    setProjects(null);
    (async () => {
      try {
        const { data } = await authedJsonFetch({
          accessToken,
          path: `/clients/${clientId}/projects?filter=${tab}`
        });
        if (cancelled) return;
        setProjects((data as { projects: ClientProjectRow[] }).projects);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load projects");
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken, clientId, tab]);

  function handleTabChange(next: Tab) {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("tab", next);
    router.replace(`/clients/${clientId}?${sp.toString()}`);
  }

  if (notFound) return <p>Client not found.</p>;
  if (error) return <p role="alert">{error}</p>;
  if (!client || !stats) return <PageLoadingState label="Client" message="Loading client..." />;

  return (
    <div className="clientDetailPage">
      <ClientHeader
        client={client}
        stats={stats}
        onEdit={() => setEditOpen(true)}
      />
      <ClientTabs
        current={tab}
        counts={{ active: stats.activeProjectCount, archived: stats.archivedProjectCount }}
        onChange={handleTabChange}
      />
      {projects === null ? (
        <p>Loading projects...</p>
      ) : (
        <ClientProjectsTable rows={projects} tab={tab} />
      )}
      {accessToken ? (
        <ClientEditDialog
          client={client}
          accessToken={accessToken}
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onSaved={(next) => setClient(next)}
        />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/clients/[id]/page.tsx
git commit -m "feat(ui): /clients/[id] page with header, project tabs, edit dialog"
```

---

## Task 17: Header nav — add `Clients` link

**Files:**
- Modify: `app/header.tsx`

- [ ] **Step 1: Add the link**

Find the `<nav className="themeTopBarProjectsNav" …>` block (after `Project Board`, before `Billing`). Insert the new link:

```tsx
<Link
  href="/clients"
  prefetch={false}
  className={`themeTopBarProjectsLink ${
    typeof window !== "undefined" && window.location.pathname.startsWith("/clients")
      ? "themeTopBarProjectsLinkActive"
      : ""
  }`}
  scroll={false}
>
  Clients
</Link>
```

If the existing nav links use `usePathname()` instead of `window.location` for active highlighting, mirror that pattern — read `usePathname()` once at the top of the component and compute `clientsNavActive = pathname?.startsWith("/clients")`. (The component already has `usePathname` imported.)

- [ ] **Step 2: Verify**

Run: `pnpm tsc --noEmit`
Run dev server: `pnpm dev` and confirm `Clients` appears in the top nav between Project Board and Billing.

- [ ] **Step 3: Commit**

```bash
git add app/header.tsx
git commit -m "feat(ui): Clients link in top nav"
```

---

## Task 18: Manual verification + final commit

- [ ] **Step 1: Start the dev server**

```bash
pnpm dev
```

- [ ] **Step 2: Walk the golden path**

In the browser:

1. Visit `/`. Confirm `Clients` is in the top nav.
2. Click `Clients`. URL should be `/clients` with Active tab selected. Counts visible.
3. Click `Archived` tab. URL becomes `/clients?tab=archived`. Empty-state shows if no archived clients.
4. Click `Active` tab again. Counts unchanged. Click a client row → navigates to `/clients/<id>`.
5. On the detail page:
   - Header shows name. If client has repos / domains, lines appear. Counts line shows `<n> active · <m> archived projects`.
   - Switch between Active / Archived tabs; project rows reload.
   - Click a project row → navigates to `/projects/<id>`.
   - Click `Edit`. Modify name. Click Save. Header updates with new name.
6. Visit `/clients/does-not-exist`. "Client not found." renders.
7. Visit an archived client's detail page (one with `archived_at` set). Archive badge renders next to the name.

- [ ] **Step 3: Run all tests**

```bash
pnpm vitest run
```
Expected: all pass.

- [ ] **Step 4: Run typecheck**

```bash
pnpm tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 5: Final commit (only if needed)**

If any css class needed adding to `app/styles.css` or component-level styles weren't included earlier, commit them now:

```bash
git add app/styles.css
git commit -m "feat(ui): styles for clients pages"
```

If no further changes, skip this commit.

---

## Notes for the implementer

- The `query` helper from `@/lib/db` returns `{ rows }`. PG numeric counts come back as strings — always `Number(...)` them in repository code.
- The `authedJsonFetch` helper expects `{ accessToken, path, init? }` and returns `{ data, token }`. New tokens may rotate — pages already accept this via `useState`.
- `PageLoadingState`, `OneShotButton`, and similar UI primitives live in `@/components/loading-shells` and `@/components/one-shot-button`. Reuse them rather than rolling your own.
- This codebase uses no shared status-badge component. Task 11 adds a small one scoped to the clients pages. If a global one is later introduced, swap them in.
- The edit dialog is intentionally a focused new form. Extracting the larger settings form is out of scope for v1 (see open implementation questions in the spec).
- No schema migrations. Do not modify `supabase/migrations/`.
- The spec lives at `docs/superpowers/specs/2026-05-13-clients-pages-design.md` — read it for permissions, edge cases, and the design decisions behind each task.
