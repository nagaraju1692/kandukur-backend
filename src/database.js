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
      CREATE TABLE IF NOT EXISTS bus_routes (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL DEFAULT 'Kandukur Bus Stand',
        destination TEXT NOT NULL,
        destination_te TEXT,
        destination_type TEXT NOT NULL CHECK (destination_type IN ('Village', 'City')),
        service_type TEXT NOT NULL,
        departure_time TIME NOT NULL,
        days TEXT NOT NULL DEFAULT 'Daily',
        notes TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS mandal_villages (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        distance_km INTEGER,
        pincode TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      ALTER TABLE feedback_submissions ADD COLUMN IF NOT EXISTS admin_reply TEXT;
      ALTER TABLE feedback_submissions ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;
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
      ALTER TABLE app_usage ADD COLUMN IF NOT EXISTS device_name TEXT;
      ALTER TABLE app_usage ADD COLUMN IF NOT EXISTS location TEXT;
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
      ALTER TABLE bus_routes ADD COLUMN IF NOT EXISTS destination_te TEXT;
      ALTER TABLE bus_routes ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE bus_routes ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
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
      await query(`
        INSERT INTO bus_routes (id, destination, destination_te, destination_type, service_type, departure_time, days, notes)
        VALUES
          ('sample-kanigiri-1', 'Kanigiri', 'కనిగిరి', 'City', 'APSRTC', '06:00'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand'),
          ('sample-ongole-1', 'Ongole', 'ఒంగోలు', 'City', 'Express', '07:15'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand'),
          ('sample-pamur-1', 'Pamur', 'పామూరు', 'Village', 'APSRTC', '08:30'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand'),
          ('sample-darsi-1', 'Darsi', 'దర్శి', 'Village', 'Non-AC', '10:00'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand'),
          ('sample-markapur-1', 'Markapur', 'మార్కాపూర్', 'City', 'Express', '13:30'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand'),
          ('sample-nellore-1', 'Nellore', 'నెల్లూరు', 'City', 'APSRTC', '16:45'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand'),
          ('sample-podili-1', 'Podili', 'పొదిలి', 'Village', 'Non-AC', '18:15'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand'),
          ('sample-ongole-2', 'Ongole', 'ఒంగోలు', 'City', 'APSRTC', '11:30'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand'),
          ('sample-guntur-1', 'Guntur', 'గుంటూరు', 'City', 'Express', '05:45'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand'),
          ('sample-vijayawada-1', 'Vijayawada', 'విజయవాడ', 'City', 'Express', '06:30'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand'),
          ('sample-kavali-1', 'Kavali', 'కావలి', 'City', 'APSRTC', '14:15'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand'),
          ('sample-lingasamudram-1', 'Lingasamudram', 'లింగసముద్రం', 'Village', 'Non-AC', '07:45'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand'),
          ('sample-ullapalem-1', 'Ullapalem', 'ఉల్లపాలెం', 'Village', 'Non-AC', '09:15'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand'),
          ('sample-vvpalem-1', 'V. V. Palem', 'వి.వి. పాలెం', 'Village', 'APSRTC', '17:30'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-anandapuram-1', 'Anandapuram', 'ఆనందపురం', 'Village', 'Non-AC', '06:15'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-anantha-sagaram-1', 'Anantha Sagaram', 'అనంతసాగరం', 'Village', 'APSRTC', '06:45'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-donda-padu-1', 'Donda Padu', 'దొండపాడు', 'Village', 'Non-AC', '07:00'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-g-meka-padu-1', 'G. Meka Padu', 'జి. మేకపాడు', 'Village', 'APSRTC', '07:30'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-jillelamudi-1', 'Jillelamudi', 'జిల్లెలమూడి', 'Village', 'Non-AC', '08:00'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-kancharagunta-1', 'Kancharagunta', 'కంచరగుంట', 'Village', 'APSRTC', '08:15'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-kondamudusu-palem-1', 'Kondamudusu Palem', 'కొండముడుసు పాలెం', 'Village', 'Non-AC', '08:45'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-kondikandukur-1', 'Kondikandukur', 'కొండికందుకూరు', 'Village', 'APSRTC', '09:00'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-kovur-1', 'Kovur', 'కోవూరు', 'Village', 'Non-AC', '09:30'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-machavaram-1', 'Machavaram', 'మాచవరం', 'Village', 'APSRTC', '10:15'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-madanagopalapuram-1', 'Madanagopalapuram', 'మదనగోపాలపురం', 'Village', 'Non-AC', '10:45'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-mahadevapuram-1', 'Mahadevapuram', 'మహాదేవపురం', 'Village', 'APSRTC', '11:15'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-mopadu-1', 'Mopadu', 'మోపాడు', 'Village', 'Non-AC', '12:00'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-muppalakesaramvarikandrika-1', 'Muppalakesaramvarikandrika', 'ముప్పలకేసరంవారి కండ్రిక', 'Village', 'APSRTC', '12:30'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-ogur-1', 'Ogur', 'ఒగూరు', 'Village', 'APSRTC', '13:00'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-palukur-1', 'Palukur', 'పాలుకూరు', 'Village', 'Non-AC', '15:00'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-palur-1', 'Palur', 'పాలూరు', 'Village', 'APSRTC', '15:30'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
          , ('sample-pandalapadu-1', 'Pandalapadu', 'పండలపాడు', 'Village', 'Non-AC', '16:00'::TIME, 'Daily', 'Sample timing - verify at Kandukur Bus Stand')
        ON CONFLICT (id) DO NOTHING
      `)
      await query(`
        INSERT INTO mandal_villages (id, name, distance_km, pincode)
        VALUES
          ('anandapuram', 'Anandapuram', 4, '591539'),
          ('anantha-sagaram', 'Anantha Sagaram', NULL, '591534'),
          ('donda-padu', 'Donda Padu', NULL, '591544'),
          ('g-meka-padu', 'G. Meka Padu', NULL, '591526'),
          ('jillelamudi', 'Jillelamudi', NULL, '591529'),
          ('kancharagunta', 'Kancharagunta', 4, '591537'),
          ('kondamudusu-palem', 'Kondamudusu Palem', 2, '591538'),
          ('kondikandukur', 'Kondikandukur', 5, '591532'),
          ('kovur', 'Kovur', 6, '591533'),
          ('machavaram', 'Machavaram', NULL, '591541'),
          ('madanagopalapuram', 'Madanagopalapuram', NULL, '591542'),
          ('mahadevapuram', 'Mahadevapuram', NULL, '591535'),
          ('mopadu', 'Mopadu', NULL, '591540'),
          ('muppalakesaramvarikandrika', 'Muppalakesaramvarikandrika', NULL, '591527'),
          ('ogur', 'Ogur', NULL, '591536'),
          ('palukur', 'Palukur', NULL, '591531'),
          ('palur', 'Palur', NULL, '591543'),
          ('pandalapadu', 'Pandalapadu', NULL, '591528'),
          ('vikkiralapeta', 'Vikkiralapeta', NULL, '591530')
        ON CONFLICT (name) DO UPDATE SET
          distance_km = EXCLUDED.distance_km,
          pincode = EXCLUDED.pincode,
          updated_at = NOW()
      `)
      await query(`
        INSERT INTO bus_routes (id, destination, destination_type, service_type, departure_time, days, notes)
        SELECT
          'sample-' || regexp_replace(lower(village.name), '[^a-z0-9]+', '-', 'g') || '-' || slot.sequence,
          village.name,
          'Village',
          slot.service_type,
          slot.departure_time,
          'Daily',
          'Sample timing - verify at Kandukur Bus Stand'
        FROM mandal_villages AS village
        CROSS JOIN (VALUES
          ('2', '11:00'::TIME, 'APSRTC'),
          ('3', '17:00'::TIME, 'Non-AC')
        ) AS slot(sequence, departure_time, service_type)
        ON CONFLICT (id) DO NOTHING
      `)
      await query(`
        INSERT INTO bus_routes (id, destination, destination_type, service_type, departure_time, days, notes)
        SELECT
          'sample-' || regexp_replace(lower(village.name), '[^a-z0-9]+', '-', 'g') || '-' || slot.sequence,
          village.name,
          'Village',
          slot.service_type,
          slot.departure_time,
          'Daily',
          'Sample timing - verify at Kandukur Bus Stand'
        FROM mandal_villages AS village
        CROSS JOIN (VALUES
          ('4', '05:30'::TIME, 'Non-AC'),
          ('5', '07:30'::TIME, 'APSRTC'),
          ('6', '09:30'::TIME, 'Non-AC'),
          ('7', '12:30'::TIME, 'APSRTC'),
          ('8', '14:30'::TIME, 'Non-AC'),
          ('9', '16:00'::TIME, 'APSRTC'),
          ('10', '19:00'::TIME, 'Non-AC')
        ) AS slot(sequence, departure_time, service_type)
        ON CONFLICT (id) DO NOTHING
      `)

      await query(`
        INSERT INTO categories (id, name, parent_id)
        VALUES
          ('emergency', 'Emergency', NULL),
          ('police-station', 'Police Station', 'emergency'),
          ('emergency-108', '108 Emergency', 'emergency'),
          ('fire-station', 'Fire Station', 'emergency')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id
      `)

      await query(`
        UPDATE businesses
        SET category_id = CASE
              WHEN category_name IN ('Police station', 'Police Station') OR category_id IN (SELECT id FROM categories WHERE name IN ('Police station', 'Police Station')) THEN 'police-station'
              WHEN category_name IN ('108', '108 Emergency', '108 Ambulance') OR category_id IN (SELECT id FROM categories WHERE name IN ('108', '108 Emergency', '108 Ambulance')) THEN 'emergency-108'
              WHEN category_name IN ('Fire station', 'Fire Station') OR category_id IN (SELECT id FROM categories WHERE name IN ('Fire station', 'Fire Station')) THEN 'fire-station'
              ELSE category_id
            END,
            category_name = CASE
              WHEN category_name IN ('Police station', 'Police Station') OR category_id IN (SELECT id FROM categories WHERE name IN ('Police station', 'Police Station')) THEN 'Police Station'
              WHEN category_name IN ('108', '108 Emergency', '108 Ambulance') OR category_id IN (SELECT id FROM categories WHERE name IN ('108', '108 Emergency', '108 Ambulance')) THEN '108 Emergency'
              WHEN category_name IN ('Fire station', 'Fire Station') OR category_id IN (SELECT id FROM categories WHERE name IN ('Fire station', 'Fire Station')) THEN 'Fire Station'
              ELSE category_name
            END,
            updated_at = NOW()
        WHERE category_name IN ('Police station', 'Police Station', '108', '108 Emergency', '108 Ambulance', 'Fire station', 'Fire Station')
           OR category_id IN (SELECT id FROM categories WHERE name IN ('Police station', 'Police Station', '108', '108 Emergency', '108 Ambulance', 'Fire station', 'Fire Station'))
      `)

      await query(`
        DELETE FROM categories
        WHERE name IN ('Police station', '108', '108 Ambulance', 'Fire station')
          AND id NOT IN ('police-station', 'emergency-108', 'fire-station')
      `)

      await query(`
        INSERT INTO categories (id, name, parent_id)
        VALUES
          ('health', 'Health', NULL),
          ('hospitals-clinics', 'Hospitals & Clinics', 'health'),
          ('medical-shops', 'Medical Shops', 'health'),
          ('diagnostic-lab-centers', 'Diagnostic Lab Centers', 'health'),
          ('radiology-scan-centers', 'Radiology Scan Centers', 'health')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id
      `)

      await query(`
        UPDATE businesses
        SET category_id = CASE
              WHEN category_name IN ('Hospitals', 'Hospitals & Clinics') OR category_id IN (SELECT id FROM categories WHERE name IN ('Hospitals', 'Hospitals & Clinics')) THEN 'hospitals-clinics'
              WHEN category_name IN ('Medical shops', 'Medical Shops') OR category_id IN (SELECT id FROM categories WHERE name IN ('Medical shops', 'Medical Shops')) THEN 'medical-shops'
              WHEN category_name IN ('Diagnostic Labs', 'Diagnostic Lab Centers', 'Diagnosis Labs') OR category_id IN (SELECT id FROM categories WHERE name IN ('Diagnostic Labs', 'Diagnostic Lab Centers', 'Diagnosis Labs')) THEN 'diagnostic-lab-centers'
              WHEN category_name IN ('Radiology Scans', 'Radiology Scan Centers', 'Scan Centers') OR category_id IN (SELECT id FROM categories WHERE name IN ('Radiology Scans', 'Radiology Scan Centers', 'Scan Centers')) THEN 'radiology-scan-centers'
              ELSE category_id
            END,
            category_name = CASE
              WHEN category_name IN ('Hospitals', 'Hospitals & Clinics') OR category_id IN (SELECT id FROM categories WHERE name IN ('Hospitals', 'Hospitals & Clinics')) THEN 'Hospitals & Clinics'
              WHEN category_name IN ('Medical shops', 'Medical Shops') OR category_id IN (SELECT id FROM categories WHERE name IN ('Medical shops', 'Medical Shops')) THEN 'Medical Shops'
              WHEN category_name IN ('Diagnostic Labs', 'Diagnostic Lab Centers', 'Diagnosis Labs') OR category_id IN (SELECT id FROM categories WHERE name IN ('Diagnostic Labs', 'Diagnostic Lab Centers', 'Diagnosis Labs')) THEN 'Diagnostic Lab Centers'
              WHEN category_name IN ('Radiology Scans', 'Radiology Scan Centers', 'Scan Centers') OR category_id IN (SELECT id FROM categories WHERE name IN ('Radiology Scans', 'Radiology Scan Centers', 'Scan Centers')) THEN 'Radiology Scan Centers'
              ELSE category_name
            END,
            updated_at = NOW()
        WHERE category_name IN ('Hospitals', 'Hospitals & Clinics', 'Medical shops', 'Medical Shops', 'Diagnostic Labs', 'Diagnostic Lab Centers', 'Diagnosis Labs', 'Radiology Scans', 'Radiology Scan Centers', 'Scan Centers')
           OR category_id IN (SELECT id FROM categories WHERE name IN ('Hospitals', 'Hospitals & Clinics', 'Medical shops', 'Medical Shops', 'Diagnostic Labs', 'Diagnostic Lab Centers', 'Diagnosis Labs', 'Radiology Scans', 'Radiology Scan Centers', 'Scan Centers'))
      `)

      await query(`
        UPDATE categories
        SET parent_id = 'health'
        WHERE parent_id IN (
          SELECT id FROM categories
          WHERE name IN ('Hospitals', 'Hospitals & Clinics', 'Medical shops', 'Medical Shops', 'Diagnostic Labs', 'Diagnostic Lab Centers', 'Diagnosis Labs', 'Radiology Scans', 'Radiology Scan Centers', 'Scan Centers')
            AND id NOT IN ('hospitals-clinics', 'medical-shops', 'diagnostic-lab-centers', 'radiology-scan-centers')
        )
      `)

      await query(`
        DELETE FROM categories
        WHERE name IN ('Hospitals', 'Hospitals & Clinics', 'Medical shops', 'Medical Shops', 'Diagnostic Labs', 'Diagnostic Lab Centers', 'Diagnosis Labs', 'Radiology Scans', 'Radiology Scan Centers', 'Scan Centers')
          AND id NOT IN ('hospitals-clinics', 'medical-shops', 'diagnostic-lab-centers', 'radiology-scan-centers')
      `)

      await query(`
        INSERT INTO categories (id, name, parent_id)
        VALUES
          ('shops-local-businesses', 'Shops & Local Businesses', NULL),
          ('home-technical-services', 'Home & Technical Services', NULL),
          ('government-public-services', 'Government & Public Services', NULL),
          ('education-training', 'Education & Sports Training Centers', NULL),
          ('education-institutions', 'Education & Institutions', NULL),
          ('travel-transport', 'Travel & Transport', NULL),
          ('religious-miscellaneous', 'Religious & Miscellaneous', NULL),
          ('tourism-attractions', 'Tourism & Attractions', NULL),
          ('finance-utilities', 'Finance & Utilities', NULL),
          ('restaurants-hotels', 'Restaurants & Hotels', NULL)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id
      `)

      await query(`
        UPDATE businesses
        SET category_name = 'Education & Sports Training Centers'
        WHERE category_name = 'Education & Training'
      `)

      await query(`
        UPDATE categories
        SET name = 'Education & Institutions'
        WHERE name = 'Education'
      `)

      await query(`
        UPDATE categories
        SET name = 'Restaurants & Hotels'
        WHERE name IN ('Restaurants', 'Restarent & Hotals', 'Restaurants & Hotals')
      `)

      await query(`
        UPDATE businesses
        SET category_name = 'Education & Institutions'
        WHERE category_name = 'Education'
      `)

      await query(`
        UPDATE businesses
        SET category_name = 'Restaurants & Hotels'
        WHERE category_name IN ('Restaurants', 'Restarent & Hotals', 'Restaurants & Hotals')
      `)

      await query(`
        WITH category_usage AS (
          SELECT c.id, c.name, COUNT(b.id)::INTEGER AS listing_count
          FROM categories c
          LEFT JOIN businesses b ON b.category_id = c.id
          WHERE c.name IN ('Restaurants & Hotels', 'Education & Institutions')
          GROUP BY c.id, c.name
        ), canonical AS (
          SELECT DISTINCT ON (name) name, id
          FROM category_usage
          ORDER BY name, listing_count DESC, id
        )
        UPDATE businesses b
        SET category_id = canonical.id, category_name = canonical.name, updated_at = NOW()
        FROM category_usage duplicate
        JOIN canonical ON canonical.name = duplicate.name
        WHERE b.category_id = duplicate.id
          AND duplicate.id <> canonical.id
      `)

      await query(`
        WITH category_usage AS (
          SELECT c.id, c.name, COUNT(b.id)::INTEGER AS listing_count
          FROM categories c
          LEFT JOIN businesses b ON b.category_id = c.id
          WHERE c.name IN ('Restaurants & Hotels', 'Education & Institutions')
          GROUP BY c.id, c.name
        ), canonical AS (
          SELECT DISTINCT ON (name) name, id
          FROM category_usage
          ORDER BY name, listing_count DESC, id
        )
        UPDATE categories child
        SET parent_id = canonical.id
        FROM canonical, categories duplicate
        WHERE child.parent_id = duplicate.id
          AND duplicate.name = canonical.name
          AND duplicate.id <> canonical.id
      `)

      await query(`
        WITH category_usage AS (
          SELECT c.id, c.name, COUNT(b.id)::INTEGER AS listing_count
          FROM categories c
          LEFT JOIN businesses b ON b.category_id = c.id
          WHERE c.name IN ('Restaurants & Hotels', 'Education & Institutions')
          GROUP BY c.id, c.name
        ), canonical AS (
          SELECT DISTINCT ON (name) name, id
          FROM category_usage
          ORDER BY name, listing_count DESC, id
        )
        DELETE FROM categories duplicate
        USING canonical
        WHERE duplicate.name = canonical.name
          AND duplicate.id <> canonical.id
      `)

      await query(`
        UPDATE categories
        SET name = 'Hospitals & Clinics'
        WHERE name IN ('Hospitals', 'Hospitals & clincs', 'Hospitals & Clincs')
      `)

      await query(`
        UPDATE businesses
        SET category_name = 'Hospitals & Clinics'
        WHERE category_name IN ('Hospitals', 'Hospitals & clincs', 'Hospitals & Clincs')
      `)

      await query(`
        INSERT INTO categories (id, name, parent_id)
        VALUES
          ('book-stores', 'Book Stores', 'shops-local-businesses'),
          ('photo-studios', 'Photo Studios', 'shops-local-businesses'),
          ('courier-services', 'Courier Services', 'shops-local-businesses'),
          ('kids-toys-cycles', 'Kids Toys & Cycles', 'shops-local-businesses'),
          ('vehicle-battery-shops', 'Vehicle Battery Shops', 'shops-local-businesses'),
          ('key-lock-repair', 'Key & Lock Repair', 'shops-local-businesses'),
          ('painting-hardware', 'Painting & Hardware', 'shops-local-businesses'),
          ('dry-fruit-stores', 'Dry Fruit Stores', 'shops-local-businesses'),
          ('mobile-accessories', 'Mobile & Accessories', 'shops-local-businesses'),
          ('fireworks-crackers', 'Fireworks & Crackers', 'shops-local-businesses'),
          ('iron-grill-suppliers', 'Iron & Grill Suppliers', 'shops-local-businesses'),
          ('clothing-tailors', 'Clothing & Tailors', 'shops-local-businesses'),
          ('carpentry-services', 'Carpentry Services', 'home-technical-services'),
          ('ac-services', 'AC Services', 'home-technical-services'),
          ('washing-machine-repair', 'Washing Machine Repair', 'home-technical-services'),
          ('event-caterers', 'Event Caterers', 'home-technical-services'),
          ('wifi-internet-services', 'WiFi & Internet Services', 'home-technical-services'),
          ('tractor-mechanics', 'Tractor Mechanics', 'home-technical-services'),
          ('meeseva-centers', 'MeeSeva Centers', 'government-public-services'),
          ('aadhaar-centers', 'Aadhaar Centers', 'government-public-services'),
          ('sachivalayams', 'Sachivalayams', 'government-public-services'),
          ('court-legal-services', 'Court & Legal Services', 'government-public-services'),
          ('electricity-water-offices', 'Electricity & Water Offices', 'government-public-services'),
          ('sports-coaching', 'Sports Coaching', 'education-training'),
          ('tuition-centers', 'Tuition Centers', 'education-training'),
          ('dance-academies', 'Dance Academies', 'education-training'),
          ('apsrtc-bus-stand', 'APSRTC Bus Stand', 'travel-transport'),
          ('private-travels', 'Private Travels', 'travel-transport'),
          ('railway-station', 'Railway Station', 'travel-transport'),
          ('priests-poojaris', 'Priests & Poojaris', 'religious-miscellaneous'),
          ('swimming-pools', 'Swimming Pools', 'religious-miscellaneous'),
          ('other-services', 'Other Services', 'religious-miscellaneous'),
          ('ramayapatnam-beach', 'Ramayapatnam Beach', 'tourism-attractions'),
          ('pakala-lake', 'Pakala Lake', 'tourism-attractions'),
          ('etha-mokkala', 'Etha Mokkala', 'tourism-attractions'),
          ('chirala-beach', 'Chirala Beach', 'tourism-attractions'),
          ('banks-atms', 'Banks & ATMs', 'finance-utilities'),
          ('insurance-offices', 'Insurance Offices', 'finance-utilities')
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id
      `)

      await query(`
        UPDATE businesses
        SET category_id = 'apsrtc-bus-stand', category_name = 'APSRTC Bus Stand', updated_at = NOW()
        WHERE category_name IN ('Bus stand', 'APSRTC Bus Stand')
           OR category_id IN (SELECT id FROM categories WHERE name IN ('Bus stand', 'APSRTC Bus Stand'))
      `)

      await query(`
        DELETE FROM categories
        WHERE name = 'Bus stand'
           OR id = 'bus-stand'
      `)

      await query(`
        UPDATE businesses
        SET category_id = 'tourism-attractions', category_name = 'Tourism & Attractions', updated_at = NOW()
        WHERE category_name = 'Tourist Places'
           OR category_id IN (SELECT id FROM categories WHERE name = 'Tourist Places')
      `)

      await query(`
        UPDATE categories
        SET parent_id = 'tourism-attractions'
        WHERE parent_id IN (SELECT id FROM categories WHERE name = 'Tourist Places')
      `)

      await query(`
        DELETE FROM categories
        WHERE name = 'Tourist Places'
      `)

      await query(`
        UPDATE businesses
        SET image = 'https://images.unsplash.com/photo-1548013146-72479768bada?auto=format&fit=crop&w=1200&q=80', updated_at = NOW()
        WHERE category_name = 'Temples'
           OR category_id IN (SELECT id FROM categories WHERE name = 'Temples')
      `)

      await query(`
        WITH medical_listings AS (
          SELECT id,
                 ROW_NUMBER() OVER (ORDER BY id) AS row_number
          FROM businesses
          WHERE category_name IN ('Medical shops', 'Medical Shops')
             OR category_id IN (SELECT id FROM categories WHERE name IN ('Medical shops', 'Medical Shops'))
        )
        UPDATE businesses
        SET image = (ARRAY[
          'https://images.unsplash.com/photo-1587854692152-cbe660dbde88?auto=format&fit=crop&w=1200&q=80',
          'https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?auto=format&fit=crop&w=1200&q=80',
          'https://images.unsplash.com/photo-1585435557343-3b092031a831?auto=format&fit=crop&w=1200&q=80',
          'https://images.unsplash.com/photo-1471864190281-a93a3070b6de?auto=format&fit=crop&w=1200&q=80',
          'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?auto=format&fit=crop&w=1200&q=80',
          'https://images.unsplash.com/photo-1576602976047-174e57a47881?auto=format&fit=crop&w=1200&q=80'
        ])[((medical_listings.row_number - 1) % 6) + 1],
        updated_at = NOW()
        FROM medical_listings
        WHERE businesses.id = medical_listings.id
      `)

      await query(`
        UPDATE businesses
        SET image = CASE category_id
              WHEN 'ac-services' THEN 'https://images.unsplash.com/photo-1585771724684-38269d6639fd?auto=format&fit=crop&w=1200&q=80'
              WHEN 'carpentry-services' THEN 'https://images.unsplash.com/photo-1452132212556-81eb2172a06a?auto=format&fit=crop&w=1200&q=80'
              WHEN 'event-caterers' THEN 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?auto=format&fit=crop&w=1200&q=80'
              WHEN 'tractor-mechanics' THEN 'https://images.unsplash.com/photo-1581092918056-0c4c3acd3789?auto=format&fit=crop&w=1200&q=80'
              WHEN 'washing-machine-repair' THEN 'https://images.unsplash.com/photo-1585810274998-91a10b5e4971?auto=format&fit=crop&w=1200&q=80'
              WHEN 'wifi-internet-services' THEN 'https://images.unsplash.com/photo-1563089145-fc3ab8b33fda?auto=format&fit=crop&w=1200&q=80'
              ELSE image
            END,
            updated_at = NOW()
        WHERE category_id IN ('ac-services', 'carpentry-services', 'event-caterers', 'tractor-mechanics', 'washing-machine-repair', 'wifi-internet-services')
      `)
    }).catch((error) => {
      schemaPromise = undefined
      throw error
    })
  }
  return schemaPromise
}