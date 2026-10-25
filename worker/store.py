"""Durable disk queue; PCM is never stored in the job table or IPC."""
import json
import sqlite3
import time
from pathlib import Path

class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.root / 'queue.sqlite', timeout=30)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, start REAL NOT NULL, end REAL NOT NULL, state TEXT NOT NULL DEFAULT \'pending\', result TEXT, error TEXT)')
        self.db.commit()

    def recover(self):
        self.db.execute("UPDATE chunks SET state='pending' WHERE state='running'")
        self.db.commit()
        # A crash between WAV rename and SQL insert must not lose its audio.
        for path in sorted(self.root.glob('audio-*-*.wav')):
            _, start, end = path.stem.split('-')
            self.add(path.name, int(start), int(end))

    def add(self, path, start, end):
        self.db.execute('INSERT OR IGNORE INTO chunks(path,start,end) VALUES(?,?,?)',(path,start,end))
        self.db.commit()

    def rows(self):
        return self.db.execute('SELECT id,path,start,end,state FROM chunks ORDER BY start,id').fetchall()

    def peek(self):
        return self.db.execute("SELECT id,path,start,end FROM chunks WHERE state='pending' ORDER BY start,id LIMIT 1").fetchone()

    def claim(self):
        with self.db:
            row=self.db.execute("SELECT id,path,start,end FROM chunks WHERE state='pending' ORDER BY start,id LIMIT 1").fetchone()
            if row:
                self.db.execute("UPDATE chunks SET state='running' WHERE id=?",(row[0],))
        return row

    def complete(self, ident, result):
        self.db.execute("UPDATE chunks SET state='done', result=?, error=NULL WHERE id=?",(json.dumps(result,ensure_ascii=False),ident))
        self.db.commit()

    def fail(self, ident, error):
        self.db.execute("UPDATE chunks SET state='error', error=? WHERE id=?",(str(error),ident))
        self.db.commit()

    def retry(self):
        self.db.execute("UPDATE chunks SET state='pending', error=NULL WHERE state='error'")
        self.db.commit()

    def results(self):
        results=[]
        for row in self.db.execute("SELECT result FROM chunks WHERE state='done' ORDER BY start,id"):
            value=json.loads(row[0])
            results.extend(value.get('segments',[value]))
        return results

    def status(self):
        n,start,end=self.db.execute("SELECT COUNT(*),MIN(start),MAX(end) FROM chunks WHERE state!='done'").fetchone()
        return {'pending':n, 'lag':max(0,(end or 0)-(start or 0))/1000}

    def close(self):
        self.db.close()
