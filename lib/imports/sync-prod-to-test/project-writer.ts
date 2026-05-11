// lib/imports/sync-prod-to-test/project-writer.ts
import type { Pool, PoolClient } from "pg";
import type { ProdProjectRow } from "./types";
import { findTestProjectMatch, normalizeCode } from "./identity";

export type ProjectUpsertAction =
  | "create_in_test"
  | "append_to_existing"
  | "create_and_archive_padded_twin";

export interface UpsertProjectResult {
  test_project_id: string;
  action: ProjectUpsertAction;
  archived_padded_twin_id: string | null;
}

// Treat a PoolClient as a Pool-like for the `.query` calls inside identity helpers.
function asPoolLike(c: PoolClient): Pool {
  return { query: (sql: string, params?: unknown[]) => c.query(sql, params as never) } as unknown as Pool;
}

async function fetchProdBasecampIdsForProject(prod: Pool, prodProjectId: string): Promise<string[]> {
  const r = await prod.query(
    `SELECT basecamp_project_id FROM import_map_projects WHERE local_project_id = $1`,
    [prodProjectId],
  );
  return r.rows.map((row: { basecamp_project_id: string }) => row.basecamp_project_id);
}

export async function upsertProjectInTest(
  testTx: PoolClient,
  prod: ProdProjectRow,
  prodPool: Pool,
): Promise<UpsertProjectResult> {
  const bcIds = await fetchProdBasecampIdsForProject(prodPool, prod.id);

  const match = await findTestProjectMatch(
    asPoolLike(testTx),
    bcIds,
    prod.project_code,
    prod.client_slug,
    prod.project_slug,
    prod.name,
  );

  if (match) {
    return {
      test_project_id: match.test_project_id,
      action: match.match_kind === "padded_code" ? "create_and_archive_padded_twin" : "append_to_existing",
      archived_padded_twin_id: match.match_kind === "padded_code" ? match.test_project_id : null,
    };
  }

  // Resolve test client by code (caller must have ensured it exists).
  const clientLookup = await testTx.query(
    `SELECT id FROM clients WHERE code = $1 LIMIT 1`,
    [prod.client_code],
  );
  if (!clientLookup.rows[0]) {
    throw new Error(`No test client with code='${prod.client_code}' — call ensureClientInTest first`);
  }
  const clientId = clientLookup.rows[0].id;

  const slug =
    prod.slug ??
    `${prod.client_slug ?? ""}-${prod.project_slug ?? ""}-${prod.id.slice(0, 8)}`;

  if (!prod.created_by) {
    throw new Error(`prod.created_by is null for project_code=${prod.project_code ?? prod.id} — cannot insert`);
  }

  const insert = await testTx.query(
    `INSERT INTO projects
      (project_code, client_slug, project_slug, slug, name, archived, status,
       client_id, created_by, created_at, updated_at, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      prod.project_code, prod.client_slug, prod.project_slug, slug, prod.name,
      prod.archived, prod.status, clientId, prod.created_by,
      prod.created_at, prod.updated_at, prod.last_activity_at,
    ],
  );
  const newId: string = insert.rows[0].id;

  // Mirror prod's basecamp_project_id mappings onto the new test row.
  if (bcIds.length > 0) {
    await testTx.query(
      `INSERT INTO import_map_projects (basecamp_project_id, local_project_id)
       SELECT unnest($1::text[]), $2
       ON CONFLICT (basecamp_project_id) DO NOTHING`,
      [bcIds, newId],
    );
  }

  // Archive any padded-code twin in test (different code that normalizes to the same canonical).
  const norm = normalizeCode(prod.project_code);
  if (norm) {
    const twin = await testTx.query(
      `SELECT id FROM projects
        WHERE project_code <> $1
          AND project_code IS NOT NULL
          AND REGEXP_REPLACE(project_code, '^([A-Z]+)-0*(\\d+)$', '\\1-\\2') = $2
          AND id <> $3
        LIMIT 1`,
      [prod.project_code, norm, newId],
    );
    if (twin.rows[0]) {
      await testTx.query(`UPDATE projects SET archived = true WHERE id = $1`, [twin.rows[0].id]);
      return {
        test_project_id: newId,
        action: "create_and_archive_padded_twin",
        archived_padded_twin_id: twin.rows[0].id,
      };
    }
  }
  return { test_project_id: newId, action: "create_in_test", archived_padded_twin_id: null };
}
