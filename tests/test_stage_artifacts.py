import sys,json,tempfile,unittest,os,wave
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'worker'))
from stage_artifacts import StageArtifacts,session_lock,digest_file,model_digest
from quality import RevisionStore,write_atomic
from store import Store
from main import main

class StageTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.events=[];self.stages=StageArtifacts(self.root,self.events.append)
 def tearDown(self):self.temp.cleanup()
 def test_input_identity_and_corrupt_sidecar_recompute_without_overwrite(self):
  count=[]
  def work(out,previous):
   count.append(previous);(out/'features.json').write_text('features');return {'value':len(count)}
  self.assertEqual(self.stages.run('test',{'input':1},work),{'value':1})
  first=self.root/self.events[-1]['artifact'];original=first.read_bytes()
  self.assertEqual(self.stages.run('test',{'input':1},work),{'value':1});self.assertTrue(self.events[-1]['cached'])
  (first.parent/'features.json').write_text('corrupted')
  self.assertEqual(self.stages.run('test',{'input':1},work),{'value':2});self.assertIsNone(count[-1]);self.assertEqual(first.read_bytes(),original)
  self.assertEqual(self.stages.run('test',{'input':2},work),{'value':3})
 def test_malformed_manifests_recompute_instead_of_trusting_or_blocking(self):
  for broken in [None,[],{'attempt':None,'files':{},'complete':True},{'attempt':'../outside','files':{},'complete':True},{'files':[],'complete':'false'}]:
   self.stages.run('broken',1,lambda out,old:{'value':'initial'})
   artifact=self.root/self.events[-1]['artifact'];pointer=artifact.parent.parent/'latest.json';pointer.write_text(json.dumps(broken))
   self.assertEqual(self.stages.run('broken',1,lambda out,old:{'value':'recomputed'}),{'value':'recomputed'})
   self.assertFalse(self.events[-1]['cached'])
 def test_partial_results_retry_and_failures_are_not_cached(self):
  first=self.stages.run('test',1,lambda out,old:{'completed':['a'],'pending':['b']},lambda x:not x['pending'])
  self.assertEqual(self.events[-1]['status'],'waiting_input')
  def finish(out,old):self.assertEqual(old,first);return {'completed':['a','b'],'pending':[]}
  self.stages.run('test',1,finish,lambda x:not x['pending']);self.assertEqual(self.events[-1]['status'],'succeeded')
  def fail(out,old):raise RuntimeError('network disconnected')
  with self.assertRaisesRegex(RuntimeError,'disconnected'):self.stages.run('test',2,fail)
  self.assertEqual(self.events[-1]['status'],'failed');self.assertEqual(self.stages.run('test',2,lambda out,old:'ok'),'ok')
 def test_running_worker_is_locked_and_stale_lock_is_recoverable(self):
  with session_lock(self.root):
   with self.assertRaisesRegex(RuntimeError,'다른 후처리'):
    with session_lock(self.root):pass
  write_atomic(self.root/'.postprocess-compute.lock',{'pid':2147483647,'token':'stale'})
  with session_lock(self.root):self.assertTrue((self.root/'.postprocess-compute.lock').exists())
  with session_lock(self.root):pass # Persistent lock file is harmless after ownership is released.
 def test_model_fingerprint_includes_weights_not_only_config(self):
  model=self.root/'model';model.mkdir();(model/'config.json').write_text('{}');(model/'weights.safetensors').write_bytes(b'v1');first=model_digest(model);(model/'weights.safetensors').write_bytes(b'v2');self.assertNotEqual(first,model_digest(model))
 def test_completed_resume_replays_without_asr_or_changing_originals(self):
  with wave.open(str(self.root/'recording.wav'),'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(bytes(32000))
  store=Store(self.root);store.add('queue/audio-000000000000-000000001000.pcm',0,1000);store.complete(1,{'segments':[]});revs=RevisionStore(store)
  revs.put({'id':'p1','start':0,'end':1000,'text':'확정 텍스트','speaker':'pending','textState':'stable'});revs.set('cursor',1);revs.export();store.close()
  before={p.name:p.read_bytes() for p in self.root.iterdir() if p.is_file()};args=SimpleNamespace(session=str(self.root),resume=True,legacy_resume=False,refine_only=False)
  with patch('community_pipeline.finalize') as finalize,patch('main.emit') as emit,patch('text_worker.run',side_effect=AssertionError('must not load ASR')):
   self.assertEqual(main(args),0);finalize.assert_called_once();self.assertTrue(any(c.args[0].get('stage')=='asr' and c.args[0].get('cached') for c in emit.call_args_list))
  self.assertEqual(before,{p.name:p.read_bytes() for p in self.root.iterdir() if p.is_file()})
 def test_resume_rejects_conflicting_transcript_without_overwriting_it(self):
  with wave.open(str(self.root/'recording.wav'),'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(bytes(32000))
  store=Store(self.root);store.add('queue/a.pcm',0,1000);store.complete(1,{'segments':[]});revs=RevisionStore(store);revs.set('cursor',1);revs.export();store.close();path=self.root/'transcript.json';path.write_text('{"segments":[{"id":"bad"}]}');before=path.read_bytes()
  with self.assertRaisesRegex(RuntimeError,'다릅니다'):main(SimpleNamespace(session=str(self.root),resume=True,legacy_resume=False,refine_only=False))
  self.assertEqual(path.read_bytes(),before)
 def test_partial_rescan_retries_only_pending_ids(self):
  import postprocess_rescan
  (self.root/'pipeline.json').write_text('{"dictionary":{}}');(self.root/'transcript.json').write_text(json.dumps({'segments':[{'id':i,'text':'말','start':0,'end':1000,'suspect':True} for i in ['a','b']]}));(self.root/'recording.wav').write_bytes(b'audio')
  model=self.root/'model';model.mkdir();(model/'config.json').write_text('{}')
  session=SimpleNamespace(tokenizer=SimpleNamespace(encode=lambda text:[]))
  def rescan(root,model,context,ids,output_root):
   self.assertEqual(ids,['a','b']);data={'schemaVersion':1,'items':{'a':{'text':'수정'}},'pending':['b']};write_atomic(output_root/'retranscription.json',data);return data
  with patch('retranscribe.run',side_effect=rescan):postprocess_rescan.run(self.root,SimpleNamespace(model=str(model)),self.events.append,session)
  def retry(root,model,context,ids,output_root):
   self.assertEqual(ids,['b']);data=json.loads((output_root/'retranscription.json').read_text());self.assertIn('a',data['items']);data['items']['b']={'text':'완료'};data['pending']=[];write_atomic(output_root/'retranscription.json',data);return data
  with patch('retranscribe.run',side_effect=retry):result=postprocess_rescan.run(self.root,SimpleNamespace(model=str(model)),self.events.append,session)
  self.assertEqual(set(result['items']),{'a','b'})

if __name__=='__main__':unittest.main()
