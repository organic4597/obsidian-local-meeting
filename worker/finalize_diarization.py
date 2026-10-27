"""Recoverable end-of-meeting speaker pass. Does not transcribe or edit notes."""
import hashlib
import json
import time
import wave
from pathlib import Path
import numpy as np
from quality import write_atomic

def finalize(root,library,model,emit,enabled=True):
    root=Path(root)
    if not enabled:return None
    audio=root/'recording.wav';target=root/'speaker-refinement.json'
    digest=hashlib.sha256()
    with audio.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):digest.update(block)
    model_digest=hashlib.sha256()
    with Path(model).open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):model_digest.update(block)
    pass_id=hashlib.sha256(('v3-offline:1:'+digest.hexdigest()+model_digest.hexdigest()).encode()).hexdigest()
    if target.exists():
        saved=json.loads(target.read_text())
        if saved.get('passId')==pass_id:emit(saved);return saved
    emit({'type':'status','pending':0,'lag':0,'state':'회의 종료 후 화자 재분석 중'})
    from diarization import Diarizer
    diar=Diarizer(library,model,preset='v3-offline');began=time.monotonic()
    try:
        with wave.open(str(audio),'rb') as w:
            if (w.getframerate(),w.getnchannels(),w.getsampwidth())!=(16000,1,2):raise ValueError('화자 재분석은 PCM16 16kHz mono WAV가 필요합니다.')
            duration=round(w.getnframes()/16)
            while True:
                raw=w.readframes(32000)
                if not raw:break
                diar.push(np.frombuffer(raw,dtype='<i2').astype(np.float32)/32768)
        turns=[{'start':max(0,round(a*1000)),'end':min(duration,round(b*1000)),'speaker':f'offline_{s}'} for a,b,s in diar.finish() if b>a]
        turns=[t for t in turns if t['end']>t['start']]
        result={'type':'speaker_refinement','session':root.name,'passId':pass_id,'preset':'v3-offline','turns':turns,
                'detectedSpeakers':len({t['speaker'] for t in turns}),'processingSeconds':round(time.monotonic()-began,4)}
        write_atomic(target,result);emit(result);return result
    finally:diar.close()
