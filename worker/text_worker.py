"""Workflow 3: local text-only STT; no real-time speaker model is imported or loaded."""
import contextlib,hashlib,json,math,queue,resource,sys,threading,time,gc
from pathlib import Path
from capture import Capture
from endpoints import PauseHistory
from quality import RevisionStore,write_atomic
from dictionary import snapshot,validate_term,context_text,postprocess
from store import Store

def committed_cursor(saved,cursor):
    return max(float(cursor),max((s['end']/1000 for s in saved if s.get('textState')=='stable'),default=0))

def run(args,emit):
    root=Path(args.session).resolve();store=Store(root);store.recover();revisions=RevisionStore(store)
    config_path=root/'pipeline.json';config=json.loads(config_path.read_text())
    dictionary=config.get('dictionary',snapshot([]));dictionary=snapshot([validate_term(t) for t in dictionary.get('terms',[])],dictionary.get('project',''),root.name,dictionary.get('enabled',True))
    config={**config,'workflow':'text-then-community','geometry':{'silenceSeconds':.9,'maxPhraseSeconds':20,'quietDbfs':-50},'asrModel':Path(args.model).name,'sourceHash':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()};write_atomic(config_path,config)
    if args.resume:
        from recording import ensure_recording
        ensure_recording(root)
    emit({'type':'hello','session':root.name,'protocol':2,'features':['dictionary','revisions','ack','text-only','community-after-stop']})
    for s in revisions.all():emit({'type':'segment','session':root.name,'segment':s})
    saved=revisions.all();done=args.resume and not store.status()['pending'] and saved and all(s.get('textState')=='stable' for s in saved)
    audio=queue.Queue();inbox=queue.Queue()
    if getattr(args,'system_audio_helper',None) and not args.resume and not args.input_wav:
        from system_capture import SystemCapture
        cap=SystemCapture(root,audio.put,helper=args.system_audio_helper,app_pid=args.system_audio_pid,device=args.device,seconds=args.chunk_seconds)
    else:cap=Capture(root,audio.put,device=args.device,seconds=args.chunk_seconds)
    hints=PauseHistory(root)
    realtime=getattr(args,'realtime_input',False);stopped=args.resume or bool(args.input_wav) and not realtime;session=None;failed=False;times=[];fed=set();cursor=committed_cursor(saved,revisions.get('cursor',0));pending_dictionary=None
    def commands():
        for line in sys.stdin:
            try:
                if len(line)>1_000_000:raise ValueError('너무 큰 명령')
                c=json.loads(line)
                if c.get('type') not in ('stop','retry','dictionary','ack','resend'):raise ValueError('지원하지 않는 명령')
                if c['type']=='stop':cap.stop()
                inbox.put(c)
            except Exception:emit({'type':'error','message':'워커 명령을 읽지 못했습니다.'})
        cap.stop();inbox.put({'type':'stop'})
    try:
        if not done:
            if args.input_wav and realtime:
                def replay():
                    try:cap.import_wav(args.input_wav,realtime=True)
                    except Exception as e:cap.error=str(e);cap.finished.set()
                cap.thread=threading.Thread(target=replay,daemon=True);cap.thread.start()
            elif args.input_wav:cap.import_wav(args.input_wav)
            elif not stopped:cap.start()
            threading.Thread(target=commands,daemon=True).start()
            emit({'type':'status',**store.status(),'state':'STT 모델 로딩 중 / 오디오 저장 중','diagnostics':cap.diagnostics})
            with contextlib.redirect_stdout(sys.stderr):
                from mlx_qwen3_asr import Session
                session=Session(model=str(Path(args.model).resolve()))
            from pcm import read_pcm,slice_recording
            context=context_text(dictionary,session.tokenizer.encode)
            emit({'type':'ready','session':root.name})
            while True:
                while not inbox.empty():
                    c=inbox.get()
                    if c['type']=='stop':cap.stop();stopped=True
                    elif c['type']=='ack':
                        if isinstance(c.get('id'),str) and isinstance(c.get('revision'),int) and c['revision']>0:revisions.ack(c['id'],c['revision'])
                    elif c['type']=='resend':
                        for s in revisions.all():emit({'type':'segment','session':root.name,'segment':s})
                    elif c['type']=='retry':failed=False;store.retry()
                    elif c['type']=='dictionary':
                        d=c['snapshot'];pending_dictionary=(snapshot([validate_term(t) for t in d.get('terms',[])],d.get('project',''),root.name,d.get('enabled',True)),max((r[3]/1000 for r in store.rows()),default=0))
                if cap.stop_event.is_set() and not stopped:cap.stop();stopped=True
                if realtime and cap.finished.is_set():
                    if cap.error:raise RuntimeError(cap.error)
                    stopped=True
                while not audio.empty():
                    item=audio.get();store.add(item['path'],item['start'],item['end'])
                rows=store.rows();available=max((r[3]/1000 for r in rows),default=0)
                for r in rows:
                    if r[1] not in fed:hints.add(read_pcm(root/r[1]),r[2]/1000);fed.add(r[1])
                did_work=False
                while not failed and cursor<available-.02:
                    plan=hints.plan(cursor,available,stopped)
                    if not plan:break
                    a,b,consumed,closed=plan
                    if not closed:break
                    if max(consumed,b)<=cursor+1e-6:break
                    if pending_dictionary and a>=pending_dictionary[1]-.01:
                        dictionary=pending_dictionary[0];pending_dictionary=None;context=context_text(dictionary,session.tokenizer.encode);config['dictionary']=dictionary;write_atomic(config_path,config);write_atomic(root/'dictionary-snapshot.json',dictionary);emit({'type':'config_applied','session':root.name,'revision':dictionary['revision'],'afterSample':round(a*16000)})
                    if b-a>=.18:
                        pcm=slice_recording(root,rows,a,b);began=time.monotonic()
                        try:
                            with contextlib.redirect_stdout(sys.stderr):result=session.transcribe((pcm,16000),language='Korean',context=context,max_new_tokens=min(512,max(24,math.ceil((b-a)*40))))
                            raw=result.text.strip();text,changes=postprocess(raw,dictionary);times.append({'seconds':b-a,'processingSeconds':round(time.monotonic()-began,4),'provisional':False})
                            s={'id':f'u_{round(a*16000):012d}','start':round(a*1000),'end':round(b*1000),'text':text,'rawText':raw,'speaker':'pending','speakerState':'unknown','reviewReasons':[],'textState':'stable','dictionaryRevision':dictionary['revision'],'suggestions':changes}
                            value=revisions.put(s)
                            if value:emit({'type':'segment','session':root.name,'segment':value})
                        except Exception as e:failed=True;emit({'type':'error','message':f'전사 실패. 원음은 보존됩니다: {e}'});break
                    cursor=max(consumed,b);revisions.set('cursor',cursor);did_work=True
                if not failed:
                    for r in rows:
                        if r[4]!='done' and r[3]/1000<=cursor+.02:store.complete(r[0],{'segments':[]})
                emit({'type':'status',**store.status(),'state':'남은 텍스트 전사 중' if stopped else '녹음 중 · 텍스트 전사','pendingAudioSeconds':round(max(0,available-cursor),2),'diagnostics':{**cap.diagnostics,'updatePolicy':'endpoint-only','diarizationRealtime':False}})
                if stopped and (failed or cursor>=available-.02):break
                if stopped and not did_work:raise RuntimeError('남은 전사 범위를 확인하지 못했습니다. 원음을 보존합니다.')
                if not did_work:
                    try:inbox.put(inbox.get(timeout=.2))
                    except queue.Empty:pass
    except BaseException:failed=True;raise
    finally:
        if not stopped:cap.stop()
        while not audio.empty():
            item=audio.get();store.add(item['path'],item['start'],item['end'])
        revisions.export();write_atomic(root/'metrics.json',{'schemaVersion':3,'failed':failed,'inference':times,'diarizationRealtime':False,'audio_end_ms':max((r[3] for r in store.rows()),default=0),'peak_rss_bytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'diagnostics':cap.diagnostics});store.close()
        session=None;gc.collect()
        if not done:
            import mlx.core as mx
            mx.clear_cache()
    if not failed:
        try:
            from community_pipeline import finalize
            finalize(root,args,emit)
        except Exception as e:failed=True;emit({'type':'error','message':str(e)})
    emit({'type':'stopped','session':root.name});return 1 if failed else 0
