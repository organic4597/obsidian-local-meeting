import importlib.util,json,subprocess,sys,tempfile,unittest,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('distribution',ROOT/'scripts/package_distribution.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
@unittest.skipUnless(sys.platform=='darwin','native support is built only on macOS')
class DistributionTests(unittest.TestCase):
 def test_store_and_support_are_separate_and_installer_checks_before_writing(self):
  with tempfile.TemporaryDirectory(prefix='lm-dist-') as tmp:
   result=module.package(tmp);root=Path(tmp);self.assertEqual(set(result['communityAssets']),{'main.js','manifest.json','styles.css'})
   command=root/'companion/Install Local Meeting Support.command'
   before=(ROOT/'manifest.json').read_bytes()
   probe=subprocess.run(['bash',str(command),'--dry-run'],capture_output=True,text=True)
   self.assertEqual(probe.returncode,0,probe.stderr);self.assertIn('Verified support files',probe.stdout)
   self.assertEqual((ROOT/'manifest.json').read_bytes(),before)
   (root/'companion/support/worker/main.py').write_text('corrupt')
   probe=subprocess.run(['bash',str(command),'--dry-run'],capture_output=True,text=True)
   self.assertNotEqual(probe.returncode,0)
   with zipfile.ZipFile(root/result['supportArchive']) as z:self.assertIsNone(z.testzip())
