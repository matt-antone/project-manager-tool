import { config } from "dotenv";
import { resolve } from "path";
import { Pool } from "pg";

config({ path: resolve(process.cwd(), ".env.local") });

const CODE = "BRGS-0079";

async function main() {
  const prod = new Pool({ connectionString: process.env.PROD_DATABASE_URL });
  const test = new Pool({ connectionString: process.env.DATABASE_URL });

  const normalize = String.raw`regexp_replace(lower(project_code), '^([a-z]+)-0*([0-9]+[a-z]?)$', '\1-\2')`;

  const prodP = await prod.query<{ id: string; project_code: string; name: string }>(
    `select id, project_code, name from projects where name ilike '%Yavrouian%' or project_code ilike 'BRGS-007%' order by project_code`
  );
  console.log("PROD projects matching", CODE, prodP.rows);

  for (const row of prodP.rows) {
    const ph = await prod.query(
      `select user_id, hours, created_at from project_user_hours where project_id = $1`,
      [row.id]
    );
    console.log(`PROD hours for prod_id=${row.id}:`, ph.rows);
  }

  const testP = await test.query<{ id: string; project_code: string; name: string }>(
    `select id, project_code, name from projects where name ilike '%Yavrouian%' or project_code ilike 'BRGS-007%' order by project_code`
  );
  console.log("TEST projects matching", CODE, testP.rows);

  for (const row of testP.rows) {
    const th = await test.query(
      `select user_id, hours, created_at from project_user_hours where project_id = $1`,
      [row.id]
    );
    console.log(`TEST hours for local_id=${row.id}:`, th.rows);

    const map = await test.query(
      `select prod_id, local_id, matched_existing from import_map_prod_projects where local_id = $1`,
      [row.id]
    );
    console.log(`TEST map row for local_id=${row.id}:`, map.rows);
  }

  await prod.end();
  await test.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
