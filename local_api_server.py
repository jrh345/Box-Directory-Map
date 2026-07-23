from __future__ import annotations

import json
import sqlite3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / 'data' / 'drive-audit-map.db'


class DriveAuditHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def _read_json_body(self) -> dict:
        length = int(self.headers.get('Content-Length', '0'))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        return json.loads(raw.decode('utf-8'))

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _connect_db(self) -> sqlite3.Connection:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=5)
        conn.execute('PRAGMA journal_mode = WAL')
        conn.execute('PRAGMA synchronous = NORMAL')
        conn.execute('PRAGMA busy_timeout = 5000')
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS node_statuses (
              node_path TEXT PRIMARY KEY,
              status TEXT NOT NULL
            )
            '''
        )
        return conn

    def _read_statuses(self) -> dict:
        conn = self._connect_db()
        try:
            cursor = conn.cursor()
            cursor.execute('SELECT node_path, status FROM node_statuses ORDER BY node_path')
            rows = cursor.fetchall()
            return {node_path: status for node_path, status in rows}
        finally:
            conn.close()

    def _write_statuses(self, statuses: dict) -> dict:
        conn = self._connect_db()
        try:
            cursor = conn.cursor()
            cursor.execute('BEGIN IMMEDIATE')
            cursor.execute('DELETE FROM node_statuses')
            cursor.executemany(
                'INSERT INTO node_statuses (node_path, status) VALUES (?, ?)',
                [(node_path, status or 'none') for node_path, status in statuses.items()],
            )
            conn.commit()
            return statuses
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _read_tree_rows(self) -> list[dict]:
        if not DB_PATH.exists():
            return []

        conn = sqlite3.connect(DB_PATH)
        try:
            cursor = conn.cursor()
            cursor.execute(
                '''
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
                '''
            )
            rows = []
            for (
                full_path,
                item_type,
                name,
                extension,
                parent_folder,
                top_level_folder,
                depth,
            ) in cursor.fetchall():
                rows.append(
                    {
                        'Full Path': full_path or '',
                        'Type': item_type or '',
                        'Name': name or '',
                        'Extension': extension or '',
                        'Parent Folder': parent_folder or '',
                        'Top-Level Folder': top_level_folder or '',
                        'Depth': str(depth if depth is not None else ''),
                    }
                )
            return rows
        finally:
            conn.close()

    def do_OPTIONS(self) -> None:
        self._send_json(204, {})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        statuses = self._read_statuses()

        if parsed.path == '/api/tree-data':
            rows = self._read_tree_rows()
            self._send_json(
                200,
                {
                    'rows': rows,
                    'rowCount': len(rows),
                    'source': str(DB_PATH),
                },
            )
            return

        if parsed.path == '/api/statuses':
            self._send_json(200, {'statuses': statuses})
            return

        if parsed.path == '/api/map-state':
            rows = self._read_tree_rows()
            self._send_json(200, {'statuses': statuses, 'rows': rows})
            return

        super().do_GET()

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in ('/api/statuses', '/api/map-state'):
            payload = self._read_json_body()
            statuses = payload.get('statuses') if isinstance(payload, dict) else {}
            if not isinstance(statuses, dict):
                statuses = {}

            next_statuses = self._write_statuses(statuses)
            if parsed.path == '/api/map-state':
                rows = self._read_tree_rows()
                self._send_json(200, {'statuses': next_statuses, 'rows': rows})
            else:
                self._send_json(200, {'statuses': next_statuses})
            return

        self._send_json(405, {'error': 'Method not allowed'})


def main() -> None:
    server = ThreadingHTTPServer(('127.0.0.1', 8000), DriveAuditHandler)
    print('Drive audit local API server running at http://127.0.0.1:8000')
    server.serve_forever()


if __name__ == '__main__':
    main()
