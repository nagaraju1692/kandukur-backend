import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { ensureSchema, query } from './database.js'

const backendDirectory = path.dirname(fileURLToPath(import.meta.url))
const workspaceDirectory = path.resolve(backendDirectory, '../..')

async function loadLocalData() {
  const sourcePath = path.join(workspaceDirectory, 'mobile/src/data/localData.ts')
  const source = await readFile(sourcePath, 'utf8')
  const imageDeclarations = [...source.matchAll(/import\s+(\w+)\s+from\s+'\.\.\/images\/([^']+)'/g)]
    .map(([, name, fileName]) => `const ${name} = '/images/${fileName}'`)
    .join('\n')
  const executable = source
    .replace(/^import .*$/gm, '')
    .replace('export const categories =', 'globalThis.categories =')
    .replace('export const businesses =', 'globalThis.businesses =')
  const context = { globalThis: {} }
  vm.runInNewContext(`${imageDeclarations}\n${executable}`, context)
  return context.globalThis
}

const businessCoordinates = {
  'trr-government-degree-college': { latitude: 15.2084, longitude: 79.8982 },
  'gayatri-degree-college-kandukur': { latitude: 15.2278, longitude: 79.9186 },
}

const announcements = [
  { id: 'movie-raghava-premiere', type: 'Movie', title: 'New movie at Raghava Multiplex', detail: 'Opening this Friday · Raghava Multiplex, Kandukur', description: 'Book your seats for the new Telugu movie releasing this Friday at Raghava Multiplex. Show timings and ticket availability will be updated by the theatre.', image: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=600&q=80' },
  { id: 'movie-yuvaraj-show', type: 'Movie', title: 'New show at Yuvraj Theatre', detail: 'Coming soon · Yuvraj Theatre, Kandukur', description: 'A new show is coming soon to Yuvraj Theatre. Check back for show timings and ticket availability.', image: 'https://images.unsplash.com/photo-1503095396549-807530d5d4b7?auto=format&fit=crop&w=600&q=80' },
  { id: 'shop-fresh-mart', type: 'Shop', title: 'Fresh Mart opening soon', detail: 'Opening next week · Market Road, Kandukur', description: 'Fresh Mart is opening soon with daily essentials, groceries, and household supplies for families around Kandukur.', image: 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=600&q=80' },
  { id: 'shop-style-studio', type: 'Shop', title: 'New Style Studio opening', detail: 'Opening this month · Pamuru Road, Kandukur', description: 'Style Studio will offer clothing, accessories, and seasonal collections from its new Pamuru Road location in Kandukur.', image: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=600&q=80' },
]

const { categories, businesses } = await loadLocalData()
await ensureSchema()

for (const category of categories) {
  await query('INSERT INTO categories (id, name, parent_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id', [category.id, category.name, category.parentId])
}

for (const business of businesses) {
  const coordinates = businessCoordinates[business.id]
  await query(
    'INSERT INTO businesses (id, name, category_id, category_name, address, latitude, longitude, phone, website, description, image, gallery) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, category_id = EXCLUDED.category_id, category_name = EXCLUDED.category_name, address = EXCLUDED.address, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, phone = EXCLUDED.phone, website = EXCLUDED.website, description = EXCLUDED.description, image = EXCLUDED.image, gallery = EXCLUDED.gallery',
    [business.id, business.name, business.categoryId, business.categoryName, business.address, coordinates?.latitude ?? null, coordinates?.longitude ?? null, business.phone ?? null, business.website ?? null, business.description ?? null, business.image ?? null, JSON.stringify(business.gallery ?? [])],
  )
}

for (const announcement of announcements) {
  await query('INSERT INTO announcements (id, title, detail, description, type, image) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, detail = EXCLUDED.detail, description = EXCLUDED.description, type = EXCLUDED.type, image = EXCLUDED.image', [announcement.id, announcement.title, announcement.detail, announcement.description, announcement.type, announcement.image])
}

console.log(`Seeded ${categories.length} categories, ${businesses.length} businesses, and ${announcements.length} announcements.`)