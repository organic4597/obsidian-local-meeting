"""Bounded, provisional rolling diarization; capture never waits on this process."""
import json,math,threading,time,subprocess,sys
from pathlib import Path

class OnlineLabels:
    def __init__(self,maximum=0):self.maximum=maximum or 32;self.vectors={};self.previous=[];self.next_id=1
    def assign(self,turns,labels,embeddings):
        mapping={};used=set();vectors={label:list(map(float,row)) for label,row in zip(labels,embeddings)}
        for label in labels:
            spans=[t for t in turns if t['speaker']==label];votes={}
            for t in spans:
                for old in self.previous:
                    overlap=max(0,min(t['end'],old['end'])-max(t['start'],old['start']))
                    if overlap and old['speaker'].startswith('live_'):votes[old['speaker']]=votes.get(old['speaker'],0)+overlap
            ranked=sorted(votes.items(),key=lambda x:-x[1]);chosen=None
            if ranked and ranked[0][1]>=500 and ranked[0][0] not in used and (len(ranked)==1 or ranked[0][1]>ranked[1][1]*2):chosen=ranked[0][0]
            # Experimental continuity only. Never a verified identity or permanent name.
            if chosen is None:
                v=vectors.get(label,[]);scores=[]
                for key,ref in self.vectors.items():
                    if key in used or len(v)!=len(ref):continue
                    norm=math.sqrt(sum(x*x for x in v)*sum(x*x for x in ref));score=sum(x*y for x,y in zip(v,ref))/norm if norm else -1
                    if math.isfinite(score):scores.append((key,score))
                scores.sort(key=lambda x:-x[1])
                if scores and scores[0][1]>=.9 and (len(scores)==1 or scores[0][1]-scores[1][1]>=.1):chosen=scores[0][0]
            if chosen is None and self.next_id<=self.maximum:chosen=f'live_{self.next_id}';self.next_id+=1
            chosen=chosen or 'unknown';mapping[label]=chosen
            if chosen!='unknown':used.add(chosen);self.vectors[chosen]=vectors.get(label,[])
        mapped=[{**t,'speaker':mapping[t['speaker']]} for t in turns];self.previous=mapped;return mapped

class LiveSpeakers:
    def __init__(self,args,root):
        self.root=Path(root);self.lock=threading.Lock();self.processed=0.;self.turns=[];self.error='';self.available=0.;self.requested=0.;self.busy=False;self.started=time.monotonic()
        self.child=subprocess.Popen([args.community_python,'-u',str(Path(__file__).with_name('live_speakers.py')),'--session',str(root),'--model',args.community_model],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=sys.stderr,text=True,bufsize=1)
        def read():
            try:
                for line in self.child.stdout:
                    e=json.loads(line)
                    with self.lock:
                        if e.get('error'):self.error=str(e['error'])
                        else:
                            start=e['start']*1000;self.turns=[{**t,'end':min(t['end'],start)} for t in self.turns if t['start']<start and t['end']>(e['end']-120)*1000]+e['turns'];self.processed=e['end'];self.busy=False
            except Exception:self.error='실시간 화자 결과를 확인하지 못했습니다.'
            finally:
                if self.child.poll() is not None and not self.error:self.error='실시간 화자 분석이 종료되었습니다.'
        self.thread=threading.Thread(target=read,daemon=True);self.thread.start()
    def update(self,available):
        self.available=available
        if self.child.poll() is not None:self.error='실시간 화자 프로세스가 종료되었습니다.'
        if self.error or self.busy or available-self.requested<4:return
        self.requested=available;self.busy=True
        try:self.child.stdin.write(json.dumps({'start':max(0,available-24),'end':available})+'\n');self.child.stdin.flush()
        except (OSError,BrokenPipeError):self.error='실시간 화자 요청을 전달하지 못했습니다.'
    def snapshot(self):
        with self.lock:return self.processed,list(self.turns),self.error
    def close(self):
        try:self.child.stdin.close();self.child.wait(timeout=15)
        except (OSError,subprocess.TimeoutExpired):self.child.terminate()
        try:self.child.wait(timeout=5)
        except subprocess.TimeoutExpired:self.child.kill();self.child.wait()
        self.thread.join(timeout=1)

def speaker_at(turns,start,end):
    points=sorted({start,end,*[max(start,min(end,t[k])) for t in turns for k in ('start','end')]});votes={};overlap=0;total=0
    for a,b in zip(points,points[1:]):
        ids={t['speaker'] for t in turns if t['start']<b and t['end']>a}
        if not ids:continue
        total+=b-a
        if len(ids)>1:overlap+=b-a
        else:key=next(iter(ids));votes[key]=votes.get(key,0)+b-a
    if overlap>=200:return 'overlap'
    best=max(votes,key=votes.get,default='unknown');return best if votes.get(best,0)>=.8*max(total,1) else 'unknown'

def change_boundary(turns,start,end):
    """Choose a stable observed handover even when there is no silence."""
    ordered=sorted([t for t in turns if t['end']>start and t['start']<end],key=lambda t:t['start'])
    if not ordered:return None
    first=ordered[0]['speaker']
    for t in ordered[1:]:
        at=t['start']
        if t['speaker']!=first and at-start>=600 and t['end']-at>=450:return at
    return None

def run(root,model):
    import os
    os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',PYANNOTE_METRICS_ENABLED='0',DO_NOT_TRACK='1')
    import contextlib,wave,numpy as np,torch
    from pyannote.audio import Pipeline
    with contextlib.redirect_stdout(sys.stderr):
        if not torch.backends.mps.is_available():raise RuntimeError('실시간 Community-1에 MPS가 필요합니다.')
        pipeline=Pipeline.from_pretrained(str(model));pipeline.to(torch.device('mps'));torch.set_num_threads(2)
    cfg=json.loads((Path(root)/'pipeline.json').read_text());maximum=cfg.get('speakerCount',0);tracker=OnlineLabels(maximum)
    for line in sys.stdin:
        request=json.loads(line);start,end=request['start'],request['end']
        if not all(isinstance(x,(int,float)) and math.isfinite(x) for x in (start,end)) or start<0 or not 0<end-start<=25:raise ValueError('실시간 화자 범위가 잘못되었습니다.')
        with wave.open(str(Path(root)/'recording.wav'),'rb') as w:
            if (w.getframerate(),w.getnchannels(),w.getsampwidth())!=(16000,1,2):raise ValueError('PCM16 16kHz mono required')
            if round(end*16000)>w.getnframes():raise ValueError('아직 저장되지 않은 녹음 범위')
            w.setpos(round(start*16000));pcm=np.frombuffer(w.readframes(round((end-start)*16000)),dtype='<i2').astype(np.float32)/32768
        with contextlib.redirect_stdout(sys.stderr),torch.inference_mode():output=pipeline({'waveform':torch.from_numpy(pcm).unsqueeze(0),'sample_rate':16000},**({'max_speakers':maximum} if maximum else {}))
        turns=[{'start':round((s.start+start)*1000),'end':round(min(end,s.end+start)*1000),'speaker':str(label)} for s,_,label in output.speaker_diarization.itertracks(yield_label=True) if s.end>s.start]
        mapped=tracker.assign(turns,output.speaker_diarization.labels(),output.speaker_embeddings)
        print(json.dumps({'start':start,'end':end,'turns':mapped}),flush=True)

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--session',required=True);p.add_argument('--model',required=True);a=p.parse_args()
    try:run(a.session,a.model)
    except Exception as e:print(json.dumps({'error':str(e)}),flush=True);sys.exit(1)
