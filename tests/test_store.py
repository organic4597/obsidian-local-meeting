import sys
import tempfile
import unittest
import wave
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'worker'))
from store import Store
from capture import Capture

class DurableQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()
    def test_running_job_is_recovered_and_replay_is_idempotent(self):
        store=Store(self.root);store.add('audio-000000000000-000000008000.wav',0,8000)
        ident,*_=store.claim();store.close()
        store=Store(self.root);store.recover()
        self.assertEqual(store.claim()[0],ident)
        result={'id':str(ident),'text':'회의 시작','start':0,'end':8000,'speaker':'unknown'}
        store.complete(ident,result);store.recover()
        self.assertIsNone(store.claim());self.assertEqual(store.results(),[result]);store.close()
    def test_wav_written_before_queue_commit_is_recovered(self):
        cap=Capture(self.root,lambda _:None)
        cap.write_chunk(bytes(16000*2),0)
        store=Store(self.root);store.recover();store.recover()
        self.assertEqual(store.status()['pending'],1)
        self.assertEqual(store.claim()[2:],(0.,1000.));store.close()
    def test_failure_does_not_block_subsequent_audio_and_is_retryable(self):
        store=Store(self.root);store.add('a.wav',0,8000);store.add('b.wav',8000,16000)
        first=store.claim();store.fail(first[0],'error')
        second=store.claim();self.assertEqual(second[1],'b.wav');store.complete(second[0],{'text':'b'})
        self.assertIsNone(store.claim());store.retry();self.assertEqual(store.claim()[0],first[0]);store.close()
    def test_disk_writer_drains_remaining_samples_on_stop(self):
        events=[];cap=Capture(self.root,events.append,rate=16000,seconds=2)
        cap.blocks.put(bytes(64000));cap.blocks.put(bytes(3200));cap.stop_event.set();cap.write_loop()
        self.assertEqual(len(events),2);self.assertEqual(events[-1]['end'],2100)
        for item in events:
            with wave.open(str(self.root/item['path'])) as audio:
                self.assertEqual(audio.getnchannels(),1);self.assertEqual(audio.getframerate(),16000)
        self.assertFalse(list(self.root.glob('*.part')))

if __name__=='__main__': unittest.main()
