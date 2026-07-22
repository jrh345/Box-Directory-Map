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
node server.js
```

## Deployment summary

1. Push this repo to GitHub.
2. Enable GitHub Pages for the repository.
3. Host the shared status API on a separate public service.
4. Set `window.DRIVE_AUDIT_API_URL` to the shared API URL.
