import os,sys,tempfile,time,unittest,wave
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'worker'))
from system_capture import SystemCapture

class SystemCaptureTest(unittest.TestCase):
    def helper(self,root,body):
        path=Path(root)/'fake-helper'
        path.write_text('#!'+sys.executable+'\n'+body)
        path.chmod(0o700);return path
    def test_mixes_both_sources_into_one_durable_pcm_and_queue(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=self.helper(tmp,"""import struct,sys
sys.stderr.write('READY 48000 2\\n');sys.stderr.flush()
block=struct.pack('<ff',.2,.4)*4800
for i in range(10):sys.stdout.buffer.write(block);sys.stdout.buffer.flush()
sys.stdin.readline()
""")
            events=[];c=SystemCapture(tmp,events.append,h,app_pid=123,seconds=2);c.start()
            deadline=time.monotonic()+5
            while c.diagnostics['samples']<16000 and time.monotonic()<deadline:time.sleep(.02)
            c.stop()
            with wave.open(str(Path(tmp)/'recording.wav'),'rb') as w:
                self.assertEqual((w.getnchannels(),w.getsampwidth(),w.getframerate(),w.getnframes()),(1,2,16000,16000))
                import numpy as np
                values=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2')
                self.assertAlmostEqual(float(values[1000:].mean())/32767,.3,places=2)
            self.assertEqual(len(events),1)
            self.assertEqual((Path(tmp)/events[0]['path']).stat().st_size,32000)
    def test_unexpected_helper_exit_stops_and_preserves_wav(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=self.helper(tmp,"""import sys,time
sys.stderr.write('READY 48000 2\\n');sys.stderr.flush();time.sleep(.2);sys.exit(2)
""")
            c=SystemCapture(tmp,lambda _:None,h);c.start()
            self.assertTrue(c.stop_event.wait(5))
            with self.assertRaises(RuntimeError):c.stop()
            with wave.open(str(Path(tmp)/'recording.wav'),'rb') as w:self.assertEqual(w.getframerate(),16000)
    def test_nondefault_microphone_is_rejected_before_recording(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(RuntimeError):SystemCapture(tmp,lambda _:None,'/missing',device=2)
            self.assertFalse((Path(tmp)/'recording.wav').exists())
    def test_invalid_app_id_does_not_fall_back_to_global_capture(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):SystemCapture(tmp,lambda _:None,'/missing',app_pid=0)
            self.assertFalse((Path(tmp)/'recording.wav').exists())
