import {build} from 'esbuild';
import {mkdir,copyFile,rm,cp,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
if(process.platform==='darwin')execFileSync('sh',['scripts/build_native.sh'],{stdio:'inherit'});
await mkdir('dist/worker',{recursive:true});
await build({entryPoints:['src/main.ts'],bundle:true,external:['obsidian','electron','@codemirror/state','@codemirror/view'],platform:'node',format:'cjs',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},target:'es2022',outfile:'dist/main.js',sourcemap:true});
for(const file of ['manifest.json','styles.css']) await copyFile(file,`dist/${file}`);
for(const file of ['asr_guard.py','main.py','store.py','capture.py','system_capture.py','recording.py','pcm.py','legacy_recovery.py','dictionary.py','quality.py','endpoints.py','text_worker.py','community_pipeline.py','community_diarize.py','voice_features.py','live_speakers.py','streaming_phrase.py','worker_cleanup.py','stage_artifacts.py','postprocess_rescan.py','retranscribe.py','post_alignment.py','requirements-community.txt','requirements.txt']) await copyFile(`worker/${file}`,`dist/worker/${file}`);

for(const file of ['diarization.py','quality_worker.py','finalize_diarization.py']) await rm(`dist/worker/${file}`,{force:true});

await cp('skills','dist/skills',{recursive:true});
await cp('third-party','dist/third-party',{recursive:true});

// Scope Astryx's reset and components to plugin-owned roots; never reset the host app.
const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
const astryxStyles=await Promise.all(['@astryxdesign/core/reset.css','@astryxdesign/core/astryx.css','@astryxdesign/theme-neutral/theme.css'].map(file=>readFile(require.resolve(file),'utf8')));
const {default:postcss}=await import('postcss');const scoped=postcss.parse(astryxStyles.join('\n'));
// Host styles are unlayered. Preserve Astryx rules at the same cascade level inside our scope.
scoped.walkAtRules('layer',rule=>{if(rule.nodes)rule.replaceWith(rule.nodes);else rule.remove();});
await writeFile('dist/styles.css',(await readFile('styles.css','utf8'))+'\n@scope (.lm-astryx-root) {\n'+scoped.toString()+'\n}\n');
