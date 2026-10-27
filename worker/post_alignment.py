"""Local word timing only: immutable text, exact character offsets, no re-transcription."""
import contextlib,hashlib,json,sys,wave
from pathlib import Path
from quality import write_atomic

def offsets(text,words,start_ms,end_ms):
    import unicodedata
    kept=lambda ch:ch=="'" or unicodedata.category(ch).startswith(('L','N'))
    positions=[i for i,ch in enumerate(text) if kept(ch)];clean=''.join(text[i] for i in positions);cursor=0;out=[]
    for word in words:
        token=''.join(ch for ch in word.text if kept(ch));index=clean.find(token,cursor)
        if not token or index<0:raise ValueError('정렬 결과가 원문과 일치하지 않습니다.')
        a=start_ms+round(float(word.start_time)*1000);b=start_ms+round(float(word.end_time)*1000)
        if a<start_ms-100 or b>end_ms+300 or b<a or out and a<out[-1]['start']-100:raise ValueError('정렬 시간이 음성 범위를 벗어났습니다.')
        a=max(start_ms,min(end_ms,a));b=min(end_ms,max(a,b))
        out.append({'from':positions[index],'to':positions[index+len(token)-1]+1,'start':a,'end':b});cursor=index+len(token)
    if cursor<len(clean):raise ValueError('정렬에서 일부 문자가 누락됐습니다.')
    return out

def align(root,model,emit,turns=None):
    root=Path(root);path=root/'transcript.json'
    if not path.exists():return {}
    source=json.loads(path.read_text());segments=source.get('segments',[]);model=Path(model)
    if not (model/'config.json').is_file():raise ValueError('로컬 텍스트 정렬 모델이 필요합니다.')
    signature=hashlib.sha256(json.dumps({'segments':segments,'turns':turns},sort_keys=True,ensure_ascii=False).encode()+(model/'config.json').read_bytes()).hexdigest()
    target=root/'word-alignment.json'
    if target.exists():
        cached=json.loads(target.read_text())
        if cached.get('sourceHash')==signature and all(not s.get('reviewRequired') for s in cached['segments'].values()):return cached['segments']
    emit({'type':'status','pending':0,'lag':0,'state':'종료 후 음성과 대사 위치 정렬 중'})
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        from mlx_qwen3_asr.forced_aligner import ForcedAligner
        aligner=ForcedAligner(str(model));results={}
        with wave.open(str(root/'recording.wav'),'rb') as w:
            for s in segments:
                if not s.get('text','').strip() or s['end']-s['start']>30000:continue
                if turns is not None:
                    duration={}
                    for t in turns:
                        overlap=max(0,min(s['end'],t['end'])-max(s['start'],t['start']))
                        duration[t['speaker']]=duration.get(t['speaker'],0)+overlap
                    if sum(ms>=250 for ms in duration.values())<2:continue
                w.setpos(min(w.getnframes(),max(0,round(s['start']*16))));raw=w.readframes(round((s['end']-s['start'])*16))
                if not raw:continue
                try:
                    words=aligner.align(np.frombuffer(raw,dtype='<i2').astype(np.float32)/32768,s['text'],'Korean')
                    results[s['id']]={'text':s['text'],'words':offsets(s['text'],words,s['start'],s['end'])}
                except Exception:results[s['id']]={'text':s['text'],'words':[],'reviewRequired':True}
    write_atomic(target,{'sourceHash':signature,'segments':results});return results
