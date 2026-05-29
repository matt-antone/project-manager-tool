/**
 * Audit (and optionally fix) import_map_prod_users rows whose local_id is a
 * BC2 import token like "bc2_13958904" instead of a real test user_profiles.id.
 *
 * For each such row:
 *   1. Look up prod user_profiles by id → get email
 *   2. Look up test user_profiles by lower(email)
 *   3. If found → propose update map.local_id to real test id
 *
 * Read-only by default. Pass --apply to write the updates.
 */
import { config } from "dotenv";
import { resolve } from "path";
import { Pool } from "pg";
import { promises as fs } from "node:fs";
import * as path from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

interface MapRow {
  prod_id: string;
  local_id: string;
}

interface ProdUser {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

interface TestUser {
  id: string;
  email: string;
}

interface Plan {
  prod_id: string;
  bc2_token: string;
  prod_email: string;
  prod_name: string;
  new_local_id: string;
  test_email: string;
}

interface Unfixable {
  prod_id: string;
  bc2_token: string;
  reason: string;
  prod_email?: string | null;
  prod_name?: string | null;
}

async function main() {
  const apply = process.argv.includes("--apply");

  const prod = new Pool({ connectionString: process.env.PROD_DATABASE_URL });
  const test = new Pool({ connectionString: process.env.DATABASE_URL });

  const mapRes = await test.query<MapRow>(
    "select prod_id, local_id from import_map_prod_users where local_id like 'bc2_%'"
  );
  console.log(`[audit] map rows with bc2_ token: ${mapRes.rows.length}`);

  const plans: Plan[] = [];
  const unfixable: Unfixable[] = [];

  for (const m of mapRes.rows) {
    const pu = await prod.query<ProdUser>(
      "select id, email, first_name, last_name from user_profiles where id = $1",
      [m.prod_id]
    );
    if (pu.rows.length === 0) {
      unfixable.push({ prod_id: m.prod_id, bc2_token: m.local_id, reason: "no prod user_profiles row" });
      continue;
    }
    const u = pu.rows[0];
    const fullName = [u.first_name, u.last_name].filter(Boolean).join(" ");
    if (!u.email) {
      unfixable.push({
        prod_id: m.prod_id,
        bc2_token: m.local_id,
        reason: "prod user has no email",
        prod_name: fullName,
      });
      continue;
    }
    const tu = await test.query<TestUser>(
      "select id, email from user_profiles where lower(email) = lower($1) and id not like 'bc2_%' limit 1",
      [u.email]
    );
    if (tu.rows.length === 0) {
      unfixable.push({
        prod_id: m.prod_id,
        bc2_token: m.local_id,
        reason: "no test user_profiles row with matching email",
        prod_email: u.email,
        prod_name: fullName,
      });
      continue;
    }
    plans.push({
      prod_id: m.prod_id,
      bc2_token: m.local_id,
      prod_email: u.email,
      prod_name: fullName,
      new_local_id: tu.rows[0].id,
      test_email: tu.rows[0].email,
    });
  }

  console.log(`[audit] fixable: ${plans.length}`);
  console.log(`[audit] unfixable: ${unfixable.length}`);

  const outDir = "tmp/bc2-user-map-audit";
  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `audit-${stamp}.json`);
  await fs.writeFile(outPath, JSON.stringify({ plans, unfixable }, null, 2));
  console.log(`[audit] wrote ${outPath}`);

  if (plans.length > 0) {
    console.log("\nSample plans (first 10):");
    for (const p of plans.slice(0, 10)) {
      console.log(
        `  ${p.bc2_token}  ->  ${p.new_local_id}   (${p.prod_email} / ${p.prod_name})`
      );
    }
  }
  if (unfixable.length > 0) {
    console.log("\nSample unfixable (first 10):");
    for (const u of unfixable.slice(0, 10)) {
      console.log(`  ${u.bc2_token}  prod_id=${u.prod_id}  reason=${u.reason}  email=${u.prod_email ?? "-"}`);
    }
  }

  if (!apply) {
    console.log("\n[audit] read-only run. Pass --apply to write updates.");
    await prod.end();
    await test.end();
    return;
  }

  // Apply: update map rows. Wrap in single txn for atomicity.
  console.log(`\n[apply] updating ${plans.length} map rows...`);
  await test.query("begin");
  try {
    let updated = 0;
    for (const p of plans) {
      const r = await test.query(
        "update import_map_prod_users set local_id = $2 where prod_id = $1 and local_id = $3",
        [p.prod_id, p.new_local_id, p.bc2_token]
      );
      updated += r.rowCount ?? 0;
    }
    await test.query("commit");
    console.log(`[apply] updated ${updated} map rows`);
  } catch (e) {
    await test.query("rollback").catch(() => {});
    console.error("[apply] rollback:", (e as Error).message);
    process.exit(1);
  }

  await prod.end();
  await test.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
