const { FILELIST_PATH, readRowsFromFilelist } = require('../lib/filelist-tree-data');
const { GRAPH_JSON_PATH, TREE_JSON_PATH, readRowsFromGraphJson, readRowsFromTreeJson } = require('../lib/json-tree-data');
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
    const filelistRows = readRowsFromFilelist();
    if (filelistRows.length > 0) {
      sendJson(res, 200, {
        rows: filelistRows,
        rowCount: filelistRows.length,
        source: FILELIST_PATH,
      });
      return;
    }

    const treeRows = readRowsFromTreeJson();
    if (treeRows.length > 0) {
      sendJson(res, 200, {
        rows: treeRows,
        rowCount: treeRows.length,
        source: TREE_JSON_PATH,
      });
      return;
    }

    const graphRows = readRowsFromGraphJson();
    if (graphRows.length > 0) {
      sendJson(res, 200, {
        rows: graphRows,
        rowCount: graphRows.length,
        source: GRAPH_JSON_PATH,
      });
      return;
    }

    const fallbackRows = readRowsFromSqlite();
    sendJson(res, 200, {
      rows: fallbackRows,
      rowCount: fallbackRows.length,
      source: DB_PATH,
    });
  } catch (error) {
    sendJson(res, 500, {
      error: error?.message || 'Failed to read SQLite data',
    });
  }
};
