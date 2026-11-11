import {accessSync,constants,readFileSync,statSync} from 'node:fs';
import {readFile,readdir,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname,isAbsolute,join,basename} from 'node:path';
import {atomicJson} from './session-registry';

export const RUNTIME_KEYS=['python','model','communityPython','communityModel','alignerModel'] as const;
export type RuntimeKey=typeof RUNTIME_KEYS[number];
export type LocalRuntime=Record<RuntimeKey,string>;
export const RUNTIME_LABELS:Record<RuntimeKey,string>={python:'음성 인식 실행 환경',model:'음성 인식 모델',communityPython:'화자 분석 실행 환경',communityModel:'화자 분석 모델',alignerModel:'대사 시간 정렬 모델'};
const file=(path:string)=>{try{return statSync(path).isFile();}catch{return false;}};
export function validRuntimePath(key:RuntimeKey,path:unknown):path is string {
 if(typeof path!=='string'||!isAbsolute(path))return false;
 if(key==='python'||key==='communityPython')try{accessSync(path,constants.X_OK);return file(path);}catch{return false;}
 if(key==='communityModel')return ['config.yaml','segmentation/pytorch_model.bin','embedding/pytorch_model.bin','plda/plda.npz','plda/xvec_transform.npz'].every(name=>file(join(path,name)));
 try{
  const config=JSON.parse(readFileSync(join(path,'config.json'),'utf8'));
  if(key==='model'&&config.model_type!=='qwen3_asr')return false;
  if(!file(join(path,'tokenizer_config.json')))return false;
  if(file(join(path,'model.safetensors')))return true;
  const index=JSON.parse(readFileSync(join(path,'model.safetensors.index.json'),'utf8'));
  const shards=Object.values(index.weight_map??{});
  return !!shards.length&&shards.every(name=>typeof name==='string'&&basename(name)===name&&file(join(path,name)));
 }catch{return false;}
}
export function missingRuntime(runtime:Partial<LocalRuntime>){return RUNTIME_KEYS.filter(key=>!validRuntimePath(key,runtime[key]));}
async function readConfig(path:string):Promise<Partial<LocalRuntime>>{try{const value=JSON.parse(await readFile(path,'utf8'));return value&&typeof value==='object'?value:{};}catch{return {};}}

/** Local files only. Retain usable explicit paths; recover missing paths from installation manifests. */
export async function discoverRuntime(current:Partial<LocalRuntime>,pluginDirectory:string,home:string){
 const managed=join(home,'Library','Application Support','obsidian-local-meeting','runtime');
 const sharedFile=join(managed,'local-runtime.json');
 const sources=[current,await readConfig(join(pluginDirectory,'local-runtime.json')),await readConfig(sharedFile)];
 const bases=new Set([managed,pluginDirectory]);
 for(const source of sources){
  for(const key of ['python','communityPython'] as const){const path=source[key];if(typeof path==='string'&&isAbsolute(path)&&basename(dirname(path))==='bin')bases.add(dirname(dirname(dirname(path))));}
  for(const key of ['model','alignerModel'] as const){const path=source[key];if(typeof path==='string'&&isAbsolute(path)&&basename(dirname(path))==='models')bases.add(dirname(dirname(path)));}
 }
 for(const base of bases)sources.push({python:join(base,'.venv/bin/python'),communityPython:join(base,'.venv-community/bin/python'),model:join(base,'models/qwen3-asr-1.7b-ko-8bit'),communityModel:join(base,'models/community-1'),alignerModel:join(base,'models/forced-aligner')});
 // The gate-protected Community model may already be in the standard HF cache.
 const cache=join(home,'.cache/huggingface/hub/models--pyannote--speaker-diarization-community-1');
 try{const revision=(await readFile(join(cache,'refs/main'),'utf8')).trim();if(/^[a-f0-9]{40}$/.test(revision))sources.push({communityModel:join(cache,'snapshots',revision)});}catch{}
 try{for(const revision of (await readdir(join(cache,'snapshots'))).filter(name=>/^[a-f0-9]{40}$/.test(name)).sort())sources.push({communityModel:join(cache,'snapshots',revision)});}catch{}
 const runtime:Partial<LocalRuntime>={};
 for(const key of RUNTIME_KEYS){const candidate=sources.map(source=>source[key]).find(path=>validRuntimePath(key,path));if(candidate)runtime[key]=candidate;}
 return {runtime,missing:missingRuntime(runtime),sharedFile,managed};
}
export async function rememberRuntime(path:string,runtime:LocalRuntime){
 if(missingRuntime(runtime).length)throw new Error('준비되지 않은 실행 환경은 저장하지 않습니다.');
 const prior=await readConfig(path);
 if(RUNTIME_KEYS.every(key=>prior[key]===runtime[key]))return;
 const staging=path+'.'+randomUUID();
 try{await atomicJson(staging,{schemaVersion:1,...Object.fromEntries(RUNTIME_KEYS.map(key=>[key,runtime[key]]))});await rename(staging,path);}finally{await unlink(staging).catch(()=>{});await unlink(staging+'.tmp').catch(()=>{});}
}
