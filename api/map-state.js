const { getState, setMapState } = require('./store');

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === 'GET') {
    sendJson(res, 200, getState());
    return;
  }

  if (req.method === 'PUT') {
    try {
      const payload = await readJsonBody(req);
      const next = setMapState(payload || {});
      sendJson(res, 200, next);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
    }
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
};
