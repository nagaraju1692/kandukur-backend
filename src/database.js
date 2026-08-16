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
        name_te TEXT,
        category_id TEXT NOT NULL,
        category_name TEXT NOT NULL,
        address TEXT NOT NULL,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        phone TEXT,
        website TEXT,
        description TEXT,
        owner_name TEXT,
        rooms TEXT,
        price TEXT,
        facing TEXT,
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
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS name_te TEXT;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS owner_name TEXT;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS rooms TEXT;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS price TEXT;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS facing TEXT;
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
    `).then(async () => {
      const { rows } = await query(`
        SELECT id FROM categories WHERE name = 'Real Estate' AND parent_id IS NULL LIMIT 1
      `)
      if (!rows[0]) return
      const realEstateId = rows[0].id

      await query(`
        INSERT INTO categories (id, name, parent_id)
        VALUES
          ('plot-for-sale', 'Plot for Sale', $1),
          ('house-apartment-for-sale', 'House or Apartment for Sale', $1),
          ('land-for-sale', 'Land for Sale', $1)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id
      `, [realEstateId])
      await query(`
        UPDATE businesses
        SET category_id = 'plot-for-sale', category_name = 'Plot for Sale', updated_at = NOW()
        WHERE category_name IN ('Plots for Sale', 'Property Agents', 'Properties for Sale')
           OR category_id IN (SELECT id FROM categories WHERE name IN ('Plots for Sale', 'Property Agents', 'Properties for Sale'))
      `)
      await query(`
        DELETE FROM categories
        WHERE name IN ('Plots for Sale', 'Property Agents', 'Properties for Sale')
          AND id NOT IN ('plot-for-sale', 'house-apartment-for-sale', 'land-for-sale')
      `)

      const { rows: foodCategoryRows } = await query(`
        SELECT id FROM categories WHERE name = 'Food & Meat Markets' AND parent_id IS NULL LIMIT 1
      `)
      if (foodCategoryRows[0]) {
        await query(`
          UPDATE categories
          SET parent_id = $1
          WHERE name IN ('Fish Markets', 'Fruit Markets', 'Vegetable Markets')
        `, [foodCategoryRows[0].id])
      }

      const { rows: agricultureCategoryRows } = await query(`
        SELECT id FROM categories WHERE name = 'Agriculture' AND parent_id IS NULL LIMIT 1
      `)
      if (agricultureCategoryRows[0]) {
        await query(`
          UPDATE categories
          SET parent_id = $1
          WHERE name = 'Tobacco Boards'
        `, [agricultureCategoryRows[0].id])
      }

      await query(`
        UPDATE businesses
        SET image = CASE id
          WHEN 'ext11' THEN 'https://images.unsplash.com/photo-1601598851547-4302969d0614?auto=format&fit=crop&w=1200&q=80'
          WHEN 'retail1' THEN 'https://images.unsplash.com/photo-1604719312566-8912e9227c6a?auto=format&fit=crop&w=1200&q=80'
          WHEN 'retail2' THEN 'https://images.unsplash.com/photo-1578916171728-46686eac8d58?auto=format&fit=crop&w=1200&q=80'
          WHEN 'retail3' THEN 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=1200&q=80'
          WHEN 'retail4' THEN 'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?auto=format&fit=crop&w=1200&q=80'
          ELSE image
        END,
        updated_at = NOW()
        WHERE id IN ('ext11', 'retail1', 'retail2', 'retail3', 'retail4')
          AND image = 'https://images.unsplash.com/photo-1542831371-d531d36971e6?auto=format&fit=crop&w=1200&q=80'
      `)

      await query(`
        UPDATE businesses
        SET name = CASE id
              WHEN 'beauty1' THEN 'Veena''s Beauty Salon'
              WHEN 'beauty2' THEN 'Chaitanya Skin & Beauty Clinic'
              WHEN 'beauty3' THEN 'Style & Smile Beauty Salon'
              WHEN 'beauty4' THEN 'QBS Unisex Salon'
              WHEN 'beauty5' THEN 'Charmi Beauty Salon'
              WHEN 'beauty6' THEN 'Old Fish Market Beauty Salon'
              ELSE name
            END,
            image = CASE id
              WHEN 'beauty1' THEN 'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=1200&q=80'
              WHEN 'beauty2' THEN 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=1200&q=80'
              WHEN 'beauty3' THEN 'https://images.unsplash.com/photo-1512496015851-a90fb38ba796?auto=format&fit=crop&w=1200&q=80'
              WHEN 'beauty4' THEN 'https://images.unsplash.com/photo-1487412912498-0447578fcca8?auto=format&fit=crop&w=1200&q=80'
              WHEN 'beauty5' THEN 'https://images.unsplash.com/photo-1605497788044-5a32c7078486?auto=format&fit=crop&w=1200&q=80'
              WHEN 'beauty6' THEN 'https://images.unsplash.com/photo-1562322140-8baeececf3df?auto=format&fit=crop&w=1200&q=80'
              ELSE image
            END,
            updated_at = NOW()
        WHERE id IN ('beauty1', 'beauty2', 'beauty3', 'beauty4', 'beauty5', 'beauty6')
          AND image = 'https://images.unsplash.com/photo-1501004318641-b39e6451bec6?auto=format&fit=crop&w=1200&q=80'
      `)

      await query(`
        UPDATE businesses
        SET name = CASE id
              WHEN 'wine2' THEN 'Gayathri Wine Shop'
              WHEN 'wine3' THEN 'Sri Mallikarjuna Wines'
              WHEN 'wine4' THEN 'Surya Bar & Restaurant'
              ELSE name
            END,
            image = CASE id
              WHEN 'ext12' THEN 'https://images.unsplash.com/photo-1510812431401-41d2bd2722f3?auto=format&fit=crop&w=1200&q=80'
              WHEN 'wine1' THEN 'https://images.unsplash.com/photo-1473973266408-ed4e27abdd47?auto=format&fit=crop&w=1200&q=80'
              WHEN 'wine2' THEN 'https://images.unsplash.com/photo-1506377247377-2a5b3b5a9b0b?auto=format&fit=crop&w=1200&q=80'
              WHEN 'wine3' THEN 'https://images.unsplash.com/photo-1515003197210-e0cd71810b5f?auto=format&fit=crop&w=1200&q=80'
              WHEN 'wine4' THEN 'https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?auto=format&fit=crop&w=1200&q=80'
              ELSE image
            END,
            updated_at = NOW()
        WHERE id IN ('ext12', 'wine1', 'wine2', 'wine3', 'wine4')
          AND image = 'https://images.unsplash.com/photo-1547592166-4b6f2b7c0d8b?auto=format&fit=crop&w=1200&q=80'
      `)

          await query(`
          UPDATE businesses
          SET image = 'https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?auto=format&fit=crop&w=1200&q=80',
            updated_at = NOW()
          WHERE id = 'h3'
            AND image = 'https://images.unsplash.com/photo-1538108149393-fbbd81895973?auto=format&fit=crop&w=1200&q=80'
          `)

        await query(`
          UPDATE businesses
          SET name_te = CASE id
            WHEN 'h5' THEN 'ప్రణవి చిల్డ్రన్స్ హాస్పిటల్ అండ్ ఐ కేర్'
            WHEN 'r1' THEN 'సాయి సాగర్ గ్రాండ్ ఫ్యామిలీ డైనింగ్'
            ELSE name_te
          END,
          updated_at = NOW()
          WHERE id IN ('h5', 'r1') AND name_te IS NULL
        `)

        await query(`
          UPDATE businesses
          SET name_te = CASE name
            WHEN 'Woodland Premium Family Kitchen' THEN 'వుడ్‌ల్యాండ్ ప్రీమియం ఫ్యామిలీ కిచెన్'
            WHEN 'MedPlus Ramalayam Street' THEN 'మెడ్‌ప్లస్ రామాలయం స్ట్రీట్'
            ELSE name_te
          END,
          updated_at = NOW()
          WHERE name IN ('Woodland Premium Family Kitchen', 'MedPlus Ramalayam Street')
            AND name_te IS NULL
        `)

      await query(`
        WITH duplicate_categories AS (
          SELECT id,
                 FIRST_VALUE(id) OVER (PARTITION BY name ORDER BY id) AS retained_id,
                 ROW_NUMBER() OVER (PARTITION BY name ORDER BY id) AS row_number
          FROM categories
          WHERE name IN ('Fish Markets', 'Fruit Markets', 'Vegetable Markets')
        )
        UPDATE businesses
        SET category_id = duplicate_categories.retained_id,
            updated_at = NOW()
        FROM duplicate_categories
        WHERE businesses.category_id = duplicate_categories.id
          AND duplicate_categories.row_number > 1
      `)
      await query(`
        WITH duplicate_categories AS (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY name ORDER BY id) AS row_number
          FROM categories
          WHERE name IN ('Fish Markets', 'Fruit Markets', 'Vegetable Markets')
        )
        DELETE FROM categories
        WHERE id IN (SELECT id FROM duplicate_categories WHERE row_number > 1)
      `)

      await query(`
        INSERT INTO categories (id, name, parent_id)
        VALUES ('common-utilities', 'Common Utilities', NULL)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id
      `)

      await query(`
        INSERT INTO categories (id, name, parent_id)
        VALUES ('buy-and-sell', 'Buy & Sell', NULL)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id
      `)
      await query(`
        INSERT INTO categories (id, name, parent_id)
        VALUES
          ('cars-for-sale', 'Cars for Sale', 'buy-and-sell'),
          ('bikes-for-sale', 'Bikes for Sale', 'buy-and-sell'),
          ('tractors-for-sale', 'Tractors for Sale', 'buy-and-sell'),
          ('other-items-for-sale', 'Other Items for Sale', 'buy-and-sell')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id
      `)
      await query(`
        INSERT INTO categories (id, name, parent_id)
        VALUES
          ('atm-centers', 'ATM Centers', 'common-utilities'),
          ('petrol-pumps', 'Petrol Pumps', 'common-utilities'),
          ('gas-centers', 'Gas Centers', 'common-utilities'),
          ('ev-charging-stations', 'EV Charging Stations', 'common-utilities'),
          ('public-toilets', 'Public Toilets', 'common-utilities')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id
      `)
    }).catch((error) => {
      schemaPromise = undefined
      throw error
    })
  }
  return schemaPromise
}