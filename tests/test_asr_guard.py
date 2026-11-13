import sys,unittest
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'worker'))
from asr_guard import audible,hint_echo
class ASRGuardTests(unittest.TestCase):
 def setUp(self):self.terms=['AWS','N2FS','OCR','SLM','TS','딥포인트','스나이퍼 OS','쿠버네티스','테서렉트','플루언트 비트'];self.dictionary={'terms':[{'canonical':x,'recognitionHint':True} for x in self.terms]}
 def test_reported_dictionary_replay_is_rejected_but_real_discussion_and_short_term_lists_are_not(self):
  self.assertTrue(hint_echo(' '.join(self.terms),self.dictionary));self.assertTrue(hint_echo(' '.join(self.terms[2:]),self.dictionary));self.assertFalse(hint_echo('OCR SLM TS',self.dictionary));self.assertFalse(hint_echo('AWS와 OCR 관련 내용을 검토했습니다.',self.dictionary));self.assertFalse(hint_echo('OCR OCR OCR OCR OCR OCR',self.dictionary))
 def test_silence_and_low_level_noise_do_not_enter_decoder_but_quiet_speech_can(self):
  self.assertFalse(audible(np.zeros(16000,np.float32)));self.assertFalse(audible(np.ones(16000,np.float32)*1e-4));self.assertTrue(audible(np.ones(3200,np.float32)*.005))
 def test_empty_dictionary_never_classifies_normal_text_as_prompt_echo(self):self.assertFalse(hint_echo('AWS N2FS OCR',{'terms':[]}))
