/**
 * Apply Prisma migrations to the local development database.
 *
 * `prisma migrate deploy` needs the native schema engine binary, which is not
 * downloadable in offline/sandboxed environments. This applies the exact same
 * SQL files that Prisma would, over the Postgres wire protocol, and records
 * them so re-runs are no-ops.
 *
 * Usage: npm run dev:db:migrate
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import 'dotenv/config';

const TRACKING_TABLE = '_dev_applied_migrations';

function resolveConnectionString() {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL (or DIRECT_URL) must be set in .env');
  }
  return url;
}

function loadMigrations() {
  const migrationsDir = path.resolve(process.cwd(), 'prisma', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`No migrations directory found at ${migrationsDir}`);
  }

  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      sqlPath: path.join(migrationsDir, entry.name, 'migration.sql'),
    }))
    .filter((migration) => fs.existsSync(migration.sqlPath))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  const client = new pg.Client({ connectionString: resolveConnectionString() });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${TRACKING_TABLE}" (
        "name" TEXT PRIMARY KEY,
        "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const { rows } = await client.query(`SELECT "name" FROM "${TRACKING_TABLE}"`);
    const applied = new Set(rows.map((row) => row.name));
    const migrations = loadMigrations();

    if (migrations.length === 0) {
      console.log('[dev:db:migrate] no migrations found');
      return;
    }

    let appliedCount = 0;
    for (const migration of migrations) {
      if (applied.has(migration.name)) {
        console.log(`[dev:db:migrate] skip ${migration.name} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(migration.sqlPath, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO "${TRACKING_TABLE}" ("name") VALUES ($1)`, [
          migration.name,
        ]);
        await client.query('COMMIT');
        appliedCount += 1;
        console.log(`[dev:db:migrate] applied ${migration.name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.name} failed: ${error.message}`);
      }
    }

    console.log(
      appliedCount === 0
        ? '[dev:db:migrate] database already up to date'
        : `[dev:db:migrate] applied ${appliedCount} migration(s)`
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('[dev:db:migrate] failed:', error.message);
  process.exit(1);
});
