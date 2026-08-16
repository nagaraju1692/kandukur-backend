import dotenv from 'dotenv'
import cors from 'cors'
import express from 'express'
import { randomUUID } from 'node:crypto'
import multer from 'multer'
import path from 'node:path'
import { downloadBlob, ensureBlobContainer, uploadBlob } from './blobStorage.js'
import { ensureSchema, query } from './database.js'

dotenv.config({ path: '.env.local' })
dotenv.config()

const app = express()
const port = Number(process.env.PORT || 4000)
const defaultSuperAdminPhone = '8807380269'

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => {
    if (file.mimetype?.startsWith('image/')) return callback(null, true)
    return callback(new Error('Only image uploads are allowed'))
  },
})

app.use(cors())
app.use(express.json())
app.use('/images', async (request, response, next) => {
  const blobName = request.path.replace(/^\/+/, '')
  if (!blobName) return response.status(404).end()
  try {
    const blobResponse = await downloadBlob(blobName)
    if (blobResponse.contentType) response.type(blobResponse.contentType)
    if (blobResponse.contentLength) response.set('Content-Length', String(blobResponse.contentLength))
    if (blobResponse.readableStreamBody) blobResponse.readableStreamBody.pipe(response)
    else response.status(404).end()
  } catch (error) {
    if (error.statusCode === 404) return response.status(404).end()
    next(error)
  }
})

async function uploadAdminImage(request, response, directory) {
  if (!request.file) return response.status(400).json({ error: 'Image file is required' })
  const extension = path.extname(request.file.originalname || '').toLowerCase() || '.jpg'
  const blobName = `${directory}/${randomUUID()}${extension}`
  await uploadBlob(blobName, request.file.buffer, request.file.mimetype)
  const imagePath = `/images/${blobName}`
  return response.status(201).json({ data: { image: publicImageUrl(request, imagePath), path: imagePath } })
}

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

function normalizeText(value, fallback = '') {
  if (typeof value === 'string') return value.trim()
  return fallback
}

function normalizeRole(value) {
  if (value === 'admin' || value === 'super_admin') return value
  return 'user'
}

function parseOptionalDate(value) {
  const normalized = normalizeText(value)
  if (!normalized) return null
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function parseGalleryImages(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeText(typeof item === 'string' ? item : String(item ?? '')))
      .filter(Boolean)
      .slice(0, 10)
  }
  if (typeof value === 'string') {
    return value.split(',').map((item) => normalizeText(item)).filter(Boolean).slice(0, 10)
  }
  return []
}

const directPostingCategoryNames = new Set(['Real Estate', 'Rental Transport', 'Construction Materials', 'Buy & Sell'])

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
  return Boolean(user?.isSuperAdmin) || user?.role === 'admin' || user?.role === 'super_admin'
}

async function requireAdmin(request, response) {
  const user = await requireUser(request, response)
  if (!user) return null

  if (isAdmin(user)) return user

  const configuredSuperAdminPhone = normalizePhone(process.env.SUPER_ADMIN_PHONE || defaultSuperAdminPhone)
  const isPrivilegedPhone = user.phone === configuredSuperAdminPhone || user.phone === defaultSuperAdminPhone

  if (isPrivilegedPhone) {
    await query('UPDATE users SET role = $1, updated_at = NOW(), updated_by = $2 WHERE phone = $2', ['admin', user.phone])
    return { ...user, role: 'admin', isSuperAdmin: true }
  }

  response.status(403).json({ error: 'Admin access required' })
  return null
}

app.get('/health', (_request, response) => response.json({ status: 'ok' }))

app.post('/api/auth/login', async (request, response, next) => {
  try {
    await ensureSchema()
    const phone = typeof request.body.phone === 'string' ? request.body.phone.replace(/\D/g, '') : ''
    const name = typeof request.body.name === 'string' ? request.body.name.trim() : ''
    if (!/^[6-9]\d{9}$/.test(phone)) return response.status(400).json({ error: 'A valid 10-digit mobile number is required' })

    const superAdminPhone = (process.env.SUPER_ADMIN_PHONE || defaultSuperAdminPhone).replace(/\D/g, '')
    const isPrivilegedPhone = phone === superAdminPhone || phone === defaultSuperAdminPhone
    const requestedRole = normalizeRole(request.body.role)
    const roleFromLogin = isPrivilegedPhone ? 'admin' : requestedRole

    const existing = await query('SELECT name, phone, role, is_super_admin AS "isSuperAdmin" FROM users WHERE phone = $1', [phone])
    if (existing.rows[0]) {
      const profile = existing.rows[0]
      const storedRole = normalizeRole(profile.role)
      const effectiveRole = isPrivilegedPhone && storedRole === 'user' ? 'admin' : storedRole
      if (effectiveRole !== profile.role) {
        await query('UPDATE users SET role = $1, updated_at = NOW(), updated_by = $2 WHERE phone = $2', [effectiveRole, phone])
      }
      const normalizedProfile = {
        name: profile.name,
        phone: profile.phone,
        role: effectiveRole,
        isSuperAdmin: effectiveRole === 'admin' || effectiveRole === 'super_admin' || Boolean(profile.isSuperAdmin),
      }
      return response.json({ data: normalizedProfile, isNewUser: false })
    }

    if (!/^[A-Za-z][A-Za-z .'-]{1,49}$/.test(name)) return response.status(400).json({ error: 'A valid name is required for a new user' })

    const { rows } = await query(
      'INSERT INTO users (phone, name, role, is_super_admin, created_by, updated_by) VALUES ($1, $2, $3, $4, $1, $1) ON CONFLICT (phone) DO UPDATE SET updated_at = NOW(), updated_by = users.phone RETURNING name, phone, role, is_super_admin AS "isSuperAdmin"',
      [phone, name, roleFromLogin, false],
    )
    const createdUser = rows[0]
    const createdRole = normalizeRole(createdUser.role)
    return response.status(201).json({
      data: {
        name: createdUser.name,
        phone: createdUser.phone,
        role: createdRole,
        isSuperAdmin: createdRole === 'admin' || createdRole === 'super_admin' || Boolean(createdUser.isSuperAdmin),
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

app.get('/api/bus-routes', async (_request, response, next) => {
  try {
    await ensureSchema()
    const { rows } = await query(`
      SELECT id, origin, destination, destination_te AS "destinationTe", destination_type AS "destinationType",
             service_type AS "serviceType", TO_CHAR(departure_time, 'HH24:MI') AS "departureTime", days, notes
      FROM bus_routes
      WHERE is_active = TRUE
      ORDER BY departure_time, destination
    `)
    response.json({ data: rows })
  } catch (error) {
    next(error)
  }
})

app.get('/api/mandal-villages', async (_request, response, next) => {
  try {
    await ensureSchema()
    const { rows } = await query(`
      SELECT id, name, distance_km AS "distanceKm", pincode
      FROM mandal_villages
      ORDER BY COALESCE(distance_km, 9999), name
    `)
    response.json({ data: rows })
  } catch (error) {
    next(error)
  }
})

app.post('/api/admin/bus-routes', async (request, response, next) => {
  try {
    await ensureSchema()
    const user = await requireAdmin(request, response)
    if (!user) return

    const destination = normalizeText(request.body.destination)
    const destinationTe = normalizeText(request.body.destinationTe)
    const destinationType = request.body.destinationType === 'Village' ? 'Village' : request.body.destinationType === 'City' ? 'City' : ''
    const serviceType = normalizeText(request.body.serviceType)
    const departureTime = normalizeText(request.body.departureTime)
    const days = normalizeText(request.body.days || 'Daily')
    const notes = normalizeText(request.body.notes)
    if (!destination || !destinationType || !serviceType || !/^([01]\d|2[0-3]):[0-5]\d$/.test(departureTime)) {
      return response.status(400).json({ error: 'Destination, destination type, service type, and a HH:MM departure time are required' })
    }

    const { rows } = await query(
      `INSERT INTO bus_routes (id, destination, destination_te, destination_type, service_type, departure_time, days, notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       RETURNING id, origin, destination, destination_te AS "destinationTe", destination_type AS "destinationType",
                 service_type AS "serviceType", TO_CHAR(departure_time, 'HH24:MI') AS "departureTime", days, notes`,
      [randomUUID(), destination, destinationTe || null, destinationType, serviceType, departureTime, days, notes || null, user.phone],
    )
    response.status(201).json({ data: rows[0] })
  } catch (error) {
    next(error)
  }
})

app.get('/api/businesses', async (request, response, next) => {
  try {
    await ensureSchema()
    const categoryId = typeof request.query.categoryId === 'string' ? request.query.categoryId : null
    const statement = `SELECT id, name, name_te AS "nameTe", category_id AS "categoryId", category_name AS "categoryName", address, latitude, longitude, phone, website, description, owner_name AS "ownerName", rooms, price, facing, image, gallery, status, submitted_by AS "submittedBy", created_at AS "createdAt" FROM businesses WHERE (status IS NULL OR status <> 'Pending review')${categoryId ? ' AND category_id = $1' : ''} ORDER BY created_at DESC`
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
    const { rows } = await query('SELECT id, name, name_te AS "nameTe", category_id AS "categoryId", category_name AS "categoryName", address, latitude, longitude, phone, website, description, owner_name AS "ownerName", rooms, price, facing, image, gallery, status, submitted_by AS "submittedBy" FROM businesses WHERE submitted_by = $1 ORDER BY created_at DESC', [user.phone])
    response.json({ data: rows.map((business) => formatBusiness(request, business)) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/businesses/:id', async (request, response, next) => {
  try {
    await ensureSchema()
    const { rows } = await query('SELECT id, name, name_te AS "nameTe", category_id AS "categoryId", category_name AS "categoryName", address, latitude, longitude, phone, website, description, owner_name AS "ownerName", rooms, price, facing, image, gallery, status, submitted_by AS "submittedBy" FROM businesses WHERE id = $1', [request.params.id])
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
    const business = request.body || {}
    const name = normalizeText(business.name)
    const nameTe = normalizeText(business.nameTe)
    const address = normalizeText(business.address)
    const categoryId = normalizeText(business.categoryId)
    const categoryName = normalizeText(business.categoryName)
    const description = normalizeText(business.description).slice(0, 2000)
    const ownerName = normalizeText(business.ownerName)
    const rooms = normalizeText(business.rooms)
    const price = normalizeText(business.price)
    const facing = normalizeText(business.facing)
    const image = normalizeText(business.image)
    const gallery = parseGalleryImages(business.gallery)
    if (name.length < 2 || address.length < 5 || !categoryId || !categoryName || description.length < 10) {
      return response.status(400).json({ error: 'Name, category, address, and description are required' })
    }
    const category = await query(
      `SELECT category.name, parent.name AS "parentName"
       FROM categories AS category
       LEFT JOIN categories AS parent ON parent.id = category.parent_id
       WHERE category.id = $1`,
      [categoryId],
    )
    if (!category.rows[0]) return response.status(400).json({ error: 'Choose a valid category' })
    const canPublishDirectly = directPostingCategoryNames.has(category.rows[0].name) || directPostingCategoryNames.has(category.rows[0].parentName)
    if (canPublishDirectly && !price) {
      return response.status(400).json({ error: 'Price is required for marketplace listings' })
    }
    const nextStatus = isAdmin(user) || canPublishDirectly ? 'Approved' : 'Pending review'
    const { rows } = await query(
      'INSERT INTO businesses (id, name, name_te, category_id, category_name, address, latitude, longitude, phone, website, description, owner_name, rooms, price, facing, image, gallery, status, submitted_by, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19, $20, $21) RETURNING id, name, name_te AS "nameTe", category_id AS "categoryId", category_name AS "categoryName", address, latitude, longitude, phone, website, description, owner_name AS "ownerName", rooms, price, facing, image, gallery, status, submitted_by AS "submittedBy"',
      [randomUUID(), name, nameTe || null, categoryId, categoryName, address, business.latitude ?? null, business.longitude ?? null, normalizeText(business.phone) || (canPublishDirectly ? null : user.phone), normalizeText(business.website), description, ownerName || null, rooms || null, price || null, facing || null, image || null, JSON.stringify(gallery), nextStatus, user.phone, user.phone, user.phone],
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

    const updates = { ...request.body }
    const status = ['Pending review', 'Approved', 'Rejected', 'Sold out'].includes(request.body.status) ? request.body.status : null
    if (status) updates.status = status

    const fields = []
    const values = []
    const fieldMap = {
      name: 'name',
      nameTe: 'name_te',
      categoryId: 'category_id',
      categoryName: 'category_name',
      address: 'address',
      latitude: 'latitude',
      longitude: 'longitude',
      phone: 'phone',
      website: 'website',
      description: 'description',
      ownerName: 'owner_name',
      rooms: 'rooms',
      price: 'price',
      facing: 'facing',
      image: 'image',
      gallery: 'gallery',
      status: 'status',
    }

    Object.entries(fieldMap).forEach(([bodyKey, columnName]) => {
      if (!(bodyKey in updates)) return
      const value = updates[bodyKey]
      fields.push(`${columnName} = $${values.length + 1}`)
      values.push(bodyKey === 'gallery' ? JSON.stringify(parseGalleryImages(value)) : bodyKey === 'image' ? normalizeText(value) || null : value)
    })

    if (fields.length === 0) return response.status(400).json({ error: 'No listing fields were provided for update' })
    values.push(user.phone)
    const queryText = `UPDATE businesses SET ${fields.join(', ')}, updated_by = $${values.length}, updated_at = NOW() WHERE id = $${values.length + 1} RETURNING id, name, name_te AS "nameTe", category_id AS "categoryId", category_name AS "categoryName", address, latitude, longitude, phone, website, description, owner_name AS "ownerName", rooms, price, facing, image, gallery, status, submitted_by AS "submittedBy"`
    const { rows } = await query(queryText, [...values, request.params.id])
    if (!rows[0]) return response.status(404).json({ error: 'Business not found' })
    return response.json({ data: formatBusiness(request, rows[0]) })
  } catch (error) {
    return next(error)
  }
})

app.delete('/api/businesses/:id', async (request, response, next) => {
  try {
    await ensureSchema()
    const user = await requireUser(request, response)
    if (!user) return
    const ownership = await query('SELECT submitted_by FROM businesses WHERE id = $1', [request.params.id])
    if (!ownership.rows[0]) return response.status(404).json({ error: 'Business not found' })
    if (!isAdmin(user) && ownership.rows[0].submitted_by !== user.phone) return response.status(403).json({ error: 'You cannot delete this listing' })
    await query('DELETE FROM businesses WHERE id = $1', [request.params.id])
    response.json({ success: true })
  } catch (error) {
    next(error)
  }
})

app.get('/api/admin/businesses', async (request, response, next) => {
  try {
    await ensureSchema()
    const user = await requireAdmin(request, response)
    if (!user) return
    const { rows } = await query('SELECT id, name, name_te AS "nameTe", category_id AS "categoryId", category_name AS "categoryName", address, latitude, longitude, phone, website, description, image, gallery, status, submitted_by AS "submittedBy", created_at AS "createdAt", updated_at AS "updatedAt" FROM businesses ORDER BY created_at DESC')
    response.json({ data: rows.map((business) => formatBusiness(request, business)) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/admin/feedback', async (request, response, next) => {
  try {
    await ensureSchema()
    const user = await requireAdmin(request, response)
    if (!user) return
    const { rows } = await query('SELECT id, user_phone AS "userPhone", type, subject, contact, message, created_at AS "createdAt" FROM feedback_submissions ORDER BY created_at DESC')
    response.json({ data: rows })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/admin/feedback/:id', async (request, response, next) => {
  try {
    await ensureSchema()
    const user = await requireAdmin(request, response)
    if (!user) return
    const { rows } = await query('DELETE FROM feedback_submissions WHERE id = $1 RETURNING id', [request.params.id])
    if (!rows[0]) return response.status(404).json({ error: 'Feedback not found' })
    response.json({ success: true })
  } catch (error) {
    next(error)
  }
})

app.get('/api/announcements', async (request, response, next) => {
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
    response.json({ data: rows.map((row) => ({ ...row, image: publicImageUrl(request, row.image) })) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/admin/uploads/announcement-image', async (request, response, next) => {
  try {
    await ensureSchema()
    await ensureBlobContainer()
    const user = await requireAdmin(request, response)
    if (!user) return

    imageUpload.single('image')(request, response, async (uploadError) => {
      if (uploadError) {
        return response.status(400).json({ error: uploadError.message || 'Unable to upload image' })
      }
      try {
        return await uploadAdminImage(request, response, 'announcements')
      } catch (error) {
        return next(error)
      }
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/admin/uploads/business-image', async (request, response, next) => {
  try {
    await ensureSchema()
    await ensureBlobContainer()
    const user = await requireAdmin(request, response)
    if (!user) return

    imageUpload.single('image')(request, response, async (uploadError) => {
      if (uploadError) {
        return response.status(400).json({ error: uploadError.message || 'Unable to upload image' })
      }
      try {
        return await uploadAdminImage(request, response, 'businesses')
      } catch (error) {
        return next(error)
      }
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/uploads/marketplace-image', async (request, response, next) => {
  try {
    await ensureSchema()
    await ensureBlobContainer()
    const user = await requireUser(request, response)
    if (!user) return

    imageUpload.single('image')(request, response, async (uploadError) => {
      if (uploadError) {
        return response.status(400).json({ error: uploadError.message || 'Unable to upload image' })
      }
      try {
        return await uploadAdminImage(request, response, 'marketplace')
      } catch (error) {
        return next(error)
      }
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/admin/announcements', async (request, response, next) => {
  try {
    await ensureSchema()
    const user = await requireAdmin(request, response)
    if (!user) return

    const { rows } = await query(`
      SELECT
        id,
        title,
        detail,
        description,
        type,
        image,
        start_date AS "startDate",
        end_date AS "endDate",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM announcements
      ORDER BY created_at DESC
    `)
    response.json({ data: rows.map((row) => ({ ...row, image: publicImageUrl(request, row.image) })) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/admin/announcements', async (request, response, next) => {
  try {
    await ensureSchema()
    const user = await requireAdmin(request, response)
    if (!user) return

    const title = normalizeText(request.body.title)
    const detail = normalizeText(request.body.detail)
    const description = normalizeText(request.body.description)
    const type = normalizeText(request.body.type || 'general')
    const image = normalizeText(request.body.image)
    const startDate = normalizeText(request.body.startDate)
    const endDate = normalizeText(request.body.endDate)

    if (!title || !detail || !description || !startDate || !endDate) {
      return response.status(400).json({ error: 'Title, detail, description, startDate, and endDate are required' })
    }

    const normalizedStartDate = parseOptionalDate(startDate)
    const normalizedEndDate = parseOptionalDate(endDate)
    if (startDate && !normalizedStartDate) return response.status(400).json({ error: 'Invalid startDate format' })
    if (endDate && !normalizedEndDate) return response.status(400).json({ error: 'Invalid endDate format' })
    if (normalizedStartDate && normalizedEndDate && new Date(normalizedStartDate).getTime() > new Date(normalizedEndDate).getTime()) {
      return response.status(400).json({ error: 'endDate must be greater than or equal to startDate' })
    }

    const { rows } = await query(
      `INSERT INTO announcements (id, title, detail, description, type, image, start_date, end_date, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       RETURNING id, title, detail, description, type, image, start_date AS "startDate", end_date AS "endDate", created_at AS "createdAt"`,
      [randomUUID(), title, detail, description, type, image || null, normalizedStartDate, normalizedEndDate, user.phone],
    )

    response.status(201).json({ data: rows[0] })
  } catch (error) {
    next(error)
  }
})

app.patch('/api/admin/announcements/:id', async (request, response, next) => {
  try {
    await ensureSchema()
    const user = await requireAdmin(request, response)
    if (!user) return

    if ('startDate' in request.body || 'endDate' in request.body) {
      const rawStartDate = normalizeText(request.body.startDate)
      const rawEndDate = normalizeText(request.body.endDate)
      if (!rawStartDate || !rawEndDate) return response.status(400).json({ error: 'Both startDate and endDate are required' })
      const normalizedStartDate = parseOptionalDate(rawStartDate)
      const normalizedEndDate = parseOptionalDate(rawEndDate)
      if (!normalizedStartDate) return response.status(400).json({ error: 'Invalid startDate format' })
      if (!normalizedEndDate) return response.status(400).json({ error: 'Invalid endDate format' })
      if (new Date(normalizedStartDate).getTime() > new Date(normalizedEndDate).getTime()) {
        return response.status(400).json({ error: 'endDate must be greater than or equal to startDate' })
      }
    }

    const updates = {
      title: normalizeText(request.body.title),
      detail: normalizeText(request.body.detail),
      description: normalizeText(request.body.description),
      type: normalizeText(request.body.type),
      image: normalizeText(request.body.image),
      startDate: request.body.startDate,
      endDate: request.body.endDate,
    }

    const fields = []
    const values = []

    if ('title' in request.body) {
      if (!updates.title) return response.status(400).json({ error: 'Title cannot be empty' })
      fields.push(`title = $${values.length + 1}`)
      values.push(updates.title)
    }
    if ('detail' in request.body) {
      if (!updates.detail) return response.status(400).json({ error: 'Detail cannot be empty' })
      fields.push(`detail = $${values.length + 1}`)
      values.push(updates.detail)
    }
    if ('description' in request.body) {
      if (!updates.description) return response.status(400).json({ error: 'Description cannot be empty' })
      fields.push(`description = $${values.length + 1}`)
      values.push(updates.description)
    }
    if ('type' in request.body) {
      fields.push(`type = $${values.length + 1}`)
      values.push(updates.type || 'general')
    }
    if ('image' in request.body) {
      fields.push(`image = $${values.length + 1}`)
      values.push(updates.image || null)
    }
    if ('startDate' in request.body) {
      const normalizedStartDate = parseOptionalDate(updates.startDate)
      if (request.body.startDate && !normalizedStartDate) return response.status(400).json({ error: 'Invalid startDate format' })
      fields.push(`start_date = $${values.length + 1}`)
      values.push(normalizedStartDate)
    }
    if ('endDate' in request.body) {
      const normalizedEndDate = parseOptionalDate(updates.endDate)
      if (request.body.endDate && !normalizedEndDate) return response.status(400).json({ error: 'Invalid endDate format' })
      fields.push(`end_date = $${values.length + 1}`)
      values.push(normalizedEndDate)
    }

    if (fields.length === 0) return response.status(400).json({ error: 'No announcement fields were provided for update' })

    values.push(user.phone)
    values.push(request.params.id)
    const { rows } = await query(
      `UPDATE announcements
       SET ${fields.join(', ')}, updated_by = $${values.length - 1}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING id, title, detail, description, type, image, start_date AS "startDate", end_date AS "endDate", created_at AS "createdAt", updated_at AS "updatedAt"`,
      values,
    )
    if (!rows[0]) return response.status(404).json({ error: 'Announcement not found' })

    response.json({ data: { ...rows[0], image: publicImageUrl(request, rows[0].image) } })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/admin/announcements/:id', async (request, response, next) => {
  try {
    await ensureSchema()
    const user = await requireAdmin(request, response)
    if (!user) return

    const { rows } = await query('DELETE FROM announcements WHERE id = $1 RETURNING id', [request.params.id])
    if (!rows[0]) return response.status(404).json({ error: 'Announcement not found' })
    response.json({ success: true })
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
        (SELECT COUNT(*)::int FROM users WHERE role IN ('admin', 'super_admin') OR is_super_admin = TRUE) AS super_admins,
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