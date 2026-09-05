# Mana Kandukur API

Set up PostgreSQL, create an empty `mana_kandukur` database, then copy `.env.local.example` to `.env.local` and set `DATABASE_URL` for your local PostgreSQL username and password. `.env.local` takes precedence over `.env`, so the production database configuration remains unchanged. Configure Azure Blob Storage with `AZURE_STORAGE_CONNECTION_STRING` and optionally `AZURE_STORAGE_CONTAINER_NAME` (defaults to `images`). Run `npm run dev`; the service creates its tables automatically.

Admin uploads are stored in a private Azure Blob container. The API proxies `/images/...` requests to Blob Storage, so the container does not need anonymous public access. After configuring Blob Storage, run `npm run migrate-images` once from this directory to upload the existing backend and mobile image folders and update matching PostgreSQL image references. Add `-- --delete-local` only after verifying the migration to remove backend local copies. Mobile image files are retained because the Expo app imports them directly.

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

Cricket integration uses Cricwix through the backend. Set `CRICWIX_API_KEY` in the backend environment; do not expose it as an Expo/mobile variable. The mobile app uses these routes:

- `GET /api/cricket/matches` returns normalized live, yesterday, today, and upcoming matches. Optional `from` and `to` query parameters use `YYYY-MM-DD` and are limited to a 31-day range.
- `GET /api/cricket/matches/:id` returns normalized match details with live data and the provider scorecard when available.
- `GET /api/cricket/live/:id` returns Cricwix live match details and ball-by-ball data.
- `GET /api/cricket/scorecards/:id` returns the Cricwix match scorecard.

The response metadata reports whether Cricwix returned live ball-by-ball data. The Cricwix API key is only used by the backend.