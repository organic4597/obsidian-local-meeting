"""Bounded activity history, phrase planning and evidence without word-time guessing."""
import json
import math
import time
from pathlib import Path
import numpy as np

RATE=16000

class Activity:
    def __init__(self,root):
        self.path=Path(root)/'activity.f32';self.step=.01;self.speakers=0;self.first=0
        self.mask_path=Path(root)/'activity.u8';self.frames=0
        self.values=np.empty((0,0),np.float32);self.active=np.empty((0,0),bool)
    def update(self,first,values,step):
        recompute=max(first,self.frames-math.ceil(10/step))
        values=values[max(0,recompute-first):];first=recompute
        self.first=first;self.values=values;self.step=step;self.speakers=values.shape[1]
        initial=None
        if first and self.mask_path.exists():
            with self.mask_path.open('rb') as f:f.seek(first-1);previous=f.read(1)
            if previous:initial=(previous[0]&(1<<np.arange(self.speakers)))!=0
        gated=hysteresis(values,initial=initial)
        masks=(gated*(1<<np.arange(self.speakers))).sum(axis=1).astype(np.uint8)
        with self.mask_path.open('r+b' if self.mask_path.exists() else 'w+b') as f:f.seek(first);f.write(masks.tobytes());f.flush()
        self.frames=first+len(values)
        with self.path.open('r+b' if self.path.exists() else 'w+b') as f:
            f.seek(first*self.speakers*4);f.write(values.astype('<f4',copy=False).tobytes());f.flush()
        (self.path.parent/'activity.json').write_text(json.dumps({'schemaVersion':1,'step':step,'speakers':self.speakers,'frames':first+len(values),'dtype':'float32-le','meaning':'independent speaker activity, not identity confidence'}))
        # Only the current planning tail is retained by Python. The native runtime has its own bounded cache.
        keep=max(0,len(values)-math.ceil(60/step));self.first+=keep;self.values=values[keep:]
        self.active=gated[keep:]
    def range(self,start,end):
        lo=max(0,math.floor(start/self.step));hi=min(self.frames,math.ceil(end/self.step))
        if hi<=lo:return lo,np.empty((0,self.speakers),np.float32),np.empty((0,self.speakers),bool)
        with self.path.open('rb') as f:f.seek(lo*self.speakers*4);values=np.frombuffer(f.read((hi-lo)*self.speakers*4),dtype='<f4').reshape(-1,self.speakers)
        with self.mask_path.open('rb') as f:f.seek(lo);masks=np.frombuffer(f.read(hi-lo),dtype=np.uint8)
        active=(masks[:,None]&(1<<np.arange(self.speakers)))!=0
        return lo,values,active
    def evidence(self,start,end):
        _,v,a=self.range(start,end)
        if not len(a):return {'speaker':'unknown','speakerState':'unknown','candidates':[],'reviewReasons':['화자 활동 근거 부족']}
        speech=a.any(axis=1);n=int(speech.sum())
        candidates=[{'speaker':f'speaker_{i+1}','activity':round(float(v[speech,i].mean()),4),'activeSeconds':round(float(a[:,i].sum()*self.step),3)} for i in range(self.speakers) if a[:,i].any()]
        candidates.sort(key=lambda x:-x['activeSeconds'])
        overlap=float((a.sum(axis=1)>1).sum()*self.step)
        if not n:return {'speaker':'unknown','speakerState':'unknown','candidates':candidates,'reviewReasons':['화자 활동 근거 부족']}
        sole=((a.sum(axis=1)==1)[:,None]&a).sum(axis=0);best=int(sole.argmax());ratio=float(sole[best]/n)
        if overlap>=.2:return {'speaker':'overlap','speakerState':'overlap','candidates':candidates,'overlapSeconds':round(overlap,3),'reviewReasons':['동시 활성 발언 확인 필요']}
        if ratio>=.85:return {'speaker':f'speaker_{best+1}','speakerState':'single','candidates':candidates,'activityCoverage':round(ratio,4),'reviewReasons':[]}
        return {'speaker':'unknown','speakerState':'unknown','candidates':candidates,'reviewReasons':['화자 전환 경계 확인 필요']}
    def runs(self,start=0,end=None):
        end=min(end if end is not None else self.frames*self.step,start+16)
        first,_,active=self.range(start,end)
        return activity_runs(active,first*self.step,self.step,start,end)

def hysteresis(values,onset=.6,offset=.4,initial=None):
    active=np.zeros_like(values,dtype=bool);state=np.zeros(values.shape[1],bool) if initial is None else initial
    for i,row in enumerate(values):state=np.where(state,row>=offset,row>=onset);active[i]=state
    return active

def activity_runs(active,offset,step,start=0,end=None):
    if not len(active):return []
    masks=(active*(1<<np.arange(active.shape[1]))).sum(axis=1)
    edges=np.r_[0,np.flatnonzero(masks[1:]!=masks[:-1])+1,len(masks)]
    result=[]
    for lo,hi in zip(edges,edges[1:]):
        if not masks[lo]:continue
        a=max(start,offset+lo*step);b=min(end if end is not None else float('inf'),offset+hi*step)
        if b>a:result.append((a,b,int(masks[lo])))
    return result

def phrase_end(runs,start,available,finished=False,max_seconds=10):
    """Natural pauses and sustained single-speaker changes, never 180ms turn slicing."""
    following=[r for r in runs if r[1]>start+.01]
    if not following:return None
    a=max(start,following[0][0]);last=a;dominant=None
    for lo,hi,mask in following:
        if lo-last>=.7 and last>a:return a,last,True
        single=mask if mask&(mask-1)==0 else None
        if dominant and single and single!=dominant and hi-lo>=.8 and lo-a>=1.2:return a,lo,True
        if single and hi-lo>=.8:dominant=single
        if hi-a>=max_seconds:
            # An activity boundary in the last two seconds is preferable to an arbitrary cut.
            pauses=[p[1] for p,q in zip(following,following[1:]) if q[0]-p[1]>=.12 and a+max_seconds-2<=p[1]<=a+max_seconds]
            b=pauses[-1] if pauses else a+max_seconds
            return a,b,available>=b+.8 or finished
        last=max(last,hi)
    closed=finished or available-last>=.7
    return a,last,closed

def write_atomic(path,data):
    import os
    temp=path.with_suffix(path.suffix+'.tmp')
    with temp.open('w') as f:json.dump(data,f,ensure_ascii=False,indent=2);f.flush();os.fsync(f.fileno())
    os.replace(temp,path)

class RevisionStore:
    def __init__(self,store):
        self.store=store;self.db=store.db
        self.db.execute('CREATE TABLE IF NOT EXISTS utterances(id TEXT PRIMARY KEY,start INTEGER,end INTEGER,revision INTEGER,value TEXT NOT NULL,acked INTEGER DEFAULT 0)')
        self.db.execute('CREATE TABLE IF NOT EXISTS revisions(sequence INTEGER PRIMARY KEY AUTOINCREMENT,utterance TEXT,revision INTEGER,value TEXT NOT NULL,created REAL NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS quality_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');self.db.commit()
    def all(self):return [json.loads(r[0]) for r in self.db.execute('SELECT value FROM utterances ORDER BY start,id')]
    def put(self,segment):
        old=self.db.execute('SELECT revision,value FROM utterances WHERE id=?',(segment['id'],)).fetchone()
        body={k:v for k,v in segment.items() if k not in ('revision','eventId')}
        if old and {k:v for k,v in json.loads(old[1]).items() if k not in ('revision','eventId')}==body:return None
        revision=old[0]+1 if old else 1
        segment={**body,'revision':revision,'eventId':f"{segment['id']}:{revision}"}
        encoded=json.dumps(segment,ensure_ascii=False)
        with self.db:
            self.db.execute('INSERT INTO utterances VALUES(?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET start=excluded.start,end=excluded.end,revision=excluded.revision,value=excluded.value',(segment['id'],segment['start'],segment['end'],revision,encoded))
            self.db.execute('INSERT INTO revisions(utterance,revision,value,created) VALUES(?,?,?,?)',(segment['id'],revision,encoded,time.time()))
        return segment
    def ack(self,ident,revision):
        with self.db:self.db.execute('UPDATE utterances SET acked=MAX(acked,?) WHERE id=? AND revision>=?',(revision,ident,revision))
    def set(self,key,value):
        with self.db:self.db.execute('INSERT OR REPLACE INTO quality_meta VALUES(?,?)',(key,json.dumps(value)))
    def get(self,key,default=None):
        r=self.db.execute('SELECT value FROM quality_meta WHERE key=?',(key,)).fetchone()
        return json.loads(r[0]) if r else default
    def export(self):write_atomic(self.store.root/'transcript.json',{'schemaVersion':2,'segments':self.all()})
