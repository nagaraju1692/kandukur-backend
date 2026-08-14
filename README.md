# Mana Kandukur API

Set up PostgreSQL, create an empty `mana_kandukur` database, then copy `.env.example` to `.env` and set `DATABASE_URL`. Run `npm run dev`; the service creates its tables automatically.

To migrate the current mobile directory content into PostgreSQL, run `npm run seed` once. The command can be safely run again to update the imported records.

All core tables include `created_by`, `created_at`, `updated_by`, and `updated_at` audit fields. User favorites are stored in the `favorites` table using the user's mobile number and business ID as its primary key.

Ratings and review comments are stored in `reviews`, including the business ID, reviewing user's mobile number, and audit fields. Reviews are loaded from the API whenever the mobile app starts.

Feedback and complaint messages are stored in `feedback_submissions`, including the sender's mobile number and audit fields.

Store image and gallery values as public HTTPS URLs. The API uses `categories`, `businesses`, and `announcements` tables. Required response shapes:

```json
{ "id": "1", "name": "Education", "parentId": null }
```

```json
{ "id": "c1", "name": "Business name", "categoryId": "1", "categoryName": "Education", "address": "Kandukur", "phone": "", "website": "", "description": "", "image": "https://...", "gallery": ["https://..."] }
```

```json
{ "id": "announcement-1", "title": "", "detail": "", "description": "", "type": "Movie", "image": "https://..." }
```