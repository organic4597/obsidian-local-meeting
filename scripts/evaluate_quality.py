#!/usr/bin/env python3
"""Local, explicit-reference CER and interval DER. Empty templates are never scored."""
import argparse
import functools
import json
import re
import unicodedata
from pathlib import Path

def distance(a,b):
    if len(a)<len(b):a,b=b,a
    row=list(range(len(b)+1))
    for i,x in enumerate(a,1):
        next_row=[i]
        for j,y in enumerate(b,1):next_row.append(min(next_row[-1]+1,row[j]+1,row[j-1]+(x!=y)))
        row=next_row
    return row[-1]

def normalize(text):return ''.join(c for c in unicodedata.normalize('NFC',text).casefold() if c.isalnum())

def best_mapping(ref,hyp):
    refs=sorted({s for r in ref for s in r['speakers']});hyps=sorted({s for h in hyp for s in h['speakers']})
    if len(refs)>8 or len(hyps)>8:raise ValueError('이 평가기는 최대 8명의 화자를 지원합니다.')
    weight=[[sum(max(0,min(r['end'],h['end'])-max(r['start'],h['start'])) for r in ref for h in hyp if rs in r['speakers'] and hs in h['speakers']) for hs in hyps] for rs in refs]
    @functools.lru_cache(None)
    def solve(i,mask):
        if i==len(hyps):return 0,()
        score,choices=solve(i+1,mask);best=(score,(-1,)+choices)
        for j in range(len(refs)):
            if mask&(1<<j):continue
            score,choices=solve(i+1,mask|(1<<j));candidate=(score+weight[j][i],(j,)+choices)
            if candidate[0]>best[0]:best=candidate
        return best
    _,choices=solve(0,0)
    return {h:refs[j] if j>=0 else 'unmapped_'+h for h,j in zip(hyps,choices)}

def diarization(ref,hyp):
    mapping=best_mapping(ref,hyp);end=max(r['end'] for r in ref)
    points=sorted({0,end}|{max(0,min(end,s[k])) for s in ref+hyp for k in ('start','end')})
    miss=false=confusion=reference=single=assigned=0
    for a,b in zip(points,points[1:]):
        duration=b-a;rs={p for s in ref if s['start']<b and s['end']>a for p in s['speakers']};hs={mapping.get(p,'unmapped_'+p) for s in hyp if s['start']<b and s['end']>a for p in s['speakers']}
        reference+=len(rs)*duration;miss+=max(0,len(rs)-len(hs))*duration;false+=max(0,len(hs)-len(rs))*duration
        confusion+=(min(len(rs),len(hs))-len(rs&hs))*duration
        if len(rs)==1:single+=duration;assigned+=duration*bool(hs)
    return {'DER':(miss+false+confusion)/reference if reference else None,'missMs':miss,'falseAlarmMs':false,'confusionMs':confusion,'referenceSpeakerMs':reference,'singleSpeakerCoverage':assigned/single if single else None,'overlapIncluded':True,'collarSeconds':0,'mapping':mapping}

def evaluate(reference,hypothesis):
    rows=reference.get('segments',[])
    if not rows or any(r.get('referenceText') is None or not isinstance(r.get('referenceSpeakers'),list) for r in rows):raise ValueError('원음을 확인해 모든 referenceText와 referenceSpeakers를 채워야 합니다. 빈 양식은 평가하지 않습니다.')
    for r in rows:
        if not isinstance(r['referenceText'],str) or r['start']<0 or r['end']<=r['start'] or any(not isinstance(s,str) for s in r['referenceSpeakers']):raise ValueError('잘못된 정답 구간')
    start=min(r['start'] for r in rows);end=max(r['end'] for r in rows)
    hyp=[s for s in hypothesis['segments'] if s['end']>start and s['start']<end]
    if any(s['start']<start or s['end']>end for s in hyp):raise ValueError('평가 범위가 전사 발언 중간을 가로지릅니다. 발언 경계에 맞춰 정답 범위를 선택해 주세요.')
    ref_text=' '.join(r['referenceText'] for r in sorted(rows,key=lambda r:r['start']))
    hyp_text=' '.join(s['text'] for s in sorted(hyp,key=lambda s:s['start']))
    recognition=' '.join(s.get('rawText',s['text']) for s in sorted(hyp,key=lambda s:s['start']))
    normalized_ref=normalize(ref_text)
    ref=[{'start':r['start'],'end':r['end'],'speakers':r['referenceSpeakers']} for r in rows]
    predicted=[{'start':s['start'],'end':s['end'],'speakers':[s['speaker']] if s['speaker'] not in ('unknown','overlap') else []} for s in hyp]
    return {'schemaVersion':1,'CER':distance(normalized_ref,normalize(hyp_text))/len(normalized_ref) if normalized_ref else None,
            'recognitionCER':distance(normalized_ref,normalize(recognition))/len(normalized_ref) if normalized_ref else None,
            'rawCER':distance(ref_text,hyp_text)/len(ref_text) if ref_text else None,'referenceCharacters':len(normalized_ref),
            'diarization':diarization(ref,predicted),'unresolvedSegments':sum(s['speaker'] in ('unknown','overlap') for s in hyp),
            'notes':'CER scores displayed text; recognitionCER scores original ASR. DER here scores transcript speaker attribution, not raw model activity. Unknown/overlap-only transcripts have no asserted speaker and count as missing assignments. The labeled time range is scored.'}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--reference',required=True);p.add_argument('--hypothesis',required=True);p.add_argument('--output');args=p.parse_args()
    try:
        result=evaluate(json.loads(Path(args.reference).read_text()),json.loads(Path(args.hypothesis).read_text()))
        encoded=json.dumps(result,ensure_ascii=False,indent=2)
        if args.output:Path(args.output).write_text(encoded)
        print(encoded)
    except (ValueError,KeyError) as exc:p.exit(2,str(exc)+'\n')
