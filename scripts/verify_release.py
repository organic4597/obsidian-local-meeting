#!/usr/bin/env python3
"""Inaudible release checks using disposable copies of local meeting audio.
No microphone, playback, API requests or calendar writes. The report contains no transcript.
"""
import argparse,hashlib,json,os,queue,signal,sqlite3,subprocess,sys,tempfile,threading,time,uuid,wave
from pathlib import Path
REPO=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(REPO/'worker'))
from dictionary import snapshot

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def audio(root):
    with wave.open(str(root/'recording.wav'),'rb') as w:return w.getnframes(),w.readframes(w.getnframes())
def source_hashes(root):return {n:digest(root/n) for n in ['recording.wav','transcript.json','queue.sqlite','pipeline.json']}

def verify(settings,output,seconds=120):
    config=json.loads(Path(settings).read_text());report={'schemaVersion':1,'audioPlayback':False,'apiCalls':False,'checks':[]}
    modelargs=['--model',config['model'],'--community-python',config['communityPython'],'--community-model',config['communityModel'],'--aligner-model',config['alignerModel']]
    with tempfile.TemporaryDirectory(prefix='lm-release-') as tmp:
        temp=Path(tmp).resolve()
        with wave.open(str(Path(config['lastSession'])/'recording.wav'),'rb') as w:
            assert (w.getnchannels(),w.getsampwidth(),w.getframerate())==(1,2,16000)
            sample=w.readframes(24*16000)
        assert len(sample)>=32000,'A meeting recording of at least one second is required.'
        def prepare(duration):
            root=temp/str(uuid.uuid4());root.mkdir();data=(sample*((duration*32000+len(sample)-1)//len(sample)))[:duration*32000]
            with wave.open(str(root/'input.wav'),'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(data)
            (root/'pipeline.json').write_text(json.dumps({'schemaVersion':3,'workflow':'text-then-community','streamingSTT':True,'retranscribeAfterStop':True,'liveSpeakers':False,'voiceProfiles':False,'speakerCount':4,'speakerCountMode':'maximum','dictionary':snapshot([])}))
            return root
        def start(root,flags):
            command=[config['python'],'-u',str(REPO/'worker/main.py'),'--session',str(root),*modelargs,*flags]
            err=(root/('stderr-'+str(uuid.uuid4())+'.log')).open('w');p=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,text=True,start_new_session=True);err.close()
            events=[];incoming=queue.Queue()
            def read():
                try:
                    for line in p.stdout:incoming.put(json.loads(line))
                except Exception as e:incoming.put({'type':'error','message':str(e)})
                finally:incoming.put(None)
            threading.Thread(target=read,daemon=True).start();return p,incoming,events
        def collect(handle,timeout=300,kill_after=None):
            p,incoming,events=handle;began=time.monotonic();marked=False
            try:
                while time.monotonic()-began<timeout:
                    if kill_after and time.monotonic()-began>=kill_after and any(e['type']=='segment' and e['segment'].get('textState')=='stable' for e in events):
                        os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=10);return events,time.monotonic()-began
                    try:e=incoming.get(timeout=.2)
                    except queue.Empty:continue
                    if e is None:break
                    events.append(e)
                    if e['type']=='segment' and not marked:
                        marked=True;p.stdin.write(json.dumps({'type':'suspect','id':e['segment']['id']})+'\n');p.stdin.flush()
                    if e['type']=='postprocess_stage':print(json.dumps({'stage':e['stage'],'status':e['status'],'cached':e.get('cached',False),'elapsedSeconds':round(time.monotonic()-began,2)}),flush=True)
                else:raise TimeoutError('Release verification worker timed out')
                p.wait(timeout=20);assert p.returncode==0, 'Worker failed; private diagnostic log remains only in the disposable session.'
                assert not any(e['type']=='error' for e in events),'Worker emitted an error'
                assert any(e['type']=='speaker_refinement' for e in events),'No final speaker result'
                return events,time.monotonic()-began
            finally:
                if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=10)
                p.stdin.close();p.stdout.close()
        def stages(events):return {e['stage']:e for e in events if e['type']=='postprocess_stage'}
        root=prepare(seconds);print('CHECK backlog processing',flush=True)
        initial,elapsed=collect(start(root,['--input-wav',str(root/'input.wav')]))
        frames,pcm=audio(root);assert frames==seconds*16000
        with wave.open(str(root/'input.wav'),'rb') as w:assert pcm==w.readframes(w.getnframes())
        original=source_hashes(root);firstpass=[e for e in initial if e['type']=='speaker_refinement'][-1]['passId']
        with sqlite3.connect(root/'queue.sqlite') as db:assert db.execute("SELECT COUNT(*) FROM chunks WHERE state!='done'").fetchone()[0]==0
        transcript=json.loads((root/'transcript.json').read_text())['segments'];assert len({s['id'] for s in transcript})==len(transcript);assert all(s['textState']=='stable' for s in transcript)
        report['checks'].append({'name':'backlog','audioSeconds':seconds,'elapsedSeconds':round(elapsed,2),'segments':len(transcript),'pcmExact':True,'pending':0})
        for n in range(3):
            print('CHECK cached retry',n+1,flush=True);events,elapsed=collect(start(root,['--resume']));states=stages(events)
            assert all(states[k].get('cached') for k in ['asr','rescan','diarization']),'Completed stages were recomputed'
            assert source_hashes(root)==original,'A completed source file changed'
            assert [e for e in events if e['type']=='speaker_refinement'][-1]['passId']==firstpass
            report['checks'].append({'name':'cached-retry','attempt':n+1,'elapsedSeconds':round(elapsed,2),'sourceFilesUnchanged':True})
        artifact=root/stages(initial)['diarization']['artifact'];artifact.write_text('damaged-cache-test')
        print('CHECK damaged model artifact',flush=True);events,elapsed=collect(start(root,['--resume']));assert not stages(events)['diarization'].get('cached');assert source_hashes(root)==original
        report['checks'].append({'name':'damaged-cache-recomputed','elapsedSeconds':round(elapsed,2),'sourceFilesUnchanged':True})
        crash=prepare(30);handle=start(crash,['--input-wav',str(crash/'input.wav'),'--realtime-input'])
        # Wait for actual worker ownership, then reject a simultaneous second worker.
        limit=time.monotonic()+15
        while not (crash/'.worker.lock').exists():
            assert time.monotonic()<limit;time.sleep(.05)
        duplicate=subprocess.run([config['python'],'-u',str(REPO/'worker/main.py'),'--session',str(crash),*modelargs,'--resume'],capture_output=True,text=True,timeout=15)
        assert duplicate.returncode!=0 and '다른 후처리' in duplicate.stdout,'Concurrent worker was not rejected'
        print('CHECK forced interruption and malformed WAV header',flush=True);before_events,_=collect(handle,kill_after=24)
        before_frames,before_pcm=audio(crash);assert before_frames>=16000
        wav=crash/'recording.wav'
        with wav.open('r+b') as f:f.seek(4);f.write(bytes(4));f.seek(40);f.write(bytes(4))
        damaged=wav.read_bytes();events,elapsed=collect(start(crash,['--resume']));assert audio(crash)==(before_frames,before_pcm),'Recovered PCM changed'
        assert (crash/'recording.wav.pre-recovery.bak').read_bytes()==damaged,'Recovery backup missing or different'
        after=json.loads((crash/'transcript.json').read_text())['segments'];assert all(s['textState']=='stable' for s in after);assert len(after)==len({s['id'] for s in after})
        stable={e['segment']['id']:e['segment']['text'] for e in before_events if e['type']=='segment' and e['segment'].get('textState')=='stable'}
        assert stable,'The interruption must include at least one committed utterance'
        assert all(any(s['id']==ident and s['text']==text for s in after) for ident,text in stable.items()),'Committed speech changed'
        report['checks'].append({'name':'kill-recover','capturedSeconds':before_frames/16000,'elapsedSeconds':round(elapsed,2),'pcmExact':True,'wavBackupExact':True,'duplicateWorkerRejected':True,'stableSegmentsRetained':len(stable)})
        report['result']='pass';Path(output).write_text(json.dumps(report,ensure_ascii=False,indent=2));print('PASS all release checks (inaudible)',flush=True)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--settings',required=True);p.add_argument('--output',required=True);p.add_argument('--seconds',type=int,default=120);args=p.parse_args()
    if not 24<=args.seconds<=1800:p.error('--seconds must be between 24 and 1800')
    verify(args.settings,args.output,args.seconds)
