import {build} from 'esbuild';
import {mkdir,copyFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
if(process.platform==='darwin')execFileSync('sh',['scripts/build_native.sh'],{stdio:'inherit'});
await mkdir('dist/worker',{recursive:true});
await build({entryPoints:['src/main.ts'],bundle:true,external:['obsidian','electron','@codemirror/state','@codemirror/view'],platform:'node',format:'cjs',target:'es2022',outfile:'dist/main.js',sourcemap:true});
for(const file of ['manifest.json','styles.css']) await copyFile(file,`dist/${file}`);
for(const file of ['main.py','store.py','capture.py','system_capture.py','recording.py','pcm.py','legacy_recovery.py','dictionary.py','quality.py','endpoints.py','text_worker.py','community_pipeline.py','community_diarize.py','voice_features.py','post_alignment.py','requirements-community.txt','requirements.txt']) await copyFile(`worker/${file}`,`dist/worker/${file}`);

for(const file of ['diarization.py','quality_worker.py','finalize_diarization.py']) await rm(`dist/worker/${file}`,{force:true});
