import dotenv from 'dotenv'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureBlobContainer, uploadBlob } from './blobStorage.js'
import { ensureSchema, query } from './database.js'

dotenv.config({ path: '.env.local' })
dotenv.config()

const backendDirectory = path.dirname(fileURLToPath(import.meta.url))
const imageDirectory = path.resolve(backendDirectory, '../images')
const mobileImageDirectory = path.resolve(backendDirectory, '../../kandukur-mobile/src/images')
const deleteLocalImages = process.argv.includes('--delete-local')

function imagePathFor(relativePath) {
  return `/images/${relativePath.split(path.sep).join('/')}`
}

function normalizeImagePath(value) {
  if (!value || typeof value !== 'string') return value
  try {
    const parsed = new URL(value)
    return parsed.pathname.startsWith('/images/') ? parsed.pathname : value
  } catch {
    return value
  }
}

async function getImageFiles(directory, prefix = '') {
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name)
    if (entry.isDirectory()) {
      files.push(...await getImageFiles(path.join(directory, entry.name), relativePath))
    } else if (entry.isFile()) {
      files.push(relativePath)
    }
  }
  return files
}

async function migrate() {
  await ensureBlobContainer()
  await ensureSchema()

  const backendFiles = await getImageFiles(imageDirectory)
  const mobileFiles = await getImageFiles(mobileImageDirectory)
  const files = [
    ...backendFiles.map((relativePath) => ({ directory: imageDirectory, relativePath })),
    ...mobileFiles.map((relativePath) => ({ directory: mobileImageDirectory, relativePath })),
  ]
  const imagePaths = new Map()
  for (const { directory, relativePath } of files) {
    const blobName = relativePath.split(path.sep).join('/')
    const file = await fs.readFile(path.join(directory, relativePath))
    const extension = path.extname(relativePath).toLowerCase()
    const contentType = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : extension === '.jpeg' || extension === '.jpg' ? 'image/jpeg' : undefined
    await uploadBlob(blobName, file, contentType)
    imagePaths.set(imagePathFor(relativePath), imagePathFor(relativePath))
    console.log(`Uploaded ${directory === mobileImageDirectory ? 'mobile/' : ''}${relativePath}`)
  }

  const businesses = await query('SELECT id, image, gallery FROM businesses')
  for (const business of businesses.rows) {
    const image = imagePaths.get(normalizeImagePath(business.image)) || business.image
    const gallery = (business.gallery || []).map((item) => imagePaths.get(normalizeImagePath(item)) || item)
    if (image !== business.image || JSON.stringify(gallery) !== JSON.stringify(business.gallery || [])) {
      await query('UPDATE businesses SET image = $1, gallery = $2::jsonb WHERE id = $3', [image, JSON.stringify(gallery), business.id])
    }
  }

  const announcements = await query('SELECT id, image FROM announcements')
  for (const announcement of announcements.rows) {
    const image = imagePaths.get(normalizeImagePath(announcement.image)) || announcement.image
    if (image !== announcement.image) {
      await query('UPDATE announcements SET image = $1 WHERE id = $2', [image, announcement.id])
    }
  }

  if (deleteLocalImages) {
    for (const { directory, relativePath } of files) {
      if (directory === imageDirectory) await fs.unlink(path.join(directory, relativePath))
    }
    console.log(`Migrated ${files.length} image files, updated database references, and deleted backend local copies.`)
  } else {
    console.log(`Migrated ${files.length} image files and updated database references. Local copies were kept.`)
  }
}

migrate().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
