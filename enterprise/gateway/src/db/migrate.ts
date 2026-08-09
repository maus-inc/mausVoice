import fs from "fs";
import path from "path";
import pg from "pg";
import { getPool } from "../utils/db.utils";

const MIGRATIONS_DIR = path.join(__dirname, "db", "migrations");

const LEGACY_DB_NAME = "voquill";
const CURRENT_DB_NAME = "mausvoice";

/**
 * Idempotent pre-migration bootstrap for existing deployments.
 *
 * Postgres only honors POSTGRES_DB when the data directory is empty. An
 * existing volume keeps whatever database it was initialized with — the
 * pre-rebrand name "voquill". If that volume upgrades, the gateway's
 * DATABASE_URL points at "mausvoice", which does not exist, and every
 * connection (including migrations) fails before any SQL can run.
 *
 * Connect to the postgres maintenance database and:
 *  - if "mausvoice" already exists: nothing to do;
 *  - else if legacy "voquill" exists: rename it to "mausvoice" (preserves data);
 *  - else: create "mausvoice".
 */
export async function ensureDatabase(): Promise<void> {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error("DATABASE_URL is not set");
  }
  const url = new URL(raw);
  const maintenanceUrl = new URL(url.toString());
  maintenanceUrl.pathname = "/postgres";

  const client = new pg.Client({ connectionString: maintenanceUrl.toString() });
  try {
    await client.connect();
    const has = async (name: string): Promise<boolean> => {
      const result = await client.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        [name],
      );
      return (result.rowCount ?? 0) > 0;
    };

    if (await has(CURRENT_DB_NAME)) {
      console.log(`Database "${CURRENT_DB_NAME}" already exists; nothing to migrate`);
      return;
    }

    if (await has(LEGACY_DB_NAME)) {
      console.log(
        `Renaming legacy database "${LEGACY_DB_NAME}" to "${CURRENT_DB_NAME}"`,
      );
      await client.query(
        `ALTER DATABASE "${LEGACY_DB_NAME}" RENAME TO "${CURRENT_DB_NAME}"`,
      );
      return;
    }

    console.log(`Creating database "${CURRENT_DB_NAME}"`);
    await client.query(`CREATE DATABASE "${CURRENT_DB_NAME}"`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function ensureMigrationsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const pool = getPool();
  const result = await pool.query("SELECT name FROM _migrations ORDER BY name");
  return new Set(result.rows.map((row) => row.name));
}

async function getMigrationFiles(): Promise<string[]> {
  const files = fs.readdirSync(MIGRATIONS_DIR);
  return files
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
}

async function applyMigration(filename: string): Promise<void> {
  const pool = getPool();
  const filepath = path.join(MIGRATIONS_DIR, filename);
  const sql = fs.readFileSync(filepath, "utf-8");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO _migrations (name) VALUES ($1)", [
      filename,
    ]);
    await client.query("COMMIT");
    console.log(`Applied migration: ${filename}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function runMigrations(): Promise<void> {
  console.log("Running database migrations...");

  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const files = await getMigrationFiles();

  let migrationsRun = 0;
  for (const file of files) {
    if (!applied.has(file)) {
      await applyMigration(file);
      migrationsRun++;
    }
  }

  if (migrationsRun === 0) {
    console.log("No new migrations to apply");
  } else {
    console.log(`Applied ${migrationsRun} migration(s)`);
  }
}
