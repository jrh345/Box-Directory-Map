from __future__ import annotations

import json
import sqlite3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / 'data' / 'drive-audit-map.db'
STORE_PATH = ROOT / 'status-store.json'


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

    def _load_store(self) -> dict:
        if not STORE_PATH.exists():
            return {}
        try:
            return json.loads(STORE_PATH.read_text(encoding='utf-8'))
        except Exception:
            return {}

    def _save_store(self, payload: dict) -> None:
        STORE_PATH.write_text(json.dumps(payload, indent=2), encoding='utf-8')

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
            self._send_json(200, self._load_store())
            return

        if parsed.path == '/api/map-state':
            self._send_json(200, self._load_store())
            return

        super().do_GET()

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in ('/api/statuses', '/api/map-state'):
            payload = self._read_json_body()
            statuses = payload.get('statuses') if isinstance(payload, dict) else {}
            rows = payload.get('rows') if isinstance(payload, dict) else []
            if not isinstance(statuses, dict):
                statuses = {}
            if not isinstance(rows, list):
                rows = []
            next_payload = {'statuses': statuses, 'rows': rows}
            self._save_store(next_payload)
            self._send_json(200, next_payload)
            return

        self._send_json(405, {'error': 'Method not allowed'})


def main() -> None:
    server = ThreadingHTTPServer(('127.0.0.1', 8000), DriveAuditHandler)
    print('Drive audit local API server running at http://127.0.0.1:8000')
    server.serve_forever()


if __name__ == '__main__':
    main()
