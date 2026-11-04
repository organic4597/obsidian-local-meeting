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
    if getattr(args,'retry_stage',None)=='rescan':
        emit({'type':'hello','session':Path(args.session).name,'protocol':2,'features':['postprocess']})
        from postprocess_rescan import run
        run(args.session,args,emit)
        emit({'type':'stopped','session':Path(args.session).name});return 0
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
        from quality import RevisionStore
        recovery=Store(args.session)
        try:
            revisions=RevisionStore(recovery);saved=revisions.all();rows=recovery.rows()
            complete=bool(rows) and not recovery.status()['pending'] and all(s.get('textState')=='stable' for s in saved) and revisions.get('cursor',0)>=max(r[3] for r in rows)/1000
            if complete:
                from legacy_recovery import check_complete
                check_complete(args.session)
            if complete:
                path=Path(args.session)/'transcript.json'
                if not path.exists():revisions.export()
                elif json.loads(path.read_text()).get('segments')!=saved:raise RuntimeError('전사 DB와 내보낸 파일이 다릅니다. 원본을 보존하고 확인이 필요합니다.')
            else:
                # A recovery may repair only the WAV header. Preserve original bytes first.
                audio=Path(args.session)/'recording.wav'
                if audio.exists():
                    import shutil,struct
                    with audio.open('rb') as f:header=f.read(44)
                    if len(header)==44 and struct.unpack_from('<I',header,40)[0]!=audio.stat().st_size-44:
                        backup=audio.with_suffix('.wav.pre-recovery.bak')
                        if not backup.exists():shutil.copyfile(audio,backup)
                recovery.recover();recovery.retry()
        finally:recovery.close()
        if complete:
            from community_pipeline import finalize
            from stage_artifacts import digest_file
            session=Path(args.session).name
            emit({'type':'hello','session':session,'protocol':2,'features':['revisions','postprocess']})
            for s in saved:emit({'type':'segment','session':session,'segment':s})
            emit({'type':'postprocess_stage','session':session,'stage':'asr','inputKey':digest_file(Path(args.session)/'transcript.json'),'status':'succeeded','cached':True})
            config=Path(args.session)/'pipeline.json'
            if config.exists() and json.loads(config.read_text()).get('retranscribeAfterStop'):
                try:
                    from postprocess_rescan import run
                    run(args.session,args,emit)
                except Exception:pass # Optional candidate failures are reported by the stage, not a loss of accepted text.
            finalize(args.session,args,emit);emit({'type':'stopped','session':session});return 0
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
    p.add_argument('--retry-stage',choices=['rescan']);p.add_argument('--realtime-input',action='store_true',help='Test WAV replay at capture speed')
    try:
        args=p.parse_args();Path(args.session).mkdir(parents=True,exist_ok=True)
        from stage_artifacts import session_lock
        with session_lock(args.session,'.worker.lock'):code=main(args)
        sys.exit(code)
    except Exception as exc:emit({'type':'error','message':str(exc),'fatal':True});sys.exit(1)
