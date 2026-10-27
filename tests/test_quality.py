import sys
import tempfile
import unittest
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'worker'))
from quality import Activity,RevisionStore,hysteresis,activity_runs,phrase_end
from store import Store

class QualityTests(unittest.TestCase):
    def test_hysteresis_does_not_toggle_at_midpoint(self):
        a=hysteresis(np.array([[.59],[.61],[.48],[.41],[.39]]));self.assertEqual(a[:,0].tolist(),[False,True,True,True,False])
    def test_evidence_retains_overlap_candidates_and_can_read_old_frames(self):
        with tempfile.TemporaryDirectory() as root:
            a=Activity(root);values=np.zeros((8000,2),np.float32);values[:100,0]=.9;values[30:80,1]=.85;a.update(0,values,.01)
            result=a.evidence(0,1);self.assertEqual(result['speaker'],'overlap');self.assertEqual(len(result['candidates']),2)
            self.assertEqual(a.runs(0,2)[0][0],0)
    def test_incremental_activity_preserves_offsets_and_old_data(self):
        with tempfile.TemporaryDirectory() as root:
            a=Activity(root);a.update(0,np.ones((2000,2),np.float32)*.9,.01)
            a.update(1500,np.ones((1000,2),np.float32)*.45,.01)
            self.assertEqual(a.frames,2500);self.assertEqual(a.evidence(0,1)['speaker'],'overlap');self.assertEqual(a.evidence(20,21)['speaker'],'overlap')
    def test_natural_pause_and_sustained_speaker_change(self):
        self.assertEqual(phrase_end([(0,4,1),(5,6,1)],0,7),(0,4,True))
        self.assertEqual(phrase_end([(0,4,1),(4,6,2)],0,7),(0,4,True))
        # Tiny boundary flicker is not a new independent ASR request.
        self.assertEqual(phrase_end([(0,4,1),(4,4.2,3),(4.2,6,1)],0,7),(0,6,True))
    def test_active_phrase_is_provisional_until_lookahead(self):
        self.assertEqual(phrase_end([(0,6,1)],0,6),(0,6,False))
        self.assertEqual(phrase_end([(0,11,1)],0,10,max_seconds=10),(0,10,False))
        self.assertEqual(phrase_end([(0,11,1)],0,11,max_seconds=10),(0,10,True))
    def test_revision_commit_replay_and_ack(self):
        with tempfile.TemporaryDirectory() as root:
            store=Store(root);r=RevisionStore(store);s={'id':'u_1','start':0,'end':2000,'text':'처음','speaker':'unknown'}
            first=r.put(s);self.assertEqual(first['revision'],1);self.assertIsNone(r.put(s));r.ack('u_1',1)
            second=r.put({**s,'text':'다음'});self.assertEqual(second['revision'],2);r.export();store.close()
            store=Store(root);r=RevisionStore(store);self.assertEqual(r.all()[0]['text'],'다음');self.assertEqual(r.db.execute('SELECT acked FROM utterances').fetchone()[0],1);store.close()

if __name__=='__main__':unittest.main()
