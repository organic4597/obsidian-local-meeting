import sys,json,tempfile,types
from pathlib import Path
repo=Path(__file__).resolve().parents[2];sys.path.insert(0,str(repo/'worker'))
from live_speakers import OnlineLabels,speaker_at
tracker=OnlineLabels(2)
a=tracker.assign([{'start':0,'end':1000,'speaker':'A'},{'start':1000,'end':2000,'speaker':'B'}],['A','B'],[[1,0,0],[0,1,0]])
b=tracker.assign([{'start':60000,'end':65000,'speaker':'C'}],['C'],[[0,0,1]])
print(json.dumps({'probe':'speaker_slots','initial':[t['speaker'] for t in a],'late':b[0]['speaker'],'next_id':tracker.next_id}))
import text_worker
OriginalCapture=text_worker.Capture
class BrokenCapture:
 def __init__(self,*a,**kw):self.stop_event=types.SimpleNamespace(is_set=lambda:False);self.diagnostics={}
 def start(self):raise RuntimeError('original_capture_error')
 def stop(self):raise RuntimeError('cleanup_capture_error')
text_worker.Capture=BrokenCapture
with tempfile.TemporaryDirectory(prefix='lm-audit-cleanup-') as tmp:
 root=Path(tmp);(root/'pipeline.json').write_text(json.dumps({'dictionary':{'terms':[]}}))
 args=types.SimpleNamespace(session=tmp,resume=False,input_wav=None,device=None,chunk_seconds=2,model=str(root/'dummy'),realtime_input=False)
 try:text_worker.run(args,lambda e:None)
 except Exception as e:print(json.dumps({'probe':'capture_cleanup','reported':str(e),'transcript_exported':(root/'transcript.json').exists(),'metrics_written':(root/'metrics.json').exists()}))
text_worker.Capture=OriginalCapture
