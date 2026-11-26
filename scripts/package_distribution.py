#!/usr/bin/env python3
"""Package the three store assets and a separately user-installed support bundle."""
import hashlib,json,shutil,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def package(output):
    version=json.loads((ROOT/'manifest.json').read_text())['version']
    output=Path(output);output.mkdir(parents=True,exist_ok=True)
    store=output/'community';store.mkdir(exist_ok=True)
    for name in ['main.js','manifest.json','styles.css']:shutil.copy2(ROOT/'dist'/name,store/name)
    stage=output/'companion'
    if stage.exists():shutil.rmtree(stage)
    support=stage/'support';support.mkdir(parents=True)
    for name in ['worker','native','skills','third-party']:shutil.copytree(ROOT/'dist'/name,support/name,ignore=shutil.ignore_patterns('__pycache__','*.pyc','.DS_Store'))
    shutil.copy2(ROOT/'LICENSE',support/'LICENSE')
    (support/'tools').mkdir();shutil.copy2(ROOT/'scripts/prepare_model.py',support/'tools/prepare_model.py')
    (support/'support-version.json').write_text(json.dumps({'version':version})+'\n')
    sums=''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(support).as_posix()+'\n' for p in sorted(support.rglob('*')) if p.is_file())
    (stage/'SUPPORT-SHA256SUMS.txt').write_text(sums)
    installer='''#!/bin/bash
set -eu
root="$(cd -- "$(dirname -- "$0")" && pwd)"
version="VERSION_PLACEHOLDER"
target="$HOME/Library/Application Support/obsidian-local-meeting/runtime/support/$version"
cd "$root/support"
/usr/bin/shasum -a 256 -c "$root/SUPPORT-SHA256SUMS.txt" >/dev/null
if [ "${1:-}" = "--dry-run" ]; then printf 'Verified support files. Destination: %s\n' "$target"; exit 0; fi
parent="$(dirname -- "$target")"
mkdir -p "$parent"
if [ -e "$target" ]; then
 (cd "$target" && /usr/bin/shasum -a 256 -c "$root/SUPPORT-SHA256SUMS.txt" >/dev/null) || { printf 'Existing support files differ. No files changed.\n' >&2; exit 1; }
else
 staging="$(mktemp -d "$parent/.install-XXXXXX")"
 trap 'rm -rf -- "$staging"' EXIT
 /usr/bin/ditto "$root/support" "$staging"
 mv -- "$staging" "$target"
 trap - EXIT
fi
printf 'Local Meeting support %s is ready. Python and models must also be prepared; see SETUP.ko.md.\n' "$version"
'''.replace('VERSION_PLACEHOLDER',version)
    script=stage/'Install Local Meeting Support.command';script.write_text(installer);script.chmod(0o755)
    shutil.copy2(ROOT/'docs/INSTALL.ko.md',stage/'SETUP.ko.md')
    archive=output/f'local-meeting-support-{version}-macos-arm64.zip'
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
        for p in sorted(stage.rglob('*')):
            if p.is_file():z.write(p,p.relative_to(stage))
    assert set(p.name for p in store.iterdir())=={'main.js','manifest.json','styles.css'}
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        assert (z.getinfo(script.name).external_attr>>16)&0o111
        assert not any(Path(n).suffix in ['.wav','.sqlite','.safetensors','.gguf','.map'] or Path(n).name in ['data.json','local-runtime.json','token'] for n in z.namelist())
    files=[*sorted(store.iterdir()),archive]
    (output/'SHA256SUMS.txt').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(output).as_posix()+'\n' for p in files))
    return {'version':version,'communityAssets':[p.name for p in sorted(store.iterdir())],'supportArchive':archive.name,'modelWeightsBundled':False}
if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);args=parser.parse_args();print(json.dumps(package(args.output),indent=2))
