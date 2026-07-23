const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'drive-audit-map.db');

function readRowsFromSqlite() {
  if (!fs.existsSync(DB_PATH)) {
    return [];
  }

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error('node:sqlite is unavailable in this runtime');
  }

  const db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
  try {
    const statement = db.prepare(`
      SELECT
        full_path,
        type,
        name,
        extension,
        parent_folder,
        top_level_folder,
        depth
      FROM drive_items
      ORDER BY full_path
    `);

    return statement.all().map((row) => ({
      'Full Path': row.full_path || '',
      Type: row.type || '',
      Name: row.name || '',
      Extension: row.extension || '',
      'Parent Folder': row.parent_folder || '',
      'Top-Level Folder': row.top_level_folder || '',
      Depth: row.depth != null ? String(row.depth) : '',
    }));
  } finally {
    db.close();
  }
}

module.exports = {
  DB_PATH,
  readRowsFromSqlite,
};
