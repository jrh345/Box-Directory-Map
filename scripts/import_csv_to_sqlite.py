import csv
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSV_PATH = ROOT / 'tmp-mini-tree.csv'
DB_DIR = ROOT / 'data'
DB_PATH = DB_DIR / 'drive-audit-map.db'


def main() -> None:
    DB_DIR.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
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

        with CSV_PATH.open('r', encoding='utf-8', newline='') as csv_file:
            reader = csv.DictReader(csv_file)
            rows = [
                (
                    row.get('Full Path', ''),
                    row.get('Type', ''),
                    row.get('Name', ''),
                    row.get('Extension', ''),
                    row.get('Parent Folder', ''),
                    row.get('Top-Level Folder', ''),
                    int(row.get('Depth') or 0),
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

    print(f'Imported {len(rows)} rows into {DB_PATH}')


if __name__ == '__main__':
    main()
