"""Protocol 2: durable phrase revisions and a separate audio acquisition queue."""
import contextlib
import hashlib
import json
import math
import queue
import resource
import sys
import threading
import time
from pathlib import Path
from capture import Capture
from endpoints import PauseHistory
from finalize_diarization import finalize
from store import Store
from quality import Activity,RevisionStore,phrase_end,write_atomic
from dictionary import snapshot,validate_term,context_text,postprocess

def run(args,emit):
    root=Path(args.session).resolve();store=Store(root);store.recover();revisions=RevisionStore(store)
    if args.resume and store.rows():
        from recording import ensure_recording
        ensure_recording(root)
    config_path=root/'pipeline.json'
    config=json.loads(config_path.read_text()) if config_path.exists() else {'schemaVersion':2,'dictionary':snapshot([])}
    saved=revisions.all()
    if args.resume and not store.status()['pending'] and saved and all(s.get('textState')=='stable' for s in saved):
        emit({'type':'hello','session':root.name,'protocol':2,'features':['dictionary','activity','revisions','ack']})
        emit({'type':'ready','session':root.name})
        for s in saved:emit({'type':'segment','session':root.name,'segment':s})
        previous=json.loads((root/'metrics.json').read_text()) if (root/'metrics.json').exists() else {}
        emit({'type':'status','pending':0,'lag':0,'pendingAudioSeconds':0,'state':'복구 완료','diagnostics':previous.get('diagnostics',{})})
        try:finalize(root,args.diar_library,args.diar_model,emit,config.get('finalizeSpeakers',True))
        finally:store.close()
        emit({'type':'stopped','session':root.name});return 0
    config={**config,'asrModel':Path(args.model).name,'asrConfigHash':hashlib.sha256((Path(args.model)/'config.json').read_bytes()).hexdigest(),
            'diarModel':Path(args.diar_model).name if args.diar_model else None,
            'geometry':{'maxPhraseSeconds':20,'updatePolicy':'endpoint-only','silenceSeconds':.9,'acousticQuietDbfs':-50,'onset':.6,'offset':.4,'overlapSeconds':.2},
            'sourceHash':hashlib.sha256(Path(__file__).read_bytes()+(Path(__file__).parent/'quality.py').read_bytes()).hexdigest(),
            'mode':'realtime-file' if getattr(args,'realtime_input',False) else 'offline-file' if args.input_wav else 'resume' if args.resume else 'microphone'}
    dictionary=config.get('dictionary',snapshot([]))
    dictionary=snapshot([validate_term(t) for t in dictionary.get('terms',[])],dictionary.get('project',''),root.name,dictionary.get('enabled',True))
    write_atomic(config_path,{**config,'schemaVersion':2,'dictionary':dictionary})
    write_atomic(root/'dictionary-snapshot.json',dictionary)
    inbox=queue.Queue();audio=queue.Queue();cap=Capture(root,audio.put,device=args.device,seconds=args.chunk_seconds)
    realtime=getattr(args,'realtime_input',False)
    if realtime and not args.input_wav:raise ValueError('실시간 파일 재생은 입력 WAV가 필요합니다.')
    stopped=args.resume or bool(args.input_wav) and not realtime;diar=None;failed=False;times=[];fed=set();activity=Activity(root);pause_history=PauseHistory(root)
    model=Path(args.model).expanduser().resolve()
    if not model.is_dir() or not (model/'config.json').is_file():raise ValueError('로컬 ASR 모델 폴더가 필요합니다.')
    def send(segment):
        if segment:emit({'type':'segment','session':root.name,'segment':segment})
    def commands():
        for line in sys.stdin:
            try:
                if len(line)>1_000_000:raise ValueError('너무 큰 워커 명령')
                c=json.loads(line)
                if c.get('type') not in ('stop','retry','dictionary','ack','resend'):raise ValueError('지원하지 않는 명령')
                if c['type']=='ack' and (not isinstance(c.get('id'),str) or not isinstance(c.get('revision'),int) or c['revision']<1):raise ValueError('잘못된 적용 확인')
                if c['type']=='stop':cap.stop()
                inbox.put(c)
            except Exception as exc:emit({'type':'error','message':str(exc)})
        cap.stop();inbox.put({'type':'stop'})
    cursor=float(revisions.get('cursor',0));current=None;pending_dictionary=None
    try:
        if args.input_wav and realtime:
            def replay():
                try:cap.import_wav(args.input_wav,realtime=True)
                except Exception as exc:cap.error=str(exc);cap.finished.set()
            cap.thread=threading.Thread(target=replay,daemon=True);cap.thread.start()
        elif args.input_wav:cap.import_wav(args.input_wav)
        elif not stopped:cap.start()
        threading.Thread(target=commands,daemon=True).start()
        emit({'type':'hello','session':root.name,'protocol':2,'features':['dictionary','activity','revisions','ack']})
        emit({'type':'status',**store.status(),'state':'모델 로딩 중 / 오디오 저장 중' if not stopped else '복구 중','diagnostics':cap.diagnostics})
        with contextlib.redirect_stdout(sys.stderr):
            from mlx_qwen3_asr import Session
            session=Session(model=str(model))
        from diarization import Diarizer,read_pcm,slice_recording
        if not args.diar_library or not args.diar_model:raise ValueError('화자 구분 모델과 라이브러리가 필요합니다.')
        diar=Diarizer(args.diar_library,args.diar_model)
        context=context_text(dictionary,session.tokenizer.encode)
        emit({'type':'ready','session':root.name})
        for s in revisions.all():send(s)
        # Unfinished utterances keep their ID after restart; no duplicate insertion.
        unfinished=[s for s in revisions.all() if s.get('textState')=='provisional']
        if unfinished:current=unfinished[-1];cursor=current['start']/1000
        while True:
            while not inbox.empty():
                c=inbox.get()
                if c['type']=='stop':
                    if not stopped:cap.stop();stopped=True
                elif c['type']=='ack':revisions.ack(str(c['id']),int(c['revision']))
                elif c['type']=='resend':
                    for s in revisions.all():send(s)
                elif c['type']=='retry':failed=False;store.retry();revisions.set('failedRange',None)
                elif c['type']=='dictionary':
                    try:
                        d=c['snapshot'];pending=snapshot([validate_term(t) for t in d.get('terms',[])],d.get('project',''),root.name,d.get('enabled',True))
                        boundary=max((r[3]/1000 for r in store.rows()),default=0)
                        pending_dictionary=(pending,boundary)
                    except Exception as exc:emit({'type':'error','message':f'사전 변경을 적용하지 못했습니다: {exc}'})
                elif c['type'] not in ('retry',):pass
            if cap.stop_event.is_set() and not stopped:cap.stop();stopped=True
            if realtime and cap.finished.is_set():
                if cap.error:raise RuntimeError(cap.error)
                stopped=True
            while not audio.empty():
                item=audio.get();store.add(item['path'],item['start'],item['end'])
            rows=store.rows();available=max((r[3]/1000 for r in rows),default=0)
            changed=False
            for r in rows:
                if r[1] not in fed:
                    pcm=read_pcm(root/r[1]);pause_history.add(pcm,r[2]/1000)
                    diar.push(pcm);fed.add(r[1]);changed=True
                    # Persist before the native runtime compacts old probabilities (>20 minutes).
                    activity.update(*diar.activity())
            if stopped and not diar.finished:diar.finish();changed=True;activity.update(*diar.activity())
            covered=min(available,diar.covered_seconds()) if not stopped else available
            # Revisit only recent evidence; no second ASR required for a better speaker boundary.
            if changed:
                for s in revisions.all():
                    if s['end']/1000<covered-10 or s['id']==(current or {}).get('id'):continue
                    evidence=activity.evidence(s['start']/1000,s['end']/1000)
                    updated={**s,**evidence}
                    if s['end']-s['start']<1000:updated['reviewReasons']=list(dict.fromkeys(updated['reviewReasons']+['짧은 발언 확인 필요']))
                    send(revisions.put(updated))
            did_work=False
            while not failed and cursor<covered-.02:
                runs=activity.runs(cursor,min(covered,cursor+24))
                plan=phrase_end(runs,cursor,covered,stopped,pauses=pause_history.pauses(cursor,min(covered,cursor+24)))
                if plan is None:
                    cursor=min(covered,cursor+15);revisions.set('cursor',cursor);continue
                a,b,closed=plan
                if current:a=current['start']/1000
                if pending_dictionary and not current and a>=pending_dictionary[1]-.01:
                    dictionary=pending_dictionary[0];pending_dictionary=None
                    context=context_text(dictionary,session.tokenizer.encode)
                    write_atomic(root/'dictionary-snapshot.json',dictionary)
                    write_atomic(config_path,{**config,'schemaVersion':2,'dictionary':dictionary})
                    emit({'type':'config_applied','session':root.name,'revision':dictionary['revision'],'afterSample':round(a*16000)})
                if not closed:break
                ident=current['id'] if current else f'u_{round(a*16000):012d}'
                pcm=slice_recording(root,rows,a,b)
                if not len(pcm):break
                try:
                    started=time.monotonic()
                    with contextlib.redirect_stdout(sys.stderr):result=session.transcribe((pcm,16000),language='Korean',context=context,max_new_tokens=min(512,max(24,math.ceil((b-a)*40))))
                    elapsed=time.monotonic()-started;times.append({'seconds':b-a,'processingSeconds':round(elapsed,4),'provisional':not closed})
                    raw=result.text.strip();text,changes=postprocess(raw,dictionary)
                    evidence=activity.evidence(a,b)
                    reasons=evidence['reviewReasons']+(['짧은 발언 확인 필요'] if b-a<1 else [])
                    s={'id':ident,'start':round(a*1000),'end':round(b*1000),'text':text,'rawText':raw,
                       **evidence,'reviewReasons':reasons,'textState':'stable' if closed else 'provisional',
                       'dictionaryRevision':dictionary['revision'],'suggestions':changes}
                    stored=revisions.put(s);send(stored);current=stored or s
                    did_work=True
                    if closed:
                        cursor=b;revisions.set('cursor',cursor);current=None
                    else:break
                except Exception as exc:
                    failed=True;emit({'type':'error','message':f'전사 구간 {a:.1f}~{b:.1f}초 처리 실패. 원음은 보존됩니다: {exc}'})
                    revisions.set('failedRange',[a,b]);break
            # Audio completion is independent of optional recent-evidence refinements.
            if not failed:
                for r in rows:
                    if r[4]!='done' and r[3]/1000<=cursor+.02:store.complete(r[0],{'segments':[]})
            status=store.status();pending_seconds=max(0,available-cursor)
            emit({'type':'status',**status,'state':'남은 구간 처리 중' if stopped else '녹음 중',
                  'pendingAudioSeconds':round(pending_seconds,2),'oldestUnprocessedAge':round(pending_seconds,2),
                  'captureCommittedSample':round(available*16000),'transcriptCommittedSample':round(cursor*16000),
                  'diagnostics':{**cap.diagnostics,'contextTerms':len(dictionary['terms']),'contextTokens':len(session.tokenizer.encode(context)),'dictionaryRevision':dictionary['revision'],
                  'updatePolicy':'endpoint-only','maxPhraseSeconds':20,'silenceSeconds':.9,'protocol':2,'reviewCount':sum(bool(s.get('reviewReasons') or any(c['state']=='suggested' for c in s.get('suggestions',[]))) for s in revisions.all())}})
            if stopped:
                if failed or cursor>=available-.02:break
                if not did_work:
                    failed=True;emit({'type':'error','message':'남은 음성 처리 범위를 확인하지 못했습니다. 원음을 보존합니다.'});break
            if failed and not stopped:
                # Wait for explicit retry; do not spin or silently skip a failed range.
                try:inbox.put(inbox.get(timeout=.5))
                except queue.Empty:pass
            elif not did_work:
                try:inbox.put(inbox.get(timeout=.2))
                except queue.Empty:pass
    except BaseException:
        failed=True
        raise
    finally:
        if not stopped:
            try:cap.stop()
            except Exception as exc:failed=True;emit({'type':'error','message':str(exc)})
        while not audio.empty():
            item=audio.get();store.add(item['path'],item['start'],item['end'])
        revisions.export()
        write_atomic(root/'metrics.json',{'schemaVersion':2,'peak_rss_bytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            'diarization_enabled':diar is not None,'audio_end_ms':max((r[3] for r in store.rows()),default=0),
            'inference':times,'failed':failed,'protocol':2,'dictionaryRevision':dictionary['revision'],
            'diagnostics':cap.diagnostics})
        if diar:diar.close()
        store.close()
    if not failed:
        del session
        import gc
        gc.collect()
        import mlx.core as mx
        mx.clear_cache()
        try:finalize(root,args.diar_library,args.diar_model,emit,config.get('finalizeSpeakers',True))
        except Exception as exc:
            emit({'type':'error','message':f'종료 후 화자 재분석 실패. 실시간 결과와 원음은 보존됐습니다. 세션 복구로 재시도하세요: {exc}'})
            failed=True
    emit({'type':'stopped','session':root.name})
    return 1 if failed else 0
