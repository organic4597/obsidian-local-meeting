import json,contextlib,sys
from pathlib import Path
from stage_artifacts import StageArtifacts,digest_file,model_digest,session_lock

def run(root,args,emit,session=None,locked=False):
    root=Path(root).resolve();cfg=json.loads((root/'pipeline.json').read_text());source=json.loads((root/'transcript.json').read_text())
    from retranscribe import reason,run as rescan
    requested=[]
    try:
        import sqlite3
        db=sqlite3.connect((root/'queue.sqlite').as_uri()+'?mode=ro',uri=True)
        try:
            row=db.execute("SELECT value FROM quality_meta WHERE key='suspectIds'").fetchone();requested=json.loads(row[0]) if row else []
        finally:db.close()
    except (OSError,sqlite3.Error):pass
    ids=[s['id'] for s in source['segments'] if s['id'] in requested or reason(s)]
    def work(out,previous):
        nonlocal session
        if not ids:return {'items':{},'pending':[],'candidateFile':None}
        if session is None:
            with contextlib.redirect_stdout(sys.stderr):
                from mlx_qwen3_asr import Session
                session=Session(model=args.model)
        context=''
        if previous:from quality import write_atomic;write_atomic(out/'retranscription.json',{k:v for k,v in previous.items() if k!='candidateFile'})
        remaining=[id for id in ids if not previous or id not in previous.get('items',{}) or id in previous.get('pending',[])]
        data=rescan(root,session,context,ids=remaining,output_root=out)
        data['candidateFile']=str((out/'retranscription.json').relative_to(root));return data
    def execute():
        stages=StageArtifacts(root,emit)
        try:model=model_digest(args.model)
        except Exception as e:
            import hashlib
            stages.event('rescan',hashlib.sha256(str(args.model).encode()).hexdigest(),'failed',message=str(e));raise
        return stages.run('rescan',{'source':digest_file(root/'transcript.json'),'audio':digest_file(root/'recording.wav'),'ids':ids,'dictionary':cfg.get('dictionary',{}),'model':model},work,lambda x:not x.get('pending'))
    if locked:return execute()
    with session_lock(root):return execute()
