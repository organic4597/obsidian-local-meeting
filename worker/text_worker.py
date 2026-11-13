"""Local STT with optional isolated rolling Community-1 and full offline refinement."""
import contextlib,hashlib,json,math,queue,resource,sys,threading,time,gc
from pathlib import Path
from capture import Capture
from endpoints import PauseHistory
from quality import RevisionStore,write_atomic
from dictionary import snapshot,validate_term,postprocess
from store import Store

def committed_cursor(saved,cursor):
    return max(float(cursor),max((s['end']/1000 for s in saved if s.get('textState')=='stable'),default=0))

def run(args,emit):
    root=Path(args.session).resolve();store=Store(root);store.recover();revisions=RevisionStore(store)
    config_path=root/'pipeline.json';config=json.loads(config_path.read_text())
    dictionary=config.get('dictionary',snapshot([]));dictionary=snapshot([validate_term(t) for t in dictionary.get('terms',[])],dictionary.get('project',''),root.name,dictionary.get('enabled',True))
    config={**config,'workflow':'text-then-community','geometry':{'silenceSeconds':.9,'maxPhraseSeconds':20,'quietDbfs':-50},'asrGuardVersion':1,'dictionaryPromptHints':False,'asrModel':Path(args.model).name,'sourceHash':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()};write_atomic(config_path,config)
    if args.resume:
        from recording import ensure_recording
        ensure_recording(root)
    emit({'type':'hello','session':root.name,'protocol':2,'features':['dictionary','revisions','ack','text-only','community-after-stop']})
    emit({'type':'postprocess_stage','session':root.name,'stage':'asr','inputKey':hashlib.sha256(config_path.read_bytes()).hexdigest(),'status':'running'})
    for s in revisions.all():emit({'type':'segment','session':root.name,'segment':s})
    saved=revisions.all();rows=store.rows();done=args.resume and bool(rows) and not store.status()['pending'] and all(s.get('textState')=='stable' for s in saved) and revisions.get('cursor',0)>=max(r[3] for r in rows)/1000
    streaming=bool(config.get('streamingSTT'));phrase=None;last_labels=0.
    audio=queue.Queue();inbox=queue.Queue()
    if getattr(args,'system_audio_helper',None) and not args.resume and not args.input_wav:
        from system_capture import SystemCapture
        cap=SystemCapture(root,audio.put,helper=args.system_audio_helper,app_pid=args.system_audio_pid,device=args.device,seconds=1 if streaming else args.chunk_seconds)
    else:cap=Capture(root,audio.put,device=args.device,seconds=1 if streaming else args.chunk_seconds)
    hints=PauseHistory(root)
    realtime=getattr(args,'realtime_input',False);stopped=args.resume or bool(args.input_wav) and not realtime;session=None;failed=False;times=[];fed=set();cursor=committed_cursor(saved,revisions.get('cursor',0));pending_dictionary=None;live=None
    if config.get('liveSpeakers') and not done and not args.resume and (not args.input_wav or realtime):
        from live_speakers import LiveSpeakers
        try:live=LiveSpeakers(args,root)
        except (OSError,ValueError):emit({'type':'status',**store.status(),'state':'화자 분석 준비 실패 · 텍스트 전사 계속'})
    def commands():
        for line in sys.stdin:
            try:
                if len(line)>1_000_000:raise ValueError('너무 큰 명령')
                c=json.loads(line)
                if c.get('type') not in ('stop','retry','dictionary','ack','resend','suspect'):raise ValueError('지원하지 않는 명령')
                if c['type']=='stop':
                    try:cap.stop()
                    finally:inbox.put(c)
                else:inbox.put(c)
            except Exception:emit({'type':'error','message':'워커 명령을 읽지 못했습니다.'})
        try:cap.stop()
        except Exception:pass
        finally:inbox.put({'type':'stop'})
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
            def clocks():
                previous=None
                while not cap.finished.is_set():
                    d=cap.diagnostics
                    if d.get('captureWallTimeMs') and d.get('samples')!=previous:
                        previous=d['samples'];emit({'type':'capture_clock','session':root.name,'samples':d['samples'],'rate':d['sampleRate'],'wallTimeMs':d['captureWallTimeMs']})
                    cap.finished.wait(.5)
            threading.Thread(target=clocks,daemon=True).start()
            emit({'type':'status',**store.status(),'state':'STT 모델 로딩 중 / 오디오 저장 중','diagnostics':cap.diagnostics})
            with contextlib.redirect_stdout(sys.stderr):
                from mlx_qwen3_asr import Session
                session=Session(model=str(Path(args.model).resolve()))
            from pcm import read_pcm,slice_recording
            context=''
            if streaming and not all(hasattr(session,k) for k in ('init_streaming','feed_audio','finish_streaming')):raise RuntimeError('설치된 STT 라이브러리에 스트리밍 API가 없습니다. 실행 환경을 업데이트해 주세요.')
            emit({'type':'ready','session':root.name})
            while True:
                while not inbox.empty():
                    c=inbox.get()
                    if c['type']=='stop':cap.stop();stopped=True
                    elif c['type']=='ack':
                        if isinstance(c.get('id'),str) and isinstance(c.get('revision'),int) and c['revision']>0:revisions.ack(c['id'],c['revision'])
                    elif c['type']=='suspect':
                        ids=revisions.get('suspectIds',[]);ident=c.get('id');
                        if isinstance(ident,str):revisions.set('suspectIds',list(dict.fromkeys([*ids,ident]))[-500:])
                    elif c['type']=='resend':
                        for s in revisions.all():emit({'type':'segment','session':root.name,'segment':s})
                    elif c['type']=='retry':failed=False;phrase=None;store.retry()
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
                did_work=False;turns=[];horizon=available
                if live:
                    live.update(available);processed,turns,live_error=live.snapshot()
                    if processed>last_labels and turns:
                        from streaming_phrase import relabel_recent
                        relabel_recent(revisions,turns,processed,emit,root.name);last_labels=processed
                while not failed and cursor<horizon-.02:
                    plan=hints.plan(cursor,horizon,stopped)
                    if not streaming and live and turns:
                        from live_speakers import change_boundary
                        boundary=change_boundary(turns,round(cursor*1000),round(horizon*1000))
                        if boundary is not None and (not plan or boundary/1000<plan[1]):plan=(cursor,boundary/1000,boundary/1000,True)
                    if not plan:break
                    a,b,consumed,closed=plan
                    if not closed and not streaming:break
                    if max(consumed,b)<=cursor+1e-6:break
                    if pending_dictionary and a>=pending_dictionary[1]-.01:
                        dictionary=pending_dictionary[0];pending_dictionary=None;context='';config['dictionary']=dictionary;write_atomic(config_path,config);write_atomic(root/'dictionary-snapshot.json',dictionary);emit({'type':'config_applied','session':root.name,'revision':dictionary['revision'],'afterSample':round(a*16000)})
                    if b-a>=.18:
                        began=time.monotonic()
                        try:
                            from asr_guard import audible
                            if phrase is None and not audible(slice_recording(root,rows,a,b)):
                                cursor=max(consumed,b);revisions.set('cursor',cursor);did_work=True;continue
                            if streaming:
                                from streaming_phrase import StreamingPhrase
                                if phrase is None:phrase=StreamingPhrase(session,a,context)
                                a=phrase.start
                                target=max(phrase.until,b if closed else min(b,phrase.until+1.))
                                if not closed and target-phrase.until<1.-1e-5:break
                                with contextlib.redirect_stdout(sys.stderr):
                                    raw=phrase.feed(slice_recording(root,rows,phrase.until,target),target) if target>phrase.until+1e-5 else phrase.state.text.strip()
                                    if closed:raw=phrase.finish()
                                b=target
                            else:
                                pcm=slice_recording(root,rows,a,b)
                                with contextlib.redirect_stdout(sys.stderr):result=session.transcribe((pcm,16000),language='Korean',context=context,max_new_tokens=min(512,max(24,math.ceil((b-a)*40))))
                                raw=result.text.strip()
                            from asr_guard import audible,hint_echo
                            rejected='dictionary-echo' if hint_echo(raw,dictionary) else 'near-silence' if not audible(slice_recording(root,rows,a,b)) else ''
                            suppressed=raw if rejected else ''
                            if rejected:raw=''
                            text,changes=postprocess(raw,dictionary);times.append({'seconds':b-a,'processingSeconds':round(time.monotonic()-began,4),'provisional':not closed})
                            speaker='pending'
                            if live and turns:
                                from live_speakers import speaker_at
                                speaker=speaker_at(turns,round(a*1000),round(b*1000))
                            s={'id':f'u_{round(a*16000):012d}','start':round(a*1000),'end':round(b*1000),'text':text,'rawText':raw,'speaker':speaker,'speakerState':'overlap' if speaker=='overlap' else 'unknown','reviewReasons':['실시간 잠정 화자 · 종료 후 재분석'] if live else [],'asrSuppression':rejected,'suppressedRawText':suppressed,'streamRewrites':phrase.rewrites if phrase else 0,'textState':'stable' if closed else 'provisional','dictionaryRevision':dictionary['revision'],'suggestions':changes}
                            value=revisions.put(s)
                            if value:emit({'type':'segment','session':root.name,'segment':value})
                            if not closed:did_work=True;continue
                            phrase=None
                        except Exception as e:failed=True;emit({'type':'error','message':f'전사 실패. 원음은 보존됩니다: {e}'});break
                    cursor=max(consumed,b);revisions.set('cursor',cursor);did_work=True
                if not failed:
                    for r in rows:
                        if r[4]!='done' and r[3]/1000<=cursor+.02:store.complete(r[0],{'segments':[]})
                emit({'type':'status',**store.status(),'state':'남은 텍스트 전사 중' if stopped else '녹음 중 · 텍스트 전사','pendingAudioSeconds':round(max(0,available-cursor),2),'diagnostics':{**cap.diagnostics,'updatePolicy':'streaming-1s' if streaming else 'endpoint-only','diarizationRealtime':bool(live),'liveSpeakerLagSeconds':round(max(0,available-live.processed),1) if live else None,'liveSpeakerError':live.error if live else ''}})
                if stopped and (failed or cursor>=available-.02):break
                if stopped and not did_work:raise RuntimeError('남은 전사 범위를 확인하지 못했습니다. 원음을 보존합니다.')
                if not did_work:
                    try:inbox.put(inbox.get(timeout=.2))
                    except queue.Empty:pass
            if failed:
                from stage_artifacts import digest_file
                emit({'type':'postprocess_stage','session':root.name,'stage':'asr','inputKey':digest_file(root/'pipeline.json'),'status':'failed','message':'전사 실패 · 원음을 보존했습니다.'})
            if not failed:
                revisions.export()
                from stage_artifacts import digest_file
                emit({'type':'postprocess_stage','session':root.name,'stage':'asr','inputKey':digest_file(root/'transcript.json'),'status':'succeeded'})
            if not failed and session and config.get('retranscribeAfterStop'):
                try:
                    emit({'type':'status',**store.status(),'state':'의심 구간 재전사 후보 생성 중'})
                    from postprocess_rescan import run as post_rescan
                    post_rescan(root,args,emit,session)
                except Exception as e:emit({'type':'status',**store.status(),'state':'재전사 후보 보류 · 처리 단계에서 다시 시도 가능','diagnostics':{**cap.diagnostics,'retranscriptionError':str(e)}})
    except BaseException as e:
        failed=True
        emit({'type':'postprocess_stage','session':root.name,'stage':'asr','inputKey':hashlib.sha256(str(root).encode()).hexdigest(),'status':'failed','message':str(e)})
        raise
    finally:
        from worker_cleanup import cleanup
        def drain():
            errors=[]
            while not audio.empty():
                item=audio.get()
                try:store.add(item['path'],item['start'],item['end'])
                except Exception as e:errors.append(str(e))
            if errors:raise RuntimeError('; '.join(errors))
        def mark_cleanup_error(error):
            nonlocal failed
            failed=True
        errors=cleanup([('오디오 종료',lambda:cap.stop() if not stopped else None),('화자 종료',lambda:live.close() if live else None),('큐 등록',drain),('전사 체크포인트',revisions.export),('메트릭',lambda:write_atomic(root/'metrics.json',{'schemaVersion':3,'failed':failed,'inference':times,'diarizationRealtime':bool(live),'audio_end_ms':max((r[3] for r in store.rows()),default=0),'peak_rss_bytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'diagnostics':cap.diagnostics})),('DB 종료',store.close)],mark_cleanup_error)
        if errors:failed=True;emit({'type':'error','message':'정리 단계 오류 · 원음으로 복구 가능: '+'; '.join(errors)})
        phrase=None;session=None;gc.collect()
        if not done:
            try:
                import mlx.core as mx
                mx.clear_cache()
            except Exception:pass
    if not failed:
        try:
            from community_pipeline import finalize
            finalize(root,args,emit)
        except Exception as e:failed=True;emit({'type':'error','message':str(e)})
    emit({'type':'stopped','session':root.name});return 1 if failed else 0
