import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from evaluate_quality import evaluate,diarization

class EvaluationTests(unittest.TestCase):
    def test_empty_template_never_reports_accuracy(self):
        with self.assertRaises(ValueError):evaluate({'segments':[{'referenceText':None}]},{'segments':[]})
    def test_permuted_speaker_slots_do_not_inflate_der(self):
        ref=[{'start':0,'end':1000,'speakers':['A']},{'start':1000,'end':2000,'speakers':['B']}]
        hyp=[{'start':0,'end':1000,'speakers':['speaker_2']},{'start':1000,'end':2000,'speakers':['speaker_1']}]
        self.assertEqual(diarization(ref,hyp)['DER'],0)
    def test_missed_overlap_is_counted(self):
        ref=[{'start':0,'end':1000,'speakers':['A','B']}];hyp=[{'start':0,'end':1000,'speakers':['speaker_1']}]
        result=diarization(ref,hyp);self.assertEqual(result['DER'],.5);self.assertEqual(result['missMs'],1000)
    def test_all_unknown_does_not_get_zero_der(self):
        ref={'segments':[{'start':0,'end':1000,'referenceText':'안녕','referenceSpeakers':['A']}]};hyp={'segments':[{'start':0,'end':1000,'text':'안녕','speaker':'unknown'}]}
        result=evaluate(ref,hyp);self.assertEqual(result['CER'],0);self.assertEqual(result['diarization']['DER'],1);self.assertEqual(result['diarization']['singleSpeakerCoverage'],0)

if __name__=='__main__':unittest.main()
