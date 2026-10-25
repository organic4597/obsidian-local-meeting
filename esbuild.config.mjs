import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist/worker',{recursive:true});
await build({entryPoints:['src/main.ts'],bundle:true,external:['obsidian','electron'],platform:'node',format:'cjs',target:'es2022',outfile:'dist/main.js',sourcemap:true});
for(const file of ['manifest.json','styles.css']) await copyFile(file,`dist/${file}`);
for(const file of ['main.py','store.py','capture.py','requirements.txt']) await copyFile(`worker/${file}`,`dist/worker/${file}`);
