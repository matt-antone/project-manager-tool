// lib/imports/sync-prod-to-test/clients-resolver.ts
import type { PoolClient } from "pg";

export async function ensureClientInTest(
  testTx: PoolClient,
  code: string | null,
  name: string | null,
): Promise<string> {
  if (!code) throw new Error(`Cannot ensure client without a code`);
  const existing = await testTx.query(`SELECT id FROM clients WHERE code = $1 LIMIT 1`, [code]);
  if (existing.rows[0]) return existing.rows[0].id as string;
  const ins = await testTx.query(
    `INSERT INTO clients (code, name) VALUES ($1, $2) RETURNING id`,
    [code, name ?? code],
  );
  return ins.rows[0].id as string;
}
