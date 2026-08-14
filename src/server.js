import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureSchema, query } from './database.js'

const app = express()
const port = Number(process.env.PORT || 4000)
const backendDirectory = path.dirname(fileURLToPath(import.meta.url))
const imageDirectory = path.resolve(backendDirectory, '../images')

app.use(cors())
app.use(express.json())
app.use('/images', express.static(imageDirectory))

function publicImageUrl(request, image) {
  if (!image || image.startsWith('http')) return image
  return `${request.protocol}://${request.get('host')}${image}`
}

function formatBusiness(request, business) {
  return {
    ...business,
    latitude: business.latitude ?? null,
    longitude: business.longitude ?? null,
    image: publicImageUrl(request, business.image),
    gallery: (business.gallery ?? []).map((image) => publicImageUrl(request, image)),
  }
}

function normalizePhone(value) {
  return typeof value === 'string' ? value.replace(/\D/g, '') : ''
}

function isValidPhone(phone) {
  return /^[6-9]\d{9}$/.test(phone)
}

async function getAuthenticatedUser(request) {
  const phone = normalizePhone(request.get('x-user-phone'))
  if (!isValidPhone(phone)) return null
  const { rows } = await query('SELECT phone, role, is_super_admin AS "isSuperAdmin" FROM users WHERE phone = $1', [phone])
  return rows[0] || null
}

async function requireUser(request, response) {
  const user = await getAuthenticatedUser(request)
  if (!user) {
    response.status(401).json({ error: 'Sign in before continuing' })
    return null
  }
  return user
}

function isAdmin(user) {
  return Boolean(user?.isSuperAdmin) || user?.role === 'super_admin'
}

async function requireAdmin(request, response) {
  const user = await requireUser(request, response)
  if (!user || !isAdmin(user)) {
    if (user) response.status(403).json({ error: 'Admin access required' })
    return null
  }
  return user
}

app.get('/health', (_request, response) => response.json({ status: 'ok' }))

app.post('/api/auth/login', async (request, response, next) => {
  try {
    await ensureSchema()
    const phone = typeof request.body.phone === 'string' ? request.body.phone.replace(/\D/g, '') : ''
    const name = typeof request.body.name === 'string' ? request.body.name.trim() : ''
    if (!/^[6-9]\d{9}$/.test(phone)) return response.status(400).json({ error: 'A valid 10-digit mobile number is required' })

    const superAdminPhone = (process.env.SUPER_ADMIN_PHONE || '9999999999').replace(/\D/g, '')
    const isSuperAdmin = phone === superAdminPhone

    const existing = await query('SELECT name, phone, role, is_super_admin AS "isSuperAdmin" FROM users WHERE phone = $1', [phone])
    if (existing.rows[0]) {
      const profile = existing.rows[0]
      const normalizedProfile = {
        name: profile.name,
        phone: profile.phone,
        role: profile.role || (profile.isSuperAdmin ? 'super_admin' : 'user'),
        isSuperAdmin: Boolean(profile.isSuperAdmin) || isSuperAdmin,
      }
      return response.json({ data: normalizedProfile, isNewUser: false })
    }

    if (!/^[A-Za-z][A-Za-z .'-]{1,49}$/.test(name)) return response.status(400).json({ error: 'A valid name is required for a new user' })

    const { rows } = await query(
      'INSERT INTO users (phone, name, role, is_super_admin, created_by, updated_by) VALUES ($1, $2, $3, $4, $1, $1) ON CONFLICT (phone) DO UPDATE SET updated_at = NOW(), updated_by = users.phone RETURNING name, phone, role, is_super_admin AS "isSuperAdmin"',
      [phone, name, isSuperAdmin ? 'super_admin' : 'user', isSuperAdmin],
    )
    const createdUser = rows[0]
    return response.status(201).json({
      data: {
        name: createdUser.name,
        phone: createdUser.phone,
        role: createdUser.role || (createdUser.isSuperAdmin ? 'super_admin' : 'user'),
        isSuperAdmin: Boolean(createdUser.isSuperAdmin) || isSuperAdmin,
      },
      isNewUser: true,
    })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/users/:phone/favorites', async (request, response, next) => {
  try {
    await ensureSchema()
    const user = await requireUser(request, response)
    if (!user || normalizePhone(request.params.phone) !== user.phone) return
    const phone = user.phone
    const { rows } = await query('SELECT business_id FROM favorites WHERE user_phone = $1 ORDER BY created_at', [phone])
    response.json({ data: rows.map((row) => row.business_id) })
  } catch (error) {
    next(error)
  }
})

app.put('/api/users/:phone/favorites/:businessId', async (request, response, next) => {
  try {
    await ensureSchema()
    const user = await requireUser(request, response)
    if (!user || normalizePhone(request.params.phone) !== user.phone) return
    const phone = user.phone
    const { businessId } = request.params
    const business = await query('SELECT 1 FROM businesses WHERE id = $1', [businessId])
    if (!business.rows[0]) return response.status(404).json({ error: 'Business not found' })
    const existing = await query('SELECT 1 FROM favorites WHERE user_phone = $1 AND business_id = $2', [phone, businessId])
    if (existing.rows[0]) {
      await query('DELETE FROM favorites WHERE user_phone = $1 AND business_id = $2', [phone, businessId])
    } else {
      await query('INSERT INTO favorites (user_phone, business_id, created_by, updated_by) VALUES ($1, $2, $1, $1)', [phone, businessId])
    }
    const { rows } = await query('SELECT business_id FROM favorites WHERE user_phone = $1 ORDER BY created_at', [phone])
    response.json({ data: rows.map((row) => row.business_id) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/reviews', async (_request, response, next) => {
  try {
    await ensureSchema()
    const { rows } = await query('SELECT id, business_id AS "businessId", user_phone AS "userPhone", rating, comment, created_at AS "createdAt" FROM reviews ORDER BY created_at')
    response.json({ data: rows })
  } catch (error) {
    next(error)
  }
})

app.post('/api/businesses/:businessId/reviews', async (request, response, next) => {
  try {
    await ensureSchema()
    const { businessId } = request.params
    const user = await requireUser(request, response)
    if (!user) return
    const userPhone = user.phone
    const rating = Number(request.body.rating)
    const comment = typeof request.body.comment === 'string' ? request.body.comment.trim().slice(0, 1000) : ''
    if (!/^[6-9]\d{9}$/.test(userPhone)) return response.status(401).json({ error: 'Sign in before submitting a review' })
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return response.status(400).json({ error: 'Rating must be between 1 and 5' })

    const { rows } = await query(
      'INSERT INTO reviews (id, business_id, user_phone, rating, comment, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $3, $3) RETURNING id, business_id AS "businessId", user_phone AS "userPhone", rating, comment, created_at AS "createdAt"',
      [randomUUID(), businessId, userPhone, rating, comment],
    )
    response.status(201).json({ data: rows[0] })
  } catch (error) {
    next(error)
  }
})

app.post('/api/feedback', async (request, response, next) => {
  try {
    await ensureSchema()
    const user = await requireUser(request, response)
    if (!user) return
    const userPhone = user.phone
    const type = request.body.type === 'Complaint' ? 'Complaint' : request.body.type === 'Feedback' ? 'Feedback' : ''
    const subject = typeof request.body.subject === 'string' ? request.body.subject.trim().slice(0, 200) : ''
    const contact = typeof request.body.contact === 'string' ? request.body.contact.replace(/\D/g, '').slice(0, 10) : ''
    const message = typeof request.body.message === 'string' ? request.body.message.trim().slice(0, 5000) : ''
    if (!/^[6-9]\d{9}$/.test(userPhone)) return response.status(401).json({ error: 'Sign in before sending feedback' })
    if (!type || subject.length < 3 || message.length < 10) return response.status(400).json({ error: 'Provide a type, subject, and message of at least 10 characters' })

    const { rows } = await query(
      'INSERT INTO feedback_submissions (id, user_phone, type, subject, contact, message, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $2, $2) RETURNING id, type, subject, contact, message, created_at AS "createdAt"',
      [randomUUID(), userPhone, type, subject, contact || null, message],
    )
    response.status(201).json({ data: rows[0] })
  } catch (error) {
    next(error)
  }
})

app.get('/api/categories', async (_request, response, next) => {
  try {
    await ensureSchema()
    const { rows } = await query('SELECT id, name, parent_id AS "parentId" FROM categories ORDER BY name')
    response.json({ data: rows })
  } catch (error) {
    next(error)
  }
})

app.get('/api/businesses', async (request, response, next) => {
  try {
    await ensureSchema()
    const categoryId = typeof request.query.categoryId === 'string' ? request.query.categoryId : null
    const statement = `SELECT id, name, category_id AS "categoryId", category_name AS "categoryName", address, latitude, longitude, phone, website, description, image, gallery, status, submitted_by AS "submittedBy" FROM businesses WHERE (status IS NULL OR status <> 'Pending review')${categoryId ? ' AND category_id = $1' : ''}`
    const { rows } = await query(statement, categoryId ? [categoryId] : [])
    response.json({ data: rows.map((business) => formatBusiness(request, business)) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/users/:phone/submissions', async (request, response, next) => {
  try {
    await ensureSchema()
    const user = await requireUser(request, response)
    if (!user || normalizePhone(request.params.phone) !== user.phone) return
    const { rows } = await query('SELECT id, name, category_id AS "categoryId", category_name AS "categoryName", address, latitude, longitude, phone, website, description, image, gallery, status, submitted_by AS "submittedBy" FROM businesses WHERE submitted_by = $1 ORDER BY created_at DESC', [user.phone])
    response.json({ data: rows.map((business) => formatBusiness(request, business)) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/businesses/:id', async (request, response, next) => {
  try {
    await ensureSchema()
    const { rows } = await query('SELECT id, name, category_id AS "categoryId", category_name AS "categoryName", address, latitude, longitude, phone, website, description, image, gallery, status, submitted_by AS "submittedBy" FROM businesses WHERE id = $1', [request.params.id])
    if (!rows[0]) return response.status(404).json({ error: 'Business not found' })
    if (rows[0].status === 'Pending review') {
      const user = await getAuthenticatedUser(request)
      if (!user || (rows[0].submittedBy !== user.phone && !isAdmin(user))) return response.status(404).json({ error: 'Business not found' })
    }
    return response.json({ data: formatBusiness(request, rows[0]) })
  } catch (error) {
    return next(error)
  }
})

app.post('/api/businesses', async (request, response, next) => {
  try {
    await ensureSchema()
    const user = await requireUser(request, response)
    if (!user) return
    const business = request.body
    const name = typeof business.name === 'string' ? business.name.trim() : ''
    const address = typeof business.address === 'string' ? business.address.trim() : ''
    const categoryId = typeof business.categoryId === 'string' ? business.categoryId.trim() : ''
    const categoryName = typeof business.categoryName === 'string' ? business.categoryName.trim() : ''
    const description = typeof business.description === 'string' ? business.description.trim().slice(0, 2000) : ''
    if (name.length < 2 || address.length < 5 || !categoryId || !categoryName || description.length < 10) {
      return response.status(400).json({ error: 'Name, category, address, and description are required' })
    }
    const category = await query('SELECT 1 FROM categories WHERE id = $1', [categoryId])
    if (!category.rows[0]) return response.status(400).json({ error: 'Choose a valid category' })
    const { rows } = await query(
      'INSERT INTO businesses (id, name, category_id, category_name, address, latitude, longitude, phone, website, description, image, gallery, status, submitted_by, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16) RETURNING id, name, category_id AS "categoryId", category_name AS "categoryName", address, latitude, longitude, phone, website, description, image, gallery, status, submitted_by AS "submittedBy"',
      [randomUUID(), name, categoryId, categoryName, address, business.latitude ?? null, business.longitude ?? null, business.phone ?? null, business.website ?? null, description, business.image ?? null, JSON.stringify(business.gallery ?? []), 'Pending review', user.phone, user.phone, user.phone],
    )
    response.status(201).json({ data: formatBusiness(request, rows[0]) })
  } catch (error) {
    next(error)
  }
})

app.patch('/api/businesses/:id', async (request, response, next) => {
  try {
    await ensureSchema()
    const user = await requireUser(request, response)
    if (!user) return
    const ownership = await query('SELECT submitted_by FROM businesses WHERE id = $1', [request.params.id])
    if (!ownership.rows[0]) return response.status(404).json({ error: 'Business not found' })
    if (!isAdmin(user) && ownership.rows[0].submitted_by !== user.phone) return response.status(403).json({ error: 'You cannot update this listing' })
    const status = ['Pending review', 'Approved', 'Rejected', 'Sold out'].includes(request.body.status) ? request.body.status : null
    if (!status) return response.status(400).json({ error: 'Invalid listing status' })
    const { rows } = await query('UPDATE businesses SET status = $1, updated_by = $2, updated_at = NOW() WHERE id = $3 RETURNING id, name, category_id AS "categoryId", category_name AS "categoryName", address, latitude, longitude, phone, website, description, image, gallery, status, submitted_by AS "submittedBy"', [status, user.phone, request.params.id])
    if (!rows[0]) return response.status(404).json({ error: 'Business not found' })
    return response.json({ data: formatBusiness(request, rows[0]) })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/announcements', async (_request, response, next) => {
  try {
    await ensureSchema()
    const { rows } = await query(`
      SELECT
        id,
        title,
        detail,
        description,
        type,
        image,
        start_date AS "startDate",
        end_date AS "endDate"
      FROM announcements
      WHERE (start_date IS NULL OR start_date <= NOW())
        AND (end_date IS NULL OR end_date >= NOW())
      ORDER BY COALESCE(start_date, NOW()) DESC
    `)
    response.json({ data: rows })
  } catch (error) {
    next(error)
  }
})

app.post('/api/usage', async (request, response, next) => {
  try {
    await ensureSchema()
    const userPhone = typeof request.body.userPhone === 'string' ? request.body.userPhone.replace(/\D/g, '') : null
    const userName = typeof request.body.userName === 'string' && request.body.userName.trim() ? request.body.userName.trim() : null
    const deviceId = typeof request.body.deviceId === 'string' && request.body.deviceId.trim() ? request.body.deviceId.trim() : null
    const appVersion = typeof request.body.appVersion === 'string' && request.body.appVersion.trim() ? request.body.appVersion.trim() : null
    const platform = typeof request.body.platform === 'string' && request.body.platform.trim() ? request.body.platform.trim() : null
    const metadata = request.body.metadata && typeof request.body.metadata === 'object' ? request.body.metadata : {}
    if (!deviceId) return response.status(400).json({ error: 'Device identifier is required' })

    const { rows } = await query(
      `INSERT INTO app_usage (id, user_phone, user_name, device_id, app_version, platform, metadata, visited_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
       ON CONFLICT (device_id)
       DO UPDATE SET
         user_phone = COALESCE(app_usage.user_phone, EXCLUDED.user_phone),
         user_name = COALESCE(EXCLUDED.user_name, app_usage.user_name),
         app_version = COALESCE(EXCLUDED.app_version, app_usage.app_version),
         platform = COALESCE(EXCLUDED.platform, app_usage.platform),
         metadata = COALESCE(app_usage.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
         visited_at = NOW()
       RETURNING id, user_phone AS "userPhone", user_name AS "userName", device_id AS "deviceId", app_version AS "appVersion", platform, metadata, visited_at AS "visitedAt"`,
      [randomUUID(), userPhone || null, userName || null, deviceId, appVersion || null, platform || null, JSON.stringify(metadata)],
    )
    response.status(201).json({ data: rows[0] })
  } catch (error) {
    next(error)
  }
})

app.get('/api/usage/count', async (_request, response, next) => {
  try {
    await ensureSchema()
    const { rows } = await query(`
      SELECT
        COUNT(*)::int AS total_visits,
        COUNT(DISTINCT device_id)::int AS installed_devices,
        COUNT(DISTINCT user_phone)::int AS logged_in_users
      FROM app_usage
      WHERE visited_at >= NOW() - INTERVAL '30 days'
    `)
    response.json({ data: rows[0] })
  } catch (error) {
    next(error)
  }
})

app.get('/api/admin/summary', async (_request, response, next) => {
  try {
    await ensureSchema()
    const user = await requireAdmin(_request, response)
    if (!user) return
    const { rows } = await query(`
      SELECT
        (SELECT COUNT(*)::int FROM users) AS total_users,
        (SELECT COUNT(*)::int FROM users WHERE role = 'super_admin' OR is_super_admin = TRUE) AS super_admins,
        (SELECT COUNT(*)::int FROM businesses) AS total_businesses,
        (SELECT COUNT(DISTINCT device_id)::int FROM app_usage WHERE visited_at >= NOW() - INTERVAL '30 days') AS installed_devices,
        (SELECT COUNT(*)::int FROM reviews) AS total_reviews,
        (SELECT COUNT(*)::int FROM feedback_submissions) AS total_feedback
    `)
    response.json({ data: rows[0] })
  } catch (error) {
    next(error)
  }
})

app.get('/api/admin/recent-activity', async (_request, response, next) => {
  try {
    await ensureSchema()
    const user = await requireAdmin(_request, response)
    if (!user) return
    const { rows } = await query(`
      WITH recent_reviews AS (
        SELECT 'review' AS type, business_id AS entity_id, rating::text AS label, created_at AS created_at
        FROM reviews
        ORDER BY created_at DESC
        LIMIT 5
      ), recent_feedback AS (
        SELECT 'feedback' AS type, subject AS entity_id, type AS label, created_at AS created_at
        FROM feedback_submissions
        ORDER BY created_at DESC
        LIMIT 5
      ), recent_usage AS (
        SELECT 'usage' AS type, device_id AS entity_id, 'app visit' AS label, visited_at AS created_at
        FROM app_usage
        ORDER BY visited_at DESC
        LIMIT 5
      )
      SELECT * FROM (
        SELECT * FROM recent_reviews
        UNION ALL
        SELECT * FROM recent_feedback
        UNION ALL
        SELECT * FROM recent_usage
      ) activity
      ORDER BY created_at DESC
      LIMIT 10
    `)
    response.json({ data: rows })
  } catch (error) {
    next(error)
  }
})

app.use((error, _request, response, _next) => {
  console.error(error)
  response.status(500).json({ error: 'Unable to load data from PostgreSQL' })
})

app.listen(port, () => console.log(`Mana Kandukur API listening on port ${port}`))