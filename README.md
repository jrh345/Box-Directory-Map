# Cloud Drive Audit Map

This project is a static browser-based map for reviewing a cloud drive snapshot.

## Frontend hosting

The UI can be hosted on GitHub Pages because it is a plain HTML/CSS/JS app.

## Shared state

The app is wired to read and write status data through a JSON API at `/api/statuses`.

For full team sharing, the frontend should point to a publicly hosted backend endpoint, for example:

```html
<script>
  window.DRIVE_AUDIT_API_URL = 'https://your-shared-api.example.com/api/statuses';
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
