const { readRowsFromSqlite, DB_PATH } = require('../lib/sqlite-tree-data');

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const rows = readRowsFromSqlite();
    sendJson(res, 200, {
      rows,
      rowCount: rows.length,
      source: DB_PATH,
    });
  } catch (error) {
    sendJson(res, 500, {
      error: error?.message || 'Failed to read SQLite data',
    });
  }
};
