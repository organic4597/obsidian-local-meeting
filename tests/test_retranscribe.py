import unittest,tempfile,json,wave,sys,types
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'worker'))
from retranscribe import run,reason
from worker_cleanup import cleanup
class FakeSession:
 def __init__(self):self.calls=[]
 def transcribe(self,audio,**kw):self.calls.append(len(audio[0]));return types.SimpleNamespace(text='재전사 후보')
class RetranscriptionTests(unittest.TestCase):
 def test_candidates_never_rewrite_sources_and_carry_bounded_context(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);source=json.dumps({'segments':[{'id':'a','start':1000,'end':2000,'text':'원문','speaker':'manual','suspect':True}]});(root/'transcript.json').write_text(source)
   with wave.open(str(root/'recording.wav'),'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(bytes(32000*4))
   session=FakeSession();out=run(root,session);c=out['items']['a'];self.assertEqual(c['sourceText'],'원문');self.assertEqual(c['text'],'재전사 후보');self.assertEqual(c['contextStart'],0);self.assertEqual(c['contextEnd'],4000);self.assertEqual(session.calls,[16000,64000]);self.assertEqual((root/'transcript.json').read_text(),source)
   self.assertEqual(run(root,session,budget=0,ids=['a'])['pending'],['a'])
 def test_cleanup_attempts_every_step_after_failure(self):
  steps=[]
  def bad():raise RuntimeError('input failure')
  errors=cleanup([('capture',bad),('checkpoint',lambda:steps.append('saved')),('db',lambda:steps.append('closed'))]);self.assertEqual(steps,['saved','closed']);self.assertIn('input failure',errors[0])
 def test_only_actual_text_suspicion_not_unknown_speaker_triggers_rescan(self):
  self.assertEqual(reason({'speaker':'unknown','text':'일반 발언'}),'');self.assertTrue(reason({'streamRewrites':2,'text':'바뀐 대사'}))
 def test_capture_failure_keeps_primary_error_and_exports_recovery_files(self):
  import text_worker
  original=text_worker.Capture
  class Broken:
   def __init__(self,*a,**kw):self.diagnostics={}
   def start(self):raise RuntimeError('original input error')
   def stop(self):raise RuntimeError('shutdown error')
  text_worker.Capture=Broken
  try:
   with tempfile.TemporaryDirectory() as tmp:
    root=Path(tmp);(root/'pipeline.json').write_text(json.dumps({'dictionary':{'terms':[]}}));args=types.SimpleNamespace(session=tmp,resume=False,input_wav=None,device=None,chunk_seconds=2,model=str(root/'unused'),realtime_input=False);events=[]
    with self.assertRaisesRegex(RuntimeError,'original input error'):text_worker.run(args,events.append)
    self.assertTrue((root/'transcript.json').exists());self.assertTrue(json.loads((root/'metrics.json').read_text())['failed']);self.assertTrue(any('shutdown error' in e.get('message','') for e in events))
  finally:text_worker.Capture=original
 def test_retry_supports_a_final_word_split_id_without_modifying_worker_transcript(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);source=json.dumps({'segments':[{'id':'parent','start':0,'end':4000,'text':'원래 전체 대사'}]});(root/'transcript.json').write_text(source)
   with wave.open(str(root/'recording.wav'),'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(bytes(32000*4))
   result=run(root,FakeSession(),ids=['parent_w1'],segments_override=[{'id':'parent_w1','start':2000,'end':4000,'text':'직접 교정한 대사','speaker':'manual'}]);self.assertEqual(result['items']['parent_w1']['sourceText'],'직접 교정한 대사');self.assertEqual((root/'transcript.json').read_text(),source)
