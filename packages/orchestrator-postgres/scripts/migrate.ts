import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root
config({ path: join(__dirname, '../../../.env') });

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('❌ DATABASE_URL is not set. Aborting migration.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  connectionTimeoutMillis: 10_000,
});

const db = drizzle(pool);

// Migration lock ID (arbitrary number, must be consistent)
const MIGRATION_LOCK_ID = 123456789;

// Safety net: abort if the entire migration takes longer than 60s
const TIMEOUT_MS = 60_000;
const timeout = setTimeout(() => {
  console.error('❌ Migration timed out after 60s — aborting.');
  process.exit(1);
}, TIMEOUT_MS);

async function main() {
  console.log('🔄 Running migrations...');

  try {
    // Acquire advisory lock to prevent concurrent migrations
    console.log('🔒 Acquiring migration lock...');
    const lockResult = await pool.query('SELECT pg_try_advisory_lock($1) as acquired', [MIGRATION_LOCK_ID]);

    if (!lockResult.rows[0].acquired) {
      console.error('❌ Another migration is already running. Exiting.');
      process.exit(1);
    }

    console.log('✅ Migration lock acquired');

    // Run migrations
    await migrate(db, { migrationsFolder: join(__dirname, '../drizzle') });

    console.log('✅ Migrations completed!');
  } catch (error) {
    console.error('❌ Migration failed!');
    throw error;
  } finally {
    // Always release the lock
    await pool.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    console.log('🔓 Migration lock released');
    await pool.end();
    clearTimeout(timeout);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
