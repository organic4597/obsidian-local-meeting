import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
if(process.platform==='darwin')execFileSync('sh',['scripts/build_native.sh'],{stdio:'inherit'});
await mkdir('dist/worker',{recursive:true});
await build({entryPoints:['src/main.ts'],bundle:true,external:['obsidian','electron','@codemirror/state','@codemirror/view'],platform:'node',format:'cjs',target:'es2022',outfile:'dist/main.js',sourcemap:true});
for(const file of ['manifest.json','styles.css']) await copyFile(file,`dist/${file}`);
for(const file of ['main.py','store.py','capture.py','recording.py','diarization.py','dictionary.py','quality.py','quality_worker.py','endpoints.py','finalize_diarization.py','requirements.txt']) await copyFile(`worker/${file}`,`dist/worker/${file}`);
