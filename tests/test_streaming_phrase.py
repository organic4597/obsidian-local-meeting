import unittest,sys,types
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'worker'))
from streaming_phrase import StreamingPhrase,relabel_recent
from text_worker import committed_cursor
class FakeSession:
 def init_streaming(self,**kw):self.options=kw;return types.SimpleNamespace(text='')
 def feed_audio(self,pcm,state):state.text+='음성 ';return state
 def finish_streaming(self,state):state.text+='확정';return state
class StreamingTests(unittest.TestCase):
 def test_partial_before_endpoint_reuses_context_and_rejects_audio_gaps(self):
  session=FakeSession();p=StreamingPhrase(session,2.,'회의 용어');self.assertEqual(p.feed(np.zeros(16000),3.),'음성');self.assertEqual(p.feed(np.zeros(16000),4.),'음성 음성');self.assertEqual(session.options['context'],'');self.assertEqual(p.finish(),'음성 음성 확정')
  with self.assertRaises(ValueError):p.feed(np.zeros(10),6.)
 def test_recovery_never_skips_provisional_audio(self):
  self.assertEqual(committed_cursor([{'end':9000,'textState':'provisional'},{'end':3000,'textState':'stable'}],3.),3.)
 def test_speaker_results_update_same_id_without_changing_text(self):
  old={'id':'a','start':0,'end':1000,'speaker':'pending','text':'사용자 확인용','textState':'provisional'}
  class Store:
   def all(self):return [old]
   def put(self,s):return s
  events=[];relabel_recent(Store(),[{'start':0,'end':1000,'speaker':'live_1'}],8.,events.append,'m');self.assertEqual(events[0]['segment']['speaker'],'live_1');self.assertEqual(events[0]['segment']['text'],old['text']);self.assertEqual(events[0]['segment']['id'],'a')
