import unittest,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'worker'))
from live_speakers import OnlineLabels,speaker_at,change_boundary
class LiveSpeakerTests(unittest.TestCase):
 def test_window_labels_follow_overlap_and_new_speakers_do_not_force_existing_identity(self):
  t=OnlineLabels(2);a=t.assign([{'start':0,'end':5000,'speaker':'A'}],['A'],[[1,0]]);self.assertEqual(a[0]['speaker'],'live_1')
  b=t.assign([{'start':1000,'end':5000,'speaker':'X'},{'start':5000,'end':7000,'speaker':'Y'}],['X','Y'],[[1,0],[0,1]]);self.assertEqual([x['speaker'] for x in b],['live_1','live_2'])
  c=t.assign([{'start':10000,'end':12000,'speaker':'Z'}],['Z'],[[-1,0]]);self.assertEqual(c[0]['speaker'],'unknown')
 def test_speech_handover_without_silence_splits_and_overlap_is_not_a_named_person(self):
  turns=[{'start':0,'end':5000,'speaker':'live_1'},{'start':5000,'end':9000,'speaker':'live_2'}];self.assertEqual(change_boundary(turns,0,9000),5000);self.assertEqual(speaker_at(turns,0,5000),'live_1')
  overlap=[*turns,{'start':4500,'end':5500,'speaker':'live_2'}];self.assertEqual(speaker_at(overlap,4000,5500),'overlap')
 def test_short_noise_does_not_cut_the_phrase(self):
  self.assertIsNone(change_boundary([{'start':0,'end':1000,'speaker':'live_1'},{'start':100,'end':200,'speaker':'live_2'}],0,1000))
