"""Bounded offline candidates. Never rewrites accepted text, speakers or user notes."""
import hashlib,json,time,contextlib,sys,wave
from pathlib import Path
from quality import write_atomic

def reason(s):
    if s.get('suspect'):return '사용자가 표시한 의심 구간'
    if s.get('streamRewrites',0)>=2:return '스트리밍 결과 반복 변경'
    text=s.get('rawText',s.get('text',''))
    import re
    if re.search(r'(.{2,20}?)\1{3,}',text):return '반복 인식 의심'
    return ''

def run(root,session,context='',ids=None,budget=60,limit=8,segments_override=None,output_root=None):
    context=''  # Vocabulary lists are never decoder prompts (prompt echo risk).
    root=Path(root);source=json.loads((root/'transcript.json').read_text());segments=source['segments'] if segments_override is None else segments_override;out=Path(output_root) if output_root else root;out.mkdir(parents=True,exist_ok=True);path=out/'retranscription.json'
    try:saved=json.loads(path.read_text())
    except FileNotFoundError:saved={'schemaVersion':1,'items':{}}
    if saved.get('schemaVersion')!=1 or not isinstance(saved.get('items'),dict):raise ValueError('재전사 후보 형식을 확인해 주세요.')
    candidates=[s for s in segments if (ids is None and reason(s) or ids is not None and s['id'] in ids) and s.get('text','').strip() and .18<= (s['end']-s['start'])/1000<=24]
    began=time.monotonic();completed=0;pending=[]
    import numpy as np
    with wave.open(str(root/'recording.wav'),'rb') as w:
        if (w.getframerate(),w.getnchannels(),w.getsampwidth())!=(16000,1,2):raise ValueError('PCM16 16kHz mono required')
        duration=w.getnframes()/16
        def audio(a,b):w.setpos(round(a*16));return np.frombuffer(w.readframes(round((b-a)*16)),dtype='<i2').astype(np.float32)/32768
        for s in candidates:
            signature=hashlib.sha256(json.dumps([s['start'],s['end'],s.get('rawText',s['text']),context],ensure_ascii=False).encode()).hexdigest()
            old=saved['items'].get(s['id'])
            if old and old.get('signature')==signature and ids is None:continue
            if completed>=limit or time.monotonic()-began>=budget:pending.append(s['id']);continue
            a,b=s['start'],s['end'];lo=max(0,a-2000);hi=min(duration,b+2000)
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    target=session.transcribe((audio(a,b),16000),language='Korean',context=context,max_new_tokens=512).text.strip()
                    extended=session.transcribe((audio(lo,hi),16000),language='Korean',context=context,max_new_tokens=640).text.strip()
                saved['items'][s['id']]={'signature':signature,'sourceText':s['text'],'text':target,'start':a,'end':b,'contextStart':lo,'contextEnd':hi,'contextText':extended,'reason':reason(s) or '사용자 요청','state':'candidate'};completed+=1;saved.get('errors',{}).pop(s['id'],None)
            except Exception as e:
                saved.setdefault('errors',{})[s['id']]=str(e);pending.append(s['id'])
            write_atomic(path,saved)
    saved['pending']=pending;write_atomic(path,saved);return saved

if __name__=='__main__':
    import argparse,os
    os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1')
    p=argparse.ArgumentParser();p.add_argument('--session',required=True);p.add_argument('--model',required=True);p.add_argument('--id',required=True);p.add_argument('--request');p.add_argument('--output-root');a=p.parse_args()
    with contextlib.redirect_stdout(sys.stderr):
        from mlx_qwen3_asr import Session
        root=Path(a.session);config=json.loads((root/'pipeline.json').read_text());session=Session(model=a.model);override=None
        if a.request:
            request=Path(a.request)
            if request.stat().st_size>100000:raise ValueError('재전사 요청이 너무 큽니다.')
            item=json.loads(request.read_text())
            if item.get('id')!=a.id or not isinstance(item.get('text'),str) or len(item['text'])>10000 or not isinstance(item.get('start'),(int,float)) or not isinstance(item.get('end'),(int,float)) or item['start']<0 or not 0<item['end']-item['start']<=24000:raise ValueError('재전사 요청 범위가 잘못됐습니다.')
            override=[item]
        result=run(root,session,'',ids=[a.id],limit=1,segments_override=override,output_root=a.output_root)
    print(json.dumps(result,ensure_ascii=False))
