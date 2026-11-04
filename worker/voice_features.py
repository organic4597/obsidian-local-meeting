"""Bounded local voice features from Community-1; never includes words or audio."""
import json,math,os
from pathlib import Path

def exclusive_durations(turns):
    events=sorted([(int(t['start']),1,t['speaker']) for t in turns]+[(int(t['end']),-1,t['speaker']) for t in turns])
    result={};active={};last=None
    for at,delta,speaker in events:
        if last is not None and at>last and len(active)==1:
            name=next(iter(active));result[name]=result.get(name,0)+at-last
        active[speaker]=active.get(speaker,0)+delta
        if active[speaker]==0:del active[speaker]
        last=at
    return result

def features_from_output(labels,embeddings,turns,model_hash,pass_id,session):
    if embeddings is None or len(labels)!=len(embeddings):return None
    durations=exclusive_durations(turns);items=[]
    for label,row in zip(labels,embeddings):
        speaker='community_'+str(label).removeprefix('SPEAKER_')
        values=[float(x) for x in row]
        if len(values)!=256 or not all(math.isfinite(x) for x in values):continue
        norm=math.sqrt(sum(x*x for x in values))
        if norm<1e-10:continue
        # Reject very short/overlapping-only clusters. 60 seconds remains a
        # collection target, not a claim of verified identification accuracy.
        if durations.get(speaker,0)<3000:continue
        items.append({'cluster':speaker,'speechMs':durations[speaker],'vector':[round(x/norm,8) for x in values]})
    return {'schemaVersion':1,'modelHash':model_hash,'passId':pass_id,'session':session,'items':items}

def save_features(root,result):
    root=Path(root);target=root/'voice-features.json';temp=root/'voice-features.json.tmp'
    data=json.dumps(result,ensure_ascii=False,separators=(',',':')).encode()
    if len(data)>1_000_000:raise ValueError('화자 특징 데이터가 너무 큽니다.')
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'wb') as f:
            fd=-1;f.write(data);f.flush();os.fsync(f.fileno())
        os.replace(temp,target)
    finally:
        if fd!=-1:os.close(fd)
