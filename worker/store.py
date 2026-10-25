"""Durable disk queue; PCM is never stored in the job table or IPC."""
import json
import os
import wave
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
        for path in sorted([*self.root.glob('audio-*-*.wav'),*self.root.glob('queue/audio-*-*.pcm')]):
            _, start, end = path.stem.split('-')
            relative=str(path.relative_to(self.root));start=int(start);end=int(end)
            known=self.db.execute('SELECT id,path FROM chunks WHERE start=? AND end=? ORDER BY id LIMIT 1',(start,end)).fetchone()
            if known:
                if not (self.root/known[1]).exists():self.db.execute('UPDATE chunks SET path=? WHERE id=?',(relative,known[0]));self.db.commit()
            else:self.add(relative,start,end)
        recording=self.root/'recording.wav'
        if recording.exists():
            from recording import repair_header
            repair_header(recording)
            with wave.open(str(recording),'rb') as source:
                rate=source.getframerate();frames=source.getnframes()
                def restore(start,end):
                    lo=round(start*rate/1000);hi=min(frames,round(end*rate/1000))
                    if hi<=lo:raise ValueError('Recording cannot restore the missing audio interval')
                    name=f'queue/audio-{round(start):012d}-{round(end):012d}.pcm'
                    target=self.root/name;target.parent.mkdir(parents=True,exist_ok=True);temp=target.with_suffix('.pcm.part')
                    source.setpos(lo)
                    with open(temp,'wb') as out:
                        remaining=hi-lo
                        while remaining:
                            data=source.readframes(min(16384,remaining))
                            if not data:raise ValueError('Incomplete full recording')
                            out.write(data);remaining-=len(data)//2
                        out.flush();os.fsync(out.fileno())
                    os.replace(temp,target);return name
                end_frame=0
                for ident,path,start,end,*_ in self.rows():
                    chunk=self.root/path
                    if not chunk.exists():
                        if round(end*rate/1000)>frames+8:raise ValueError('Full recording is shorter than the missing queue interval')
                        path=restore(start,end);self.db.execute('UPDATE chunks SET path=? WHERE id=?',(path,ident));self.db.commit();chunk=self.root/path
                    if chunk.suffix=='.pcm':count=chunk.stat().st_size//2
                    else:
                        with wave.open(str(chunk),'rb') as old:count=old.getnframes()
                    end_frame=max(end_frame,round(start*rate/1000)+count)
                # The full WAV may hold a tail that had not reached a queue chunk at interruption.
                if frames>end_frame+8:
                    start=round(end_frame*1000/rate);end=round(frames*1000/rate)
                    self.add(restore(start,end),start,end)

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
