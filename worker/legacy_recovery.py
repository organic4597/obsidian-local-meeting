"""Check legacy queues without editing them before Community-1 reanalysis."""
import sqlite3
import wave
from pathlib import Path

def check_complete(root):
    root=Path(root);database=root/'queue.sqlite';audio=root/'recording.wav'
    if not database.is_file() or not audio.is_file():
        raise ValueError('이전 회의 큐 또는 전체 녹음을 확인할 수 없습니다. 기존 파일을 보존합니다.')
    connection=sqlite3.connect(database.as_uri()+'?mode=ro',uri=True)
    try:
        rows=connection.execute('SELECT path,start,end,state FROM chunks ORDER BY start').fetchall()
    finally:connection.close()
    if not rows or any(row[3]!='done' for row in rows):
        raise ValueError('이전 회의에 미완료 전사 작업이 있습니다. 기존 큐와 녹음을 보존했으며 자동 재전사는 중단했습니다.')
    end=0
    for _,start,stop,_ in rows:
        if start>end+1 or stop<=start:raise ValueError('이전 회의 큐에 확인되지 않은 구간이 있습니다. 원본을 보존합니다.')
        end=max(end,stop)
    with wave.open(str(audio),'rb') as wav:
        if (wav.getframerate(),wav.getnchannels(),wav.getsampwidth())!=(16000,1,2):raise ValueError('이전 회의 녹음 형식이 다릅니다. 원본을 보존합니다.')
        duration=wav.getnframes()*1000/wav.getframerate()
    if duration>max(row[2] for row in rows)+1:
        raise ValueError('이전 회의에 큐에 포함되지 않은 음성이 있습니다. 원본을 보존합니다.')
    known={str(Path(row[0])) for row in rows}
    files=list(root.glob('audio-*-*.wav'))+list(root.glob('queue/audio-*-*.pcm'))
    if any(str(p.relative_to(root)) not in known for p in files):
        raise ValueError('이전 회의에 확인되지 않은 음성 조각이 있습니다. 원본을 보존합니다.')
