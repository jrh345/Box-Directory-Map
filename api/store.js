const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'drive-audit-map.db');

function withDatabase(callback) {
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_statuses (
        node_path TEXT PRIMARY KEY,
        status TEXT NOT NULL
      )
    `);
    return callback(db);
  } finally {
    db.close();
  }
}

function normalizeStatuses(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.statuses && typeof payload.statuses === 'object' && !Array.isArray(payload.statuses)) {
      return payload.statuses;
    }
    return payload;
  }
  return {};
}

function getState() {
  const rows = withDatabase((db) => {
    const query = db.prepare('SELECT node_path, status FROM node_statuses ORDER BY node_path');
    return query.all();
  });

  const statuses = {};
  rows.forEach((row) => {
    statuses[row.node_path] = row.status;
  });

  return { statuses };
}

function setStatuses(payload) {
  const nextStatuses = normalizeStatuses(payload);
  withDatabase((db) => {
    db.exec('BEGIN IMMEDIATE TRANSACTION;');
    try {
      db.exec('DELETE FROM node_statuses;');
      const insert = db.prepare('INSERT INTO node_statuses (node_path, status) VALUES (?, ?)');
      Object.entries(nextStatuses).forEach(([nodePath, status]) => {
        insert.run(nodePath, status || 'none');
      });
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  });

  return { statuses: nextStatuses };
}

function setMapState(payload) {
  return setStatuses(payload);
}

module.exports = {
  getState,
  setStatuses,
  setMapState,
};
