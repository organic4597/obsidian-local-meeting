"""Immutable per-input artifacts; the app owns its separate stage ledger."""
import hashlib,json,os,uuid,time,contextlib
from pathlib import Path
from quality import write_atomic

def digest_file(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for data in iter(lambda:f.read(1024*1024),b''):h.update(data)
    return h.hexdigest()

def model_digest(folder):
    root=Path(folder).resolve();h=hashlib.sha256();found=False
    for p in sorted(root.rglob('*')):
        if not p.is_file() or p.suffix not in ('.json','.yaml','.safetensors','.bin','.npz'):continue
        found=True;h.update(str(p.relative_to(root)).encode());h.update(digest_file(p).encode())
    if not found:raise ValueError('모델 검증 파일이 없습니다.')
    return h.hexdigest()

@contextlib.contextmanager
def session_lock(root,name='.postprocess-compute.lock'):
    # Keep the inode stable: unlinking a stale PID lock can race another starter.
    # The OS releases flock even on SIGKILL; leftover metadata is not ownership.
    import fcntl
    path=Path(root)/name;fd=os.open(path,os.O_CREAT|os.O_RDWR,0o600)
    with os.fdopen(fd,'r+') as f:
        try:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('이 회의의 다른 후처리가 실행 중입니다.')
        try:
            f.seek(0);f.truncate();json.dump({'pid':os.getpid(),'token':str(uuid.uuid4())},f);f.flush();os.fsync(f.fileno())
            yield
        finally:fcntl.flock(f,fcntl.LOCK_UN)

class StageArtifacts:
    def __init__(self,root,emit):self.root=Path(root).resolve();self.emit=emit
    def event(self,stage,key,status,**extra):self.emit({'type':'postprocess_stage','session':self.root.name,'stage':stage,'inputKey':key,'status':status,**extra})
    def run(self,stage,inputs,work,complete=lambda data:True):
        code={name:digest_file(Path(__file__).with_name(name)) for name in {'diarization':['stage_artifacts.py','community_diarize.py','community_pipeline.py','voice_features.py'],'alignment':['stage_artifacts.py','post_alignment.py'],'rescan':['stage_artifacts.py','postprocess_rescan.py','retranscribe.py','dictionary.py']}.get(stage,[]) };key=hashlib.sha256(json.dumps({'schema':1,'code':code,'stage':stage,'inputs':inputs},sort_keys=True).encode()).hexdigest();base=self.root/'postprocess'/'artifacts'/stage/key;pointer=base/'latest.json';previous=None
        try:
            manifest=json.loads(pointer.read_text())
            if not isinstance(manifest,dict) or not isinstance(manifest.get('files'),dict) or type(manifest.get('complete')) is not bool:raise ValueError('Invalid artifact manifest')
            uuid.UUID(manifest['attempt']);
            if any(Path(p).is_absolute() or '..' in Path(p).parts for p in manifest.get('files',{})):raise ValueError('Invalid artifact path')
            result=base/manifest['attempt']/'result.json'
            if manifest['inputKey']==key and digest_file(result)==manifest['sha256']:
                previous=json.loads(result.read_text())
                valid=all(digest_file(base/manifest['attempt']/p)==sha for p,sha in manifest.get('files',{}).items())
                if valid and manifest['complete']:
                    self.event(stage,key,'succeeded',cached=True,artifact=str(result.relative_to(self.root)));return previous
                if not valid:previous=None
        except (OSError,ValueError,KeyError,TypeError,AttributeError):previous=None
        attempt=str(uuid.uuid4());out=base/attempt;out.mkdir(parents=True);self.event(stage,key,'running')
        try:
            data=work(out,previous);write_atomic(out/'result.json',data)
            files={str(p.relative_to(out)):digest_file(p) for p in out.rglob('*') if p.is_file() and p.name!='result.json'}
            done=complete(data);write_atomic(pointer,{'inputKey':key,'attempt':attempt,'sha256':digest_file(out/'result.json'),'files':files,'complete':done})
            self.event(stage,key,'succeeded' if done else 'waiting_input',artifact=str((out/'result.json').relative_to(self.root)),cached=False);return data
        except Exception as e:self.event(stage,key,'failed',message=str(e));raise
