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
from pathlib import Path
from store import Store
from capture import Capture

OUTPUT=sys.stdout
LOCK=threading.Lock()
def emit(event):
    with LOCK:
        OUTPUT.write(json.dumps(event,ensure_ascii=False)+'\n'); OUTPUT.flush()

def commands(inbox):
    for line in sys.stdin:
        try:
            command=json.loads(line)
            if command.get('type') not in ('stop','retry'):
                raise ValueError('지원하지 않는 명령')
            inbox.put(command)
        except Exception as exc: emit({'type':'error','message':str(exc)})
    inbox.put({'type':'stop'})

def run(args):
    model=Path(args.model).expanduser().resolve()
    if not model.is_dir() or not (model/'config.json').is_file():
        raise ValueError('로컬 MLX 모델 폴더와 config.json이 필요합니다. 원격 모델 ID는 사용할 수 없습니다.')
    store=Store(args.session)
    store.recover()
    inbox=queue.Queue()
    audio=queue.Queue()  # Paths and timing only, never PCM
    cap=Capture(store.root,audio.put,device=args.device,seconds=args.chunk_seconds)
    threading.Thread(target=commands,args=(inbox,),daemon=True).start()
    stopped=args.resume
    failed=False
    try:
        # Start capture first. Model loading cannot block recording.
        if not stopped: cap.start()
        emit({'type':'status',**store.status(),'state':'모델 로딩 중 / 오디오 저장 중' if not stopped else '복구 중'})
        with contextlib.redirect_stdout(sys.stderr):
            from mlx_qwen3_asr import Session
            session=Session(model=str(model))
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
                emit({'type':'error','message':cap.error or '녹음이 중지되었습니다.'})
            while not audio.empty():
                item=audio.get(); store.add(item['path'],item['start'],item['end'])
            job=store.claim()
            if job:
                ident,path,start,end=job
                try:
                    with contextlib.redirect_stdout(sys.stderr):
                        result=session.transcribe(str(store.root/path),language='Korean',max_new_tokens=512)
                    segment={'id':str(ident),'start':start,'end':end,'text':result.text.strip(),'speaker':'unknown'}
                    store.complete(ident,segment)
                    if segment['text']: emit({'type':'segment','segment':segment})
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
        store.close()
    emit({'type':'stopped','session':Path(args.session).name})
    return 1 if failed else 0

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--model',required=True)
    parser.add_argument('--session',required=True)
    parser.add_argument('--device',type=int)
    parser.add_argument('--chunk-seconds',type=int,default=8,choices=range(2,16))
    parser.add_argument('--resume',action='store_true')
    args=parser.parse_args()
    try:
        if args.resume:
            recovery=Store(args.session); recovery.recover(); recovery.retry(); recovery.close()
        sys.exit(run(args))
    except Exception as exc:
        emit({'type':'error','message':str(exc),'fatal':True}); sys.exit(1)
