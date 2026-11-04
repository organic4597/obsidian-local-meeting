import json,os,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'worker'))
from voice_features import exclusive_durations,features_from_output,save_features

class VoiceFeaturesTests(unittest.TestCase):
 def test_overlap_and_repeated_turns_are_not_counted_as_independent_speech(self):
  turns=[{'start':0,'end':5000,'speaker':'community_00'},{'start':3000,'end':7000,'speaker':'community_01'},{'start':1000,'end':2000,'speaker':'community_00'}]
  self.assertEqual(exclusive_durations(turns),{'community_00':3000,'community_01':2000})
 def test_invalid_and_short_vectors_cannot_become_profiles(self):
  turns=[{'start':0,'end':5000,'speaker':'community_00'},{'start':5000,'end':7000,'speaker':'community_01'}]
  result=features_from_output(['SPEAKER_00','SPEAKER_01'],[[1.0]*256,[2.0]*256],turns,'a'*64,'b'*64,'session')
  self.assertEqual([x['cluster'] for x in result['items']],['community_00']);self.assertAlmostEqual(sum(x*x for x in result['items'][0]['vector']),1,places=5)
  self.assertEqual(features_from_output(['SPEAKER_00'],[[float('nan')]*256],turns,'a'*64,'b'*64,'session')['items'],[])
  self.assertIsNone(features_from_output(['SPEAKER_00'],None,turns,'a'*64,'b'*64,'session'))
 def test_local_file_private_and_without_transcript(self):
  with tempfile.TemporaryDirectory() as root:
   value={'schemaVersion':1,'session':'x','items':[]};save_features(root,value);path=Path(root)/'voice-features.json'
   self.assertEqual(json.loads(path.read_text()),value);self.assertEqual(os.stat(path).st_mode&0o777,0o600)
if __name__=='__main__':unittest.main()
