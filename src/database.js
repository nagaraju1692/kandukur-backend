import pg from 'pg'

const { Pool } = pg
let pool
let schemaPromise
const retryableCodes = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', '57P01', '57P02', '57P03'])

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function getPool() {
  if (!process.env.DATABASE_URL) throw new Error('Missing required environment variable: DATABASE_URL')
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX || 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
      keepAlive: true,
    })
    pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error:', error.message))
  }
  return pool
}

export async function query(text, values = []) {
  const retries = Number(process.env.DB_QUERY_RETRIES || 3)
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await getPool().query(text, values)
    } catch (error) {
      if (!retryableCodes.has(error.code) || attempt === retries) throw error
      await delay(250 * 2 ** attempt)
    }
  }
}

export function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = query(`
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT REFERENCES categories(id)
      );
      CREATE TABLE IF NOT EXISTS businesses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category_id TEXT NOT NULL,
        category_name TEXT NOT NULL,
        address TEXT NOT NULL,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        phone TEXT,
        website TEXT,
        description TEXT,
        image TEXT,
        gallery JSONB NOT NULL DEFAULT '[]'::jsonb,
        status TEXT,
        submitted_by TEXT
      );
      CREATE TABLE IF NOT EXISTS announcements (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        description TEXT NOT NULL,
        type TEXT NOT NULL,
        image TEXT,
        start_date TIMESTAMPTZ,
        end_date TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS users (
        phone TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'super_admin')),
        is_super_admin BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS favorites (
        user_phone TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
        business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        created_by TEXT NOT NULL REFERENCES users(phone),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT NOT NULL REFERENCES users(phone),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_phone, business_id)
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        user_phone TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
        rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL REFERENCES users(phone),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT NOT NULL REFERENCES users(phone),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS feedback_submissions (
        id TEXT PRIMARY KEY,
        user_phone TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('Feedback', 'Complaint')),
        subject TEXT NOT NULL,
        contact TEXT,
        message TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(phone),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT NOT NULL REFERENCES users(phone),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS app_usage (
        id TEXT PRIMARY KEY,
        user_phone TEXT REFERENCES users(phone) ON DELETE SET NULL,
        user_name TEXT,
        device_id TEXT NOT NULL,
        app_version TEXT,
        platform TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      WITH ranked_usage AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY device_id
                 ORDER BY visited_at DESC, created_at DESC, id DESC
               ) AS row_num
        FROM app_usage
      )
      DELETE FROM app_usage
      WHERE id IN (
        SELECT id FROM ranked_usage WHERE row_num > 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS app_usage_device_id_unique
        ON app_usage(device_id);
      ALTER TABLE app_usage ADD COLUMN IF NOT EXISTS user_name TEXT;
      ALTER TABLE app_usage ADD COLUMN IF NOT EXISTS app_version TEXT;
      ALTER TABLE app_usage ADD COLUMN IF NOT EXISTS platform TEXT;
      ALTER TABLE app_usage ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_by TEXT;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS updated_by TEXT;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      DO $$
      DECLARE
        role_constraint_name TEXT;
      BEGIN
        SELECT c.conname
        INTO role_constraint_name
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = 'users'
          AND n.nspname = 'public'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) ILIKE '%role%'
          AND pg_get_constraintdef(c.oid) ILIKE '%super_admin%'
        LIMIT 1;

        IF role_constraint_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT %I', role_constraint_name);
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE t.relname = 'users'
            AND n.nspname = 'public'
            AND c.conname = 'users_role_check'
        ) THEN
          ALTER TABLE public.users
            ADD CONSTRAINT users_role_check
            CHECK (role IN ('user', 'admin', 'super_admin'));
        END IF;
      END $$;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS created_by TEXT;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS updated_by TEXT;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
      ALTER TABLE announcements ADD COLUMN IF NOT EXISTS created_by TEXT;
      ALTER TABLE announcements ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE announcements ADD COLUMN IF NOT EXISTS updated_by TEXT;
      ALTER TABLE announcements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE announcements ADD COLUMN IF NOT EXISTS start_date TIMESTAMPTZ;
      ALTER TABLE announcements ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ;
      ALTER TABLE announcements ALTER COLUMN image DROP NOT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_by TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `).catch((error) => {
      schemaPromise = undefined
      throw error
    })
  }
  return schemaPromise
}