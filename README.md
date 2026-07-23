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
python -m http.server 8001
```

Or use the included Node server if Node is available in your environment:

```bash
node local-server.js
```

## Deployment summary

1. Push this repo to GitHub.
2. Enable GitHub Pages for the repository.
3. Host the shared status API on a separate public service.
4. Set `window.DRIVE_AUDIT_API_URL` to the shared API URL.

## Vercel notes

If you deploy this repository on Vercel:

- Set the Vercel project Root Directory to the repository root (not `api`).
- Keep the checked-in `vercel.json` file; it explicitly marks this as static frontend plus `/api` functions.
- Keep only `api/map-state.js`, `api/statuses.js`, and `api/store.js` under `api/`.

Expected artifact shape for this repo on Vercel:

- Static output for `/` (HTML page)
- Serverless functions for `/api/map-state` and `/api/statuses`

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
