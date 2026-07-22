const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const STORE_FILE = path.join(ROOT_DIR, 'status-store.json');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

function ensureStoreFile() {
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, '{}', 'utf8');
  }
}

function readStore() {
  ensureStoreFile();
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(data) {
  ensureStoreFile();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function normalizeStatusPayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.statuses && typeof payload.statuses === 'object' && !Array.isArray(payload.statuses)) {
      return payload.statuses;
    }

    return payload;
  }

  return {};
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
}

function serveStaticFile(res, filePath) {
  const resolvedPath = path.resolve(ROOT_DIR, filePath);
  if (!resolvedPath.startsWith(ROOT_DIR)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  fs.readFile(resolvedPath, (error, data) => {
    if (error) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/statuses') {
    if (req.method === 'GET') {
      sendJson(res, 200, readStore());
      return;
    }

    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          const normalizedStatuses = normalizeStatusPayload(payload);
          if (Object.keys(normalizedStatuses).length >= 0) {
            writeStore({ statuses: normalizedStatuses });
            sendJson(res, 200, readStore());
            return;
          }
          sendJson(res, 400, { error: 'Expected a JSON object' });
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON body' });
        }
      });
      return;
    }

    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {});
      return;
    }
  }

  if (url.pathname === '/api/map-state') {
    if (req.method === 'GET') {
      sendJson(res, 200, readStore());
      return;
    }

    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          const normalizedStatuses = normalizeStatusPayload(payload);
          const rows = Array.isArray(payload?.rows) ? payload.rows : [];
          writeStore({ statuses: normalizedStatuses, rows });
          sendJson(res, 200, readStore());
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON body' });
        }
      });
      return;
    }

    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {});
      return;
    }
  }

  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  if (filePath.startsWith('/')) filePath = filePath.slice(1);

  serveStaticFile(res, filePath);
});

  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`Drive audit map server running at http://localhost:${PORT}`);
  });
}

module.exports = createServer;
