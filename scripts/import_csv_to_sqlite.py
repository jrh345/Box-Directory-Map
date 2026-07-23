import csv
import sqlite3
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSV_PATH = ROOT / 'tmp-mini-tree.csv'
DB_DIR = ROOT / 'data'
DB_PATH = DB_DIR / 'drive-audit-map.db'
REQUIRED_HEADERS = [
    'Full Path',
    'Type',
    'Name',
    'Extension',
    'Parent Folder',
    'Top-Level Folder',
    'Depth',
]


def normalize_header(value: str) -> str:
    return (value or '').replace('\ufeff', '').strip().lower()


def read_value(row: dict, aliases: list[str]) -> str:
    normalized_aliases = {normalize_header(alias) for alias in aliases}
    for key, value in row.items():
        if normalize_header(key) in normalized_aliases:
            return value or ''
    return ''


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Import drive inventory CSV into SQLite.')
    parser.add_argument('--csv', dest='csv_path', default=str(CSV_PATH), help='Path to source CSV file')
    parser.add_argument('--db', dest='db_path', default=str(DB_PATH), help='Path to destination SQLite DB file')
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    csv_path = Path(args.csv_path)
    db_path = Path(args.db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    if not csv_path.exists():
      raise FileNotFoundError(f'CSV file not found: {csv_path}')

    conn = sqlite3.connect(db_path)
    rows = []
    try:
        conn.execute('DROP TABLE IF EXISTS drive_items')
        conn.execute(
            '''
            CREATE TABLE drive_items (
                full_path TEXT NOT NULL,
                type TEXT,
                name TEXT,
                extension TEXT,
                parent_folder TEXT,
                top_level_folder TEXT,
                depth INTEGER
            )
            '''
        )

        with csv_path.open('r', encoding='utf-8', newline='') as csv_file:
            reader = csv.DictReader(csv_file)
            normalized_headers = {normalize_header(header) for header in (reader.fieldnames or [])}
            missing_headers = [
                header for header in REQUIRED_HEADERS if normalize_header(header) not in normalized_headers
            ]
            if missing_headers:
                raise ValueError(f'Missing required CSV columns: {", ".join(missing_headers)}')

            rows = [
                (
                    read_value(row, ['Full Path']),
                    read_value(row, ['Type']),
                    read_value(row, ['Name']),
                    read_value(row, ['Extension']),
                    read_value(row, ['Parent Folder']),
                    read_value(row, ['Top-Level Folder']),
                    int(read_value(row, ['Depth']) or 0),
                )
                for row in reader
            ]

        conn.executemany(
            '''
            INSERT INTO drive_items (
                full_path,
                type,
                name,
                extension,
                parent_folder,
                top_level_folder,
                depth
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ''',
            rows,
        )
        conn.commit()
    finally:
        conn.close()

    print(f'Imported {len(rows)} rows into {db_path}')


if __name__ == '__main__':
    main()
