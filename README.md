# Cloud Drive Audit Map

This project is a static browser-based map for reviewing a cloud drive snapshot.

## Frontend hosting

The UI can be hosted on GitHub Pages because it is a plain HTML/CSS/JS app.

## Shared state

The app can persist shared state through either:

- a backend API at `/api/map-state` and `/api/statuses`, or
- a Supabase table named `shared_map_state` when you define the following globals before the app loads:

```html
<script>
  window.DRIVE_AUDIT_SUPABASE_URL = 'https://YOUR_PROJECT_REF.supabase.co';
  window.DRIVE_AUDIT_SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
</script>
<script src="shared-storage.js"></script>
```

For full team sharing, the frontend can also point to a publicly hosted backend endpoint:

```html
<script>
  window.DRIVE_AUDIT_API_URL = 'https://your-shared-api.example.com/api';
</script>
```

Or, if you host the frontend through GitHub Pages and the API through another service, set that URL before the app script loads.

## Local development

```bash
npm run dev
```

`npm run dev` starts a Python local API server that serves both static files and `/api/tree-data` from SQLite.

Node-based local server is still available if needed:

```bash
npm run dev:node
```

Optional static-only mode (no API routes):

```bash
npm run dev:static
```

## SQLite data source

The map is now loaded from SQLite through `GET /api/tree-data`.

Default database path:

- `data/drive-audit-map.db`

To seed the database from the included CSV sample:

```bash
python scripts/import_csv_to_sqlite.py
```

You can also provide custom paths:

```bash
python scripts/import_csv_to_sqlite.py --csv "C:\path\to\inventory.csv" --db "data\drive-audit-map.db"
```

CSV to SQLite mapping used by the importer:

- `Full Path` -> `drive_items.full_path`
- `Type` -> `drive_items.type`
- `Name` -> `drive_items.name`
- `Extension` -> `drive_items.extension`
- `Parent Folder` -> `drive_items.parent_folder`
- `Top-Level Folder` -> `drive_items.top_level_folder`
- `Depth` -> `drive_items.depth`

Then run:

```bash
npm run dev
```

The app now loads rows from SQLite automatically on startup.

## Shared status writes (WAL)

Status updates are persisted in SQLite table `node_statuses` and both local API endpoints read/write that table:

- `PUT /api/statuses`
- `PUT /api/map-state`

The server enables:

- `PRAGMA journal_mode = WAL`
- `PRAGMA synchronous = NORMAL`
- `PRAGMA busy_timeout = 5000`

This allows multiple clients to read while others write, as long as they hit the same server process and database file.

Important hosting note:

- Vercel serverless functions do not provide a durable shared writable filesystem for team-wide SQLite writes.
- For true shared team writes, host this API on a persistent server/VM/container (or switch to a managed database like Postgres/Supabase).

## Guaranteed shared team writes

For guaranteed shared writes across clients, configure Supabase and use it as the status source of truth.

1. Create table in Supabase:

```sql
create table if not exists shared_map_state (
  id text primary key,
  statuses jsonb not null default '{}'::jsonb,
  rows jsonb not null default '[]'::jsonb
);

insert into shared_map_state (id, statuses, rows)
values ('default', '{}'::jsonb, '[]'::jsonb)
on conflict (id) do nothing;
```

2. Configure runtime values in `config.js`:

```js
window.DRIVE_AUDIT_SUPABASE_URL = 'https://YOUR_PROJECT_REF.supabase.co';
window.DRIVE_AUDIT_SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```

3. Deploy and ensure all clients use the same deployed app URL.

When configured, status writes/reads are persisted via Supabase and reflected across clients.

## Deployment summary

1. Push this repo to GitHub.
2. Enable GitHub Pages for the repository.
3. Host the shared status API on a separate public service.
4. Set `window.DRIVE_AUDIT_API_URL` to the shared API URL.

## Vercel notes

If you deploy this repository on Vercel:

- Set the Vercel project Root Directory to the repository root (not `api`).
- Keep the checked-in `vercel.json` file; it uses explicit `builds` and `routes` for static frontend + `/api` functions.
- Keep `api/map-state.js`, `api/statuses.js`, `api/store.js`, and `api/tree-data.js` under `api/`.

Expected artifact shape for this repo on Vercel:

- Static output for `/` (HTML page)
- Serverless functions for `/api/map-state`, `/api/statuses`, and `/api/tree-data`

## Vercel clean redeploy checklist

Use this when Vercel serves an empty root page or reports a single API artifact at `/`.

1. In Vercel Project Settings -> General:
  - Root Directory: repository root (leave blank if the repo root is selected)
  - Framework Preset: Other
  - Build Command: empty
  - Output Directory: empty
  - Install Command: default
2. In Vercel Project Settings -> Git:
  - Confirm Production Branch is `master` for this repository.
3. In Vercel Deployments:
  - Trigger Redeploy from the latest commit on `master`.
  - Use "Redeploy without cache" once.
4. In Vercel Functions / Build Output:
  - Confirm there is no single root API function at `/`.
  - Confirm only API functions for `/api/map-state` and `/api/statuses`.
5. In browser Network tab on the deployed URL:
  - `GET /` returns non-empty HTML (response preview contains `<html` and app markup).
  - `GET /client-app.js` returns JavaScript, not HTML fallback.
  - `GET /shared-storage.js` returns JavaScript.
  - `GET /api/map-state` returns JSON.

If step 4 fails and you still see one API artifact at `/`, the project root is still mis-targeted in Vercel settings.
