import sqlite3,sys,tempfile,unittest,wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'worker'))
from legacy_recovery import check_complete
from main import main

class LegacyRecoveryTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
  with wave.open(str(self.root/'recording.wav'),'wb') as w:
   w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(bytes(32000))
  self.db=self.root/'queue.sqlite'
  with sqlite3.connect(self.db) as c:
   c.execute('CREATE TABLE chunks(path TEXT,start REAL,end REAL,state TEXT)')
   c.execute("INSERT INTO chunks VALUES('queue/audio-000000000000-000000001000.pcm',0,1000,'done')")
 def tearDown(self):self.temp.cleanup()
 def args(self,legacy=True):
  return SimpleNamespace(session=str(self.root),legacy_resume=legacy,refine_only=not legacy)
 def test_completed_legacy_uses_community_without_mutating_originals(self):
  before=(self.db.read_bytes(),(self.root/'recording.wav').read_bytes())
  with patch('community_pipeline.finalize') as run,patch('main.emit'):
   self.assertEqual(main(self.args()),0);run.assert_called_once()
  self.assertEqual(before,(self.db.read_bytes(),(self.root/'recording.wav').read_bytes()))
 def test_unfinished_queue_is_not_changed_or_processed(self):
  with sqlite3.connect(self.db) as c:c.execute("UPDATE chunks SET state='pending'")
  before=(self.db.read_bytes(),(self.root/'recording.wav').read_bytes())
  with patch('community_pipeline.finalize') as run, self.assertRaisesRegex(ValueError,'미완료'):
   main(self.args())
  run.assert_not_called();self.assertEqual(before,(self.db.read_bytes(),(self.root/'recording.wav').read_bytes()))
 def test_unregistered_tail_and_orphan_chunk_are_not_skipped(self):
  with sqlite3.connect(self.db) as c:c.execute('UPDATE chunks SET end=500')
  with self.assertRaisesRegex(ValueError,'포함되지 않은'):check_complete(self.root)
  with sqlite3.connect(self.db) as c:c.execute('UPDATE chunks SET end=1000')
  extra=self.root/'queue/audio-000000001000-000000002000.pcm';extra.parent.mkdir();extra.write_bytes(b'00')
  with self.assertRaisesRegex(ValueError,'확인되지 않은'):check_complete(self.root)
 def test_gap_in_completed_queue_is_not_skipped(self):
  with sqlite3.connect(self.db) as c:c.execute('UPDATE chunks SET start=200')
  with self.assertRaisesRegex(ValueError,'확인되지 않은 구간'):check_complete(self.root)
 def test_explicit_reanalysis_can_run_without_legacy_queue(self):
  self.db.unlink()
  with patch('community_pipeline.finalize') as run,patch('main.emit'):
   self.assertEqual(main(self.args(False)),0);run.assert_called_once()

if __name__=='__main__':unittest.main()
