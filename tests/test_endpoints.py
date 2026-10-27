import sys,tempfile,unittest,wave,json
from pathlib import Path
from unittest.mock import patch
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'worker'))
from endpoints import PauseHistory
from quality import phrase_end
from finalize_diarization import finalize

class EndpointsTests(unittest.TestCase):
    def test_acoustic_pause_survives_queue_boundaries_and_only_closes_once_silence_is_observed(self):
        with tempfile.TemporaryDirectory() as root:
            h=PauseHistory(root);speech=np.ones(16000*3,np.float32)*.1;quiet=np.zeros(16000,np.float32)
            h.add(np.r_[speech,quiet[:8000]],0);h.add(quiet[8000:],3.5)
            self.assertEqual(h.pauses(0,3.5),[])
            self.assertAlmostEqual(h.pauses(0,4)[0][0],3)
            self.assertEqual(phrase_end([(0,4,1)],0,4,pauses=h.pauses(0,4)),(0,3.0,True))
    def test_continuous_speech_waits_past_two_and_three_seconds_with_twenty_second_limit(self):
        for end in [2,3,6,12,19]:self.assertFalse(phrase_end([(0,end,1)],0,end)[2])
        self.assertEqual(phrase_end([(0,22,1)],0,22),(0,20,True))
        self.assertEqual(phrase_end([(0,1.1,1)],0,1.1,finished=True),(0,1.1,True))
    def test_finished_pass_is_persisted_and_replayed_without_reloading_model(self):
        class Fake:
            calls=0
            def __init__(self,*a,**kw):Fake.calls+=1;self.preset=kw['preset'];assert self.preset=='v3-offline'
            def push(self,pcm):pass
            def finish(self):return [(0,.5,1)]
            def close(self):pass
        with tempfile.TemporaryDirectory() as root:
            root=Path(root);model=root/'model.gguf';model.write_bytes(b'model');audio=root/'recording.wav'
            with wave.open(str(audio),'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(bytes(16000))
            before=audio.read_bytes();events=[]
            with patch('diarization.Diarizer',Fake):
                first=finalize(root,'unused',model,events.append);second=finalize(root,'unused',model,events.append)
            self.assertEqual(Fake.calls,1);self.assertEqual(first,second);self.assertEqual(first['detectedSpeakers'],1);self.assertEqual(audio.read_bytes(),before)
            self.assertEqual(json.loads((root/'speaker-refinement.json').read_text()),first)

if __name__=='__main__':unittest.main()
