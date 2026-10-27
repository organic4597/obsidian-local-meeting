"""Launch heavy diarization only after capture and ASR have released their resources."""
import json,subprocess,sys
from pathlib import Path

def finalize(root,args,emit):
    if not getattr(args,'community_python',None) or not getattr(args,'community_model',None):raise ValueError('Community-1 Python과 로컬 모델 경로를 연결해 주세요.')
    root=Path(root);config=json.loads((root/'pipeline.json').read_text()) if (root/'pipeline.json').exists() else {}
    count=getattr(args,'speaker_count',None)
    if count is None:count=config.get('speakerCount',0)
    mode=getattr(args,'speaker_count_mode',None) or config.get('speakerCountMode','maximum')
    command=[args.community_python,'-u',str(Path(__file__).with_name('community_diarize.py')),'--session',str(root),'--model',args.community_model,'--count',str(count),'--mode',mode]
    result=None
    with subprocess.Popen(command,stdout=subprocess.PIPE,stderr=sys.stderr,text=True) as process:
        for line in process.stdout:
            if len(line)>8_000_000:process.terminate();raise RuntimeError('화자 결과가 너무 큽니다.')
            event=json.loads(line)
            if event.get('type')=='speaker_refinement':result=event
            else:emit(event)
        code=process.wait()
    if code or result is None:raise RuntimeError('종료 후 화자 구분이 완료되지 않았습니다. 원음과 전사 결과는 보존됐습니다.')

    if getattr(args,'aligner_model',None) and config.get('workflow')=='text-then-community':
        from post_alignment import align
        result['alignments']=align(root,args.aligner_model,emit,result['turns'])
    emit(result)
