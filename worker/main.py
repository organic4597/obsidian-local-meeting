#!/usr/bin/env python3
"""Local STT and Community-1 worker. stdin commands / stdout JSONL events."""
import os
os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1')
import argparse,json,sys,threading
from pathlib import Path

OUTPUT=sys.stdout
LOCK=threading.Lock()
def emit(event):
    with LOCK:
        OUTPUT.write(json.dumps(event,ensure_ascii=False)+'\n');OUTPUT.flush()

def main(args):
    if args.refine_only or args.legacy_resume:
        if args.legacy_resume:
            from legacy_recovery import check_complete
            check_complete(args.session)
        from community_pipeline import finalize
        emit({'type':'hello','session':Path(args.session).name,'protocol':2,'features':['speaker_refinement']})
        finalize(args.session,args,emit)
        emit({'type':'stopped','session':Path(args.session).name})
        return 0
    if args.resume:
        from store import Store
        recovery=Store(args.session)
        try:recovery.recover();recovery.retry()
        finally:recovery.close()
    from text_worker import run
    return run(args,emit)

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--model',required=True);p.add_argument('--session',required=True)
    p.add_argument('--device',type=int);p.add_argument('--chunk-seconds',type=int,default=2,choices=range(2,16))
    p.add_argument('--system-audio-helper');p.add_argument('--system-audio-pid',type=int)
    p.add_argument('--resume',action='store_true');p.add_argument('--legacy-resume',action='store_true');p.add_argument('--input-wav')
    p.add_argument('--refine-only',action='store_true');p.add_argument('--community-python');p.add_argument('--community-model');p.add_argument('--aligner-model')
    p.add_argument('--speaker-count',type=int);p.add_argument('--speaker-count-mode',choices=['maximum','exact'])
    p.add_argument('--realtime-input',action='store_true',help='Test WAV replay at capture speed')
    try:sys.exit(main(p.parse_args()))
    except Exception as exc:emit({'type':'error','message':str(exc),'fatal':True});sys.exit(1)
