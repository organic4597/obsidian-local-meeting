import sys
import struct
import tempfile
import unittest
import wave
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'worker'))
from recording import ContinuousWav,ensure_recording,repair_header
from capture import Capture
from store import Store

class FullRecordingTests(unittest.TestCase):
    def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()
    def test_same_wav_is_readable_and_grows_before_close(self):
        path=self.root/'recording.wav';out=ContinuousWav(path)
        with wave.open(str(path)) as audio:self.assertEqual(audio.getnframes(),0)
        out.append(b'\x10\x00'*1600)
        with wave.open(str(path)) as audio:self.assertEqual(audio.getnframes(),1600)
        out.append(b'\x20\x00'*3200);out.close()
        with wave.open(str(path)) as audio:self.assertEqual(audio.getnframes(),4800);self.assertEqual(audio.readframes(4800),b'\x10\x00'*1600+b'\x20\x00'*3200)
    def test_import_has_one_full_wav_and_byte_identical_audio(self):
        source=self.root/'source.wav';pcm=struct.pack('<h',1234)*16000*5
        with wave.open(str(source),'wb') as audio:audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(16000);audio.writeframes(pcm)
        meeting=self.root/'meeting';meeting.mkdir();events=[];Capture(meeting,events.append,seconds=2).import_wav(source)
        self.assertGreater(len(events),1);self.assertEqual(len(list(meeting.rglob('*.wav'))),1)
        with wave.open(str(meeting/'recording.wav')) as audio:self.assertEqual(audio.readframes(audio.getnframes()),pcm)
        self.assertTrue(all((meeting/e['path']).suffix=='.pcm' for e in events))
    def test_stop_includes_pending_and_overflow_preserved_block_once(self):
        events=[];cap=Capture(self.root,events.append,seconds=2)
        first=b'\x01\x00'*1600;last=b'\x02\x00'*800
        cap.blocks.put(first);cap.failed_block=last;cap.stop_event.set();cap.write_loop()
        with wave.open(str(self.root/'recording.wav')) as audio:self.assertEqual(audio.readframes(audio.getnframes()),first+last)
    def test_old_wav_chunks_can_be_recovered_without_removing_originals(self):
        for start,value in [(0,1),(1000,2)]:
            with wave.open(str(self.root/f'audio-{start:012d}-{start+1000:012d}.wav'),'wb') as audio:audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(16000);audio.writeframes(struct.pack('<h',value)*16000)
        target=ensure_recording(self.root)
        with wave.open(str(target)) as audio:self.assertEqual(audio.getnframes(),32000)
        self.assertEqual(len(list(self.root.glob('audio-*.wav'))),2);self.assertEqual(ensure_recording(self.root),target)
    def test_pcm_queue_recovers_both_sql_and_full_recording(self):
        cap=Capture(self.root,lambda _:None,seconds=2);cap.write_chunk(b'\x00\x00'*32000,0);cap.write_chunk(b'\x01\x00'*16000,32000)
        store=Store(self.root);store.recover();self.assertEqual(store.status()['pending'],2);store.close()
        with wave.open(str(ensure_recording(self.root))) as audio:self.assertEqual(audio.getnframes(),48000)
    def test_crash_header_repair_does_not_change_audio_bytes(self):
        path=self.root/'recording.wav';out=ContinuousWav(path);out.append(b'\x05\x00'*1600);out.close()
        with open(path,'r+b') as file:file.seek(4);file.write(struct.pack('<I',36));file.seek(40);file.write(struct.pack('<I',0))
        before=path.read_bytes()[44:];repair_header(path)
        with wave.open(str(path)) as audio:self.assertEqual(audio.getnframes(),1600)
        self.assertEqual(path.read_bytes()[44:],before)
    def test_crash_tail_is_restored_from_full_wav_into_queue(self):
        out=ContinuousWav(self.root/'recording.wav');out.append(b'\x01\x00'*16000+b'\x02\x00'*8000);out.close()
        Capture(self.root,lambda _:None).write_chunk(b'\x01\x00'*16000,0)
        store=Store(self.root);store.recover();store.recover()
        self.assertEqual(len(store.rows()),2);self.assertEqual(store.rows()[-1][2:4],(1000.,1500.));store.close()
    def test_queue_can_be_restored_from_the_single_full_wav(self):
        out=ContinuousWav(self.root/'recording.wav');out.append(b'\x03\x00'*16000);out.close()
        store=Store(self.root);store.add('deleted.wav',0,1000);store.recover()
        row=store.rows()[0];self.assertEqual(len(store.rows()),1);self.assertEqual((self.root/row[1]).read_bytes(),b'\x03\x00'*16000);store.close()
    def test_recovered_chunk_before_sql_update_preserves_job_identity(self):
        out=ContinuousWav(self.root/'recording.wav');out.append(b'\x03\x00'*16000);out.close()
        store=Store(self.root);store.add('missing.wav',0,1000);ident=store.rows()[0][0]
        Capture(self.root,lambda _:None).write_chunk(b'\x03\x00'*16000,0)
        store.recover();self.assertEqual(len(store.rows()),1);self.assertEqual(store.rows()[0][0],ident);store.close()
    def test_existing_full_recording_is_never_overwritten(self):
        path=self.root/'recording.wav';out=ContinuousWav(path);out.append(b'\x10\x00'*1600);out.close();before=path.read_bytes()
        with self.assertRaises(FileExistsError):ContinuousWav(path)
        self.assertEqual(path.read_bytes(),before)
    def test_missing_audio_interval_is_not_silently_removed(self):
        cap=Capture(self.root,lambda _:None);cap.write_chunk(bytes(32000),16000)
        with self.assertRaises(ValueError):ensure_recording(self.root)
        self.assertFalse((self.root/'recording.wav').exists())
        self.assertFalse((self.root/'recording.wav.part').exists())

if __name__=='__main__':unittest.main()
