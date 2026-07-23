const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
};

function sendText(res, statusCode, body, contentType) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', contentType);
  res.end(body);
}

module.exports = (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(__dirname, '..', pathname.replace(/^\//, ''));
  const extension = path.extname(filePath).toLowerCase();
  const safePath = path.resolve(filePath);
  const projectRoot = path.resolve(__dirname, '..');

  if (!safePath.startsWith(projectRoot)) {
    sendText(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    return;
  }

  if (!fs.existsSync(safePath)) {
    sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8');
    return;
  }

  const contentType = MIME_TYPES[extension] || 'application/octet-stream';
  const body = fs.readFileSync(safePath);
  sendText(res, 200, body, contentType);
};
