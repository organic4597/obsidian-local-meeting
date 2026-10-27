#!/usr/bin/env python3
"""Offline worker. stdin commands / stdout JSONL events. No HTTP endpoints."""
import os
os.environ['HF_HUB_OFFLINE']='1'
os.environ['TRANSFORMERS_OFFLINE']='1'
os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
import argparse
import contextlib
import json
import queue
import sys
import threading
import resource
from pathlib import Path
from store import Store
from capture import Capture

OUTPUT=sys.stdout
LOCK=threading.Lock()
def emit(event):
    with LOCK:
        OUTPUT.write(json.dumps(event,ensure_ascii=False)+'\n'); OUTPUT.flush()

def commands(inbox, stop_capture):
    for line in sys.stdin:
        try:
            command=json.loads(line)
            if command.get('type') not in ('stop','retry'):
                raise ValueError('지원하지 않는 명령')
            inbox.put(command)
            if command['type']=='stop': stop_capture()
        except Exception as exc: emit({'type':'error','message':str(exc)})
    stop_capture()
    inbox.put({'type':'stop'})

def run(args):
    model=Path(args.model).expanduser().resolve()
    if not model.is_dir() or not (model/'config.json').is_file():
        raise ValueError('로컬 MLX 모델 폴더와 config.json이 필요합니다. 원격 모델 ID는 사용할 수 없습니다.')
    store=Store(args.session)
    store.recover()
    if args.resume and store.rows():
        from recording import ensure_recording
        ensure_recording(store.root)
    inbox=queue.Queue()
    audio=queue.Queue()  # Paths and timing only, never PCM
    cap=Capture(store.root,audio.put,device=args.device,seconds=args.chunk_seconds)
    stopped=args.resume or bool(args.input_wav)
    failed=False
    diar=None
    fed=set()
    try:
        # Start capture first. Model loading cannot block recording.
        if args.input_wav:
            cap.import_wav(args.input_wav)
        elif not stopped: cap.start()
        threading.Thread(target=commands,args=(inbox,cap.stop),daemon=True).start()
        emit({'type':'status',**store.status(),'state':'모델 로딩 중 / 오디오 저장 중' if not stopped else '복구 중'})
        with contextlib.redirect_stdout(sys.stderr):
            from mlx_qwen3_asr import Session
            session=Session(model=str(model))
        if args.diar_model and args.diar_library:
            from diarization import Diarizer,read_pcm,planned_turns,slice_recording
            diar=Diarizer(args.diar_library,args.diar_model)
        emit({'type':'ready','session':store.root.name})
        for result in store.results():
            if result['text']: emit({'type':'segment','segment':result})
        while True:
            while not inbox.empty():
                command=inbox.get()
                if command['type']=='stop' and not stopped:
                    cap.stop(); stopped=True
                if command['type']=='retry': store.retry()
            if cap.stop_event.is_set() and not stopped:
                cap.stop(); stopped=True
                if cap.error: emit({'type':'error','message':cap.error})
            while not audio.empty():
                item=audio.get(); store.add(item['path'],item['start'],item['end'])
            if diar:
                for row in store.rows():
                    if row[1] not in fed:
                        diar.push(read_pcm(store.root/row[1]));fed.add(row[1])
                if stopped:diar.finish()
            candidate=store.peek()
            plans=planned_turns(diar.segments(),diar.covered_seconds(),stopped) if diar else []
            selected=[p for p in plans if candidate and candidate[2]/1000<=p[0]<candidate[3]/1000]
            ready=not diar or not candidate or (diar.covered_seconds()*1000>=candidate[3]-20 and all(p[3] for p in selected))
            if stopped:ready=True
            job=store.claim() if ready else None
            if job:
                ident,path,start,end=job
                try:
                    segments=[]
                    if diar:
                        for i,(a,b,speaker,_) in enumerate(selected):
                            pcm=slice_recording(store.root,store.rows(),a,b)
                            if not len(pcm):continue
                            with contextlib.redirect_stdout(sys.stderr):
                                result=session.transcribe((pcm,16000),language='Korean',max_new_tokens=512)
                            segments.append({'id':f'{ident}_{i}','start':round(a*1000),'end':round(b*1000),'text':result.text.strip(),'speaker':speaker})
                    else:
                        with contextlib.redirect_stdout(sys.stderr):
                            from diarization import read_pcm
                            result=session.transcribe((read_pcm(store.root/path),16000),language='Korean',max_new_tokens=512)
                        segments=[{'id':str(ident),'start':start,'end':end,'text':result.text.strip(),'speaker':'unknown'}]
                    store.complete(ident,{'segments':segments})
                    for segment in segments:
                        if segment['text']:emit({'type':'segment','segment':segment})
                except Exception as exc:
                    store.fail(ident,exc)
                    emit({'type':'error','message':f'구간 {ident} 전사 실패. 오디오는 보존됩니다: {exc}'})
            status=store.status()
            emit({'type':'status',**status,'state':'남은 구간 처리 중' if stopped else '녹음 중'})
            if stopped and not job:
                if status['pending']:
                    failed=True
                    emit({'type':'error','message':'전사에 실패한 구간이 있습니다. 세션 복구 명령으로 재시도하세요.'})
                break
            if not job:
                # Block on command briefly; the capture thread continues spooling.
                try: inbox.put(inbox.get(timeout=.2))
                except queue.Empty: pass
    finally:
        if not stopped:
            try: cap.stop()
            except Exception as exc: emit({'type':'error','message':str(exc)})
        while not audio.empty():
            item=audio.get(); store.add(item['path'],item['start'],item['end'])
        (store.root/'metrics.json').write_text(json.dumps({'peak_rss_bytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'diarization_enabled':diar is not None,'audio_end_ms':max((r[3] for r in store.rows()),default=0)},indent=2))
        if diar:diar.close()
        store.close()
    emit({'type':'stopped','session':Path(args.session).name})
    return 1 if failed else 0

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--model',required=True)
    parser.add_argument('--session',required=True)
    parser.add_argument('--device',type=int)
    parser.add_argument('--chunk-seconds',type=int,default=2,choices=range(2,16))
    parser.add_argument('--resume',action='store_true')
    parser.add_argument('--input-wav')
    parser.add_argument('--diar-model')
    parser.add_argument('--diar-library')
    parser.add_argument('--quality',action='store_true')
    parser.add_argument('--refine-only',action='store_true')
    parser.add_argument('--community-python')
    parser.add_argument('--community-model')
    parser.add_argument('--aligner-model')
    parser.add_argument('--speaker-count',type=int)
    parser.add_argument('--speaker-count-mode',choices=['maximum','exact'])
    parser.add_argument('--realtime-input',action='store_true',help='Test WAV replay at capture speed (quality pipeline only)')
    args=parser.parse_args()
    try:
        if args.refine_only:
            from finalize_diarization import finalize
            emit({'type':'hello','session':Path(args.session).name,'protocol':2,'features':['speaker_refinement']})
            if args.community_python:
                from community_pipeline import finalize as community_finalize
                community_finalize(args.session,args,emit)
            else:finalize(args.session,args.diar_library,args.diar_model,emit)
            emit({'type':'stopped','session':Path(args.session).name})
            sys.exit(0)
        if args.resume:
            recovery=Store(args.session); recovery.recover(); recovery.retry(); recovery.close()
        if args.quality:
            config_path=Path(args.session)/'pipeline.json'
            config=json.loads(config_path.read_text()) if config_path.exists() else {}
            if config.get('workflow')=='text-then-community':
                from text_worker import run as text_run
                sys.exit(text_run(args,emit))
            from quality_worker import run as quality_run
            sys.exit(quality_run(args,emit))
        sys.exit(run(args))
    except Exception as exc:
        emit({'type':'error','message':str(exc),'fatal':True}); sys.exit(1)
