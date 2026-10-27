import sys,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'worker'))
from endpoints import PauseHistory
from community_diarize import bounds
from post_alignment import offsets
from text_worker import committed_cursor

class TextPipelineTests(unittest.TestCase):
 def test_recovery_does_not_repeat_a_phrase_committed_before_cursor_update(self):
  self.assertEqual(committed_cursor([{'end':5000,'textState':'stable'},{'end':8000,'textState':'provisional'}],0),5)
  self.assertEqual(committed_cursor([{'end':5000,'textState':'stable'}],6),6)
 def test_participant_limit_is_passed_as_maximum_or_exact_not_just_ui_warning(self):
  self.assertEqual(bounds(7,'maximum'),{'max_speakers':7});self.assertEqual(bounds(7,'exact'),{'num_speakers':7});self.assertEqual(bounds(0,'maximum'),{})
  for count in [-1,33,1.5]:
   with self.assertRaises(ValueError):bounds(count,'maximum')
 def test_text_only_planner_waits_for_pause_and_does_not_request_every_two_seconds(self):
  with tempfile.TemporaryDirectory() as root:
   h=PauseHistory(root);h.add(np.ones(16000*8,np.float32)*.05,0)
   for available in [2,4,6,8]:self.assertFalse(h.plan(0,available)[3])
   h.add(np.zeros(16000,np.float32),8);plan=h.plan(0,9);self.assertTrue(plan[3]);self.assertAlmostEqual(plan[1],8.1);self.assertAlmostEqual(plan[2],8.9)
 def test_continuous_audio_is_bounded_and_stop_keeps_final_tail(self):
  with tempfile.TemporaryDirectory() as root:
   h=PauseHistory(root);h.add(np.ones(16000*25,np.float32)*.05,0)
   self.assertEqual(h.plan(0,25),(0,20,20,True));self.assertEqual(h.plan(20,25,True),(20,25,25,True))
 def test_silence_advances_queue_without_a_transcription_request(self):
  with tempfile.TemporaryDirectory() as root:
   h=PauseHistory(root);h.add(np.zeros(16000*5,np.float32),0);a,b,c,closed=h.plan(0,5,True);self.assertEqual(a,b);self.assertEqual(c,5);self.assertTrue(closed)
 def test_aligned_korean_offsets_preserve_original_punctuation_and_spaces(self):
  words=[SimpleNamespace(text='첫',start_time=0,end_time=.5),SimpleNamespace(text='발언',start_time=.6,end_time=1.2)]
  r=offsets('첫 발언.',words,1000,3000);self.assertEqual(r[1]['from'],2);self.assertEqual(r[1]['to'],4);self.assertEqual(r[1]['start'],1600)
  with self.assertRaises(ValueError):offsets('없는 글자',words,1000,3000)

if __name__=='__main__':unittest.main()
