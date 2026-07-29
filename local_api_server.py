from __future__ import annotations

import json
import sqlite3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / 'data' / 'drive-audit-map.db'
FILELIST_PATH = ROOT / 'data' / 'filelist.txt'
TREE_JSON_PATH = ROOT / 'data' / 'tree_d3.json'
GRAPH_JSON_PATH = ROOT / 'data' / 'graph_nodes_edges.json'
ROOT_BASE_PATH = 'C:\\USERS\\JRH345\\BOX\\CON-NTC'


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

    def _read_tree_rows_from_tree_json(self) -> list[dict]:
        if not TREE_JSON_PATH.exists():
            return []

        data = json.loads(TREE_JSON_PATH.read_text(encoding='utf-8'))
        rows: list[dict] = []

        def join_path(parts: list[str]) -> str:
            filtered_parts = [part for part in parts if part]
            if not filtered_parts:
                return ROOT_BASE_PATH
            return str(Path(ROOT_BASE_PATH, *filtered_parts))

        def walk(node: dict, ancestor_labels: list[str]) -> None:
            if not isinstance(node, dict):
                return

            label = str(node.get('name') or '').strip()
            if not label:
                return

            next_labels = ancestor_labels + [label]
            if ancestor_labels:
                path_key = '/'.join(next_labels)
                is_software_articulate = path_key == 'CON-NTC/NTC/Software/Articulate'
                has_children = bool(node.get('children'))
                is_folder = has_children or is_software_articulate
                rows.append(
                    {
                        'Full Path': join_path(next_labels),
                        'Type': 'folder' if is_folder else 'file',
                        'Name': label,
                        'Extension': '' if is_folder else Path(label).suffix.lstrip('.'),
                        'Parent Folder': join_path(ancestor_labels),
                        'Top-Level Folder': next_labels[0] if next_labels else '',
                        'Depth': str(len(ancestor_labels)),
                    }
                )

            for child in node.get('children', []) or []:
                walk(child, next_labels)

        walk(data, [])
        rows.sort(key=lambda row: row['Full Path'])
        return rows

    def _read_tree_rows_from_filelist(self) -> list[dict]:
        if not FILELIST_PATH.exists():
            return []

        lines = [line.strip().rstrip('\\/') for line in FILELIST_PATH.read_text(encoding='utf-8').splitlines()]
        paths = sorted({line.replace('/', '\\') for line in lines if line})
        if not paths:
            return []

        def split_segments(full_path: str) -> list[str]:
            drive, tail = full_path[:2], full_path[2:]
            if not drive.endswith(':'):
                drive = ''
                tail = full_path
            tail = tail.lstrip('\\')
            return [segment for segment in tail.split('\\') if segment]

        split_paths = [split_segments(path_value) for path_value in paths]
        min_length = min(len(segments) for segments in split_paths)
        prefix_len = 0
        while prefix_len < min_length:
            token = split_paths[0][prefix_len]
            if not all(segments[prefix_len] == token for segments in split_paths):
                break
            prefix_len += 1

        path_set = set(paths)
        folder_set = set()
        for full_path in paths:
            parent = str(Path(full_path).parent)
            if parent in path_set:
                folder_set.add(parent)

        rows = []
        for full_path in paths:
            segments = split_segments(full_path)
            if len(segments) <= prefix_len:
                continue

            relative_segments = segments[prefix_len:]
            if not relative_segments:
                continue

            name = relative_segments[-1]
            is_folder = full_path in folder_set
            rows.append(
                {
                    'Full Path': full_path,
                    'Type': 'folder' if is_folder else 'file',
                    'Name': name,
                    'Extension': '' if is_folder else Path(name).suffix.lstrip('.'),
                    'Parent Folder': str(Path(full_path).parent),
                    'Top-Level Folder': relative_segments[0],
                    'Depth': str(len(relative_segments)),
                }
            )

        rows.sort(key=lambda row: row['Full Path'])
        return rows

    def _read_tree_rows_from_graph_json(self) -> list[dict]:
        if not GRAPH_JSON_PATH.exists():
            return []

        data = json.loads(GRAPH_JSON_PATH.read_text(encoding='utf-8'))
        nodes = data.get('nodes') if isinstance(data, dict) else None
        edges = data.get('edges') if isinstance(data, dict) else None

        if not isinstance(nodes, list) or not nodes:
            return []

        node_map = {}
        children_map = {}
        incoming_counts = {}

        for node in nodes:
            if not isinstance(node, dict) or 'id' not in node:
                continue

            node_id = node['id']
            node_map[node_id] = node
            incoming_counts[node_id] = 0

        if isinstance(edges, list):
            for edge in edges:
                if not isinstance(edge, dict):
                    continue

                source = edge.get('from')
                target = edge.get('to')
                if source not in node_map or target not in node_map:
                    continue

                children_map.setdefault(source, []).append(target)
                incoming_counts[target] = incoming_counts.get(target, 0) + 1

        root_node = next((node for node in nodes if incoming_counts.get(node.get('id'), 0) == 0), nodes[0])
        rows = []

        def join_path(parts: list[str]) -> str:
            filtered_parts = [part for part in parts if part]
            if not filtered_parts:
                return ROOT_BASE_PATH
            return str(Path(ROOT_BASE_PATH, *filtered_parts))

        def walk(node_id, ancestor_labels: list[str]) -> None:
            node = node_map.get(node_id)
            if not node:
                return

            label = str(node.get('label') or '').strip()
            if not label:
                return

            next_labels = ancestor_labels + [label]
            if node_id != root_node.get('id'):
                item_type = str(node.get('type') or '').strip().lower()
                path_key = '/'.join(next_labels)
                is_software_articulate = path_key == 'CON-NTC/NTC/Software/Articulate'
                is_folder = item_type == 'folder' or bool(children_map.get(node_id)) or is_software_articulate
                extension = '' if is_folder else Path(label).suffix.lstrip('.')
                full_path = join_path(next_labels)
                parent_folder = join_path(ancestor_labels)
                depth = node.get('depth')
                rows.append(
                    {
                        'Full Path': full_path,
                        'Type': item_type,
                        'Name': label,
                        'Extension': extension,
                        'Parent Folder': parent_folder,
                        'Top-Level Folder': next_labels[0] if next_labels else '',
                        'Depth': str(depth if isinstance(depth, int) else len(next_labels) - 1),
                    }
                )

            for child_id in children_map.get(node_id, []):
                walk(child_id, next_labels)

        for child_id in children_map.get(root_node.get('id'), []):
            walk(child_id, [])

        rows.sort(key=lambda row: row['Full Path'])
        return rows

    def _read_tree_rows(self) -> list[dict]:
        filelist_rows = self._read_tree_rows_from_filelist()
        if filelist_rows:
            return filelist_rows

        tree_rows = self._read_tree_rows_from_tree_json()
        if tree_rows:
            return tree_rows

        graph_rows = self._read_tree_rows_from_graph_json()
        if graph_rows:
            return graph_rows

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
                    'source': str(
                        FILELIST_PATH
                        if FILELIST_PATH.exists()
                        else (
                            TREE_JSON_PATH
                            if TREE_JSON_PATH.exists()
                            else (GRAPH_JSON_PATH if GRAPH_JSON_PATH.exists() else DB_PATH)
                        )
                    ),
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
