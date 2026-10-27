import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'worker'))
from dictionary import Dictionary,validate_term,snapshot,context_text,postprocess

def term(**values):return validate_term({'id':'term_1','canonical':'OpenSearch','pronunciations':['오픈 서치'],'observedErrors':['오픈소치'],'scope':{'kind':'vault','id':'vault'},'confirmedByUser':True,'postprocess':'normalize',**values})

class DictionaryTests(unittest.TestCase):
    def test_normalization_and_proposals_never_chain(self):
        snap=snapshot([term()]);text,changes=postprocess('오픈 서치는 정상입니다. 오픈소치도 확인합니다.',snap)
        self.assertEqual(text,'OpenSearch는 정상입니다. 오픈소치도 확인합니다.')
        self.assertEqual([c['state'] for c in changes],['applied','suggested'])
        self.assertEqual(text[changes[1]['start']:changes[1]['end']],'오픈소치')
    def test_ambiguous_alias_and_embedded_word_are_not_replaced(self):
        other=term(id='term_2',canonical='Other',pronunciations=['오픈 서치'])
        text,changes=postprocess('오픈 서치와 오픈 서치서버',snapshot([term(),other]))
        self.assertEqual(text,'오픈 서치와 오픈 서치서버');self.assertFalse(changes)
    def test_numbers_are_proposals_not_silent_changes(self):
        text,changes=postprocess('이케이 장비',snapshot([term(canonical='2K',pronunciations=['이케이'])]))
        self.assertEqual(text,'이케이 장비');self.assertEqual(changes[0]['state'],'suggested')
    def test_context_limits_and_errors_not_injected(self):
        snap=snapshot([term()]);context=context_text(snap,lambda s:list(s),max_tokens=30)
        self.assertIn('OpenSearch',context);self.assertNotIn('오픈소치',context)
        self.assertEqual(context_text(snap,lambda s:list(s),max_tokens=3),'')
    def test_snapshot_is_reproducible_when_loaded_by_worker(self):
        first=snapshot([term()]);second=snapshot([validate_term(t) for t in first['terms']])
        self.assertEqual(first['revision'],second['revision'])
    def test_disabled_override_does_not_resurrect_lower_scope(self):
        lower=term(scope={'kind':'personal','id':'shared'})
        upper=term(id='upper',enabled=False,scope={'kind':'meeting','id':'session'})
        self.assertEqual(snapshot([lower,upper],meeting='session')['terms'],[])
        self.assertEqual(len(snapshot([lower,upper],meeting='different')['terms']),1)
    def test_utf16_offsets_match_javascript_after_emoji(self):
        text,changes=postprocess('🙂 오픈소치',snapshot([term()]));self.assertEqual(changes[0]['start'],3)
    def test_store_scope_move_is_versioned_and_stale_edit_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            db=Dictionary(root,'vault');db.request({'type':'save','term':term()})
            saved=db.terms()[0];moved={**saved,'scope':{'kind':'personal','id':'shared'}}
            db.request({'type':'save','term':moved});self.assertEqual(len(db.terms()),1);self.assertEqual(db.terms()[0]['revision'],2)
            with self.assertRaises(ValueError):db.request({'type':'save','term':moved})
            db.close()
    def test_import_is_atomic_validated_and_does_not_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            db=Dictionary(root,'vault');db.request({'type':'save','term':term()})
            data={'schemaVersion':1,'terms':[term(),term(id='new',canonical='MariaDB')]}
            preview=db.request({'type':'import_preview','data':data});self.assertEqual(preview['accepted'],1);self.assertEqual(len(db.terms()),1)
            db.request({'type':'import_commit','data':data});self.assertEqual(len(db.terms()),2)
            with self.assertRaises(ValueError):db.request({'type':'import_commit','data':{'schemaVersion':1,'terms':[term(canonical='Good'),{'canonical':''}]}})
            self.assertEqual(len(db.terms()),2);db.close()

if __name__=='__main__':unittest.main()
