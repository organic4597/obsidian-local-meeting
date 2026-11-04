"""Launch heavy diarization only after capture and ASR have released their resources."""
import json,subprocess,sys
from pathlib import Path

def finalize(root,args,emit):
    if not getattr(args,'community_python',None) or not getattr(args,'community_model',None):raise ValueError('Community-1 Python과 로컬 모델 경로를 연결해 주세요.')
    root=Path(root).resolve();config=json.loads((root/'pipeline.json').read_text()) if (root/'pipeline.json').exists() else {}
    count=getattr(args,'speaker_count',None)
    if count is None:count=config.get('speakerCount',0)
    mode=getattr(args,'speaker_count_mode',None) or config.get('speakerCountMode','maximum')
    command=[args.community_python,'-u',str(Path(__file__).with_name('community_diarize.py')),'--session',str(root),'--model',args.community_model,'--count',str(count),'--mode',mode]
    from stage_artifacts import StageArtifacts,session_lock,digest_file,model_digest
    import hashlib
    with session_lock(root):
        stages=StageArtifacts(root,emit)
        def fingerprint(path,stage):
            try:return model_digest(path)
            except Exception as e:stages.event(stage,hashlib.sha256(str(path).encode()).hexdigest(),'failed',message=str(e));raise
        audio=digest_file(root/'recording.wav');model=fingerprint(args.community_model,'diarization')
        def diarize(out,previous):
            result=None
            with subprocess.Popen(command+['--output-root',str(out)],stdout=subprocess.PIPE,stderr=sys.stderr,text=True) as process:
                for line in process.stdout:
                    if len(line)>8_000_000:process.terminate();raise RuntimeError('화자 결과가 너무 큽니다.')
                    event=json.loads(line)
                    if event.get('type')=='speaker_refinement':result=event
                    else:emit(event)
                code=process.wait()
            if code or result is None:raise RuntimeError('화자 구분이 완료되지 않았습니다. 완료된 결과와 원음은 보존됩니다.')
            features=out/'voice-features.json'
            return {'event':result,'features':str(features.relative_to(root)) if features.exists() else None}
        data=stages.run('diarization',{'audio':audio,'model':model,'count':count,'mode':mode,'voiceProfiles':config.get('voiceProfiles')},diarize)
        result=dict(data['event'])
        if data.get('features'):result['voiceFeaturesArtifact']=data['features']
        if getattr(args,'aligner_model',None) and config.get('workflow')=='text-then-community':
            from post_alignment import align
            result['alignments']=stages.run('alignment',{'audio':audio,'transcript':digest_file(root/'transcript.json'),'turns':result['turns'],'model':fingerprint(args.aligner_model,'alignment')},lambda out,previous:align(root,args.aligner_model,emit,result['turns'],out,previous),lambda values:all(not v.get('reviewRequired') for v in values.values()))
        result['applicationId']=hashlib.sha256(json.dumps({'passId':result['passId'],'alignments':result.get('alignments')},sort_keys=True).encode()).hexdigest()
        emit(result)
