import {statSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
/** Resolve user-installed support files. This function never installs or downloads code. */
export function supportFile(pluginDirectory:string,home:string,version:string,relative:string){
 if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))throw new Error('지원 파일 버전이 올바르지 않습니다.');
 if(!/^(worker|native)\//.test(relative)||relative.split('/').some(p=>!p||p==='.'||p==='..')||relative.includes('\\'))throw new Error('지원 파일 경로가 올바르지 않습니다.');
 const managed=join(home,'Library','Application Support','obsidian-local-meeting','runtime','support',version,relative),legacy=join(pluginDirectory,relative);
 let legacyCompatible=false;try{legacyCompatible=JSON.parse(readFileSync(join(pluginDirectory,'support-version.json'),'utf8')).version===version;}catch{legacyCompatible=version==='0.15.0';}
 for(const candidate of legacyCompatible?[managed,legacy]:[managed])try{if(statSync(candidate).isFile())return candidate;}catch{}
 return managed;
}
