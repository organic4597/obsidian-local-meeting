"""Dedicated offline Community-1/MPS process. No ASR, downloads or remote telemetry."""
import os
os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',PYANNOTE_METRICS_ENABLED='0',DO_NOT_TRACK='1',OTEL_SDK_DISABLED='true')
import argparse,contextlib,hashlib,json,sys,time,wave,resource
from pathlib import Path
from quality import write_atomic

def bounds(count,mode):
    if not isinstance(count,int) or not 0<=count<=32 or mode not in ('maximum','exact'):raise ValueError('화자 수는 0~32명, 방식은 상한 또는 고정이어야 합니다.')
    return {} if not count else {'num_speakers':count} if mode=='exact' else {'max_speakers':count}

def run(root,model,count=0,mode='maximum',emit=print):
    root=Path(root);model=Path(model).resolve();options=bounds(count,mode)
    if not (model/'config.yaml').is_file():raise ValueError('다운로드된 Community-1 로컬 모델 폴더가 필요합니다.')
    audio=root/'recording.wav';digest=hashlib.sha256()
    with audio.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):digest.update(block)
    manifest=hashlib.sha256()
    for name in ['config.yaml','segmentation/pytorch_model.bin','embedding/pytorch_model.bin','plda/plda.npz','plda/xvec_transform.npz']:
        with (model/name).open('rb') as f:
            for block in iter(lambda:f.read(1024*1024),b''):manifest.update(block)
    pass_id=hashlib.sha256(f'community-mps:1:{digest.hexdigest()}:{manifest.hexdigest()}:{mode}:{count}'.encode()).hexdigest()
    target=root/'community-refinement.json'
    if target.exists():
        saved=json.loads(target.read_text())
        if saved.get('passId')==pass_id:emit(saved);return saved
    emit({'type':'status','pending':0,'lag':0,'state':'회의 종료 후 Community-1/MPS 화자 구분 중'})
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np,torch
        from pyannote.audio import Pipeline
        if not torch.backends.mps.is_available():raise RuntimeError('Metal(MPS) 가속을 사용할 수 없습니다. CPU로 자동 전환하지 않습니다.')
        torch.set_num_threads(4)
        with wave.open(str(audio),'rb') as w:
            if (w.getframerate(),w.getnchannels(),w.getsampwidth())!=(16000,1,2):raise ValueError('PCM16 16kHz 모노 WAV가 필요합니다.')
            duration=w.getnframes()/16;raw=w.readframes(w.getnframes())
        pcm=np.frombuffer(raw,dtype='<i2').astype(np.float32)/32768;del raw
        began=time.monotonic();pipeline=Pipeline.from_pretrained(str(model));pipeline.to(torch.device('mps'))
        with torch.inference_mode():output=pipeline({'waveform':torch.from_numpy(pcm).unsqueeze(0),'sample_rate':16000},**options)
        torch.mps.synchronize()
    turns=[{'start':max(0,round(seg.start*1000)),'end':min(round(duration),round(seg.end*1000)),'speaker':'community_'+str(speaker).removeprefix('SPEAKER_')} for seg,_,speaker in output.speaker_diarization.itertracks(yield_label=True) if seg.end>seg.start]
    turns=[t for t in turns if t['end']>t['start']]
    result={'type':'speaker_refinement','session':root.name,'passId':pass_id,'preset':'community-1-mps','turns':turns,'detectedSpeakers':len({t['speaker'] for t in turns}),'processingSeconds':round(time.monotonic()-began,4),'speakerCount':count,'speakerCountMode':mode,'peakRssBytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
    write_atomic(target,result);emit(result);return result

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--session',required=True);p.add_argument('--model',required=True);p.add_argument('--count',type=int,default=0);p.add_argument('--mode',choices=['maximum','exact'],default='maximum');args=p.parse_args()
    def emit(event):print(json.dumps(event,ensure_ascii=False),flush=True)
    try:run(args.session,args.model,args.count,args.mode,emit)
    except Exception as e:emit({'type':'error','message':f'Community-1 화자 처리 실패: {e}'});sys.exit(1)
