import {spawn} from 'node:child_process';
export interface Term {schemaVersion:1;id:string;canonical:string;pronunciations:string[];observedErrors:string[];contextTags:string[];category:string;scope:{kind:'meeting'|'project'|'vault'|'personal';id:string};recognitionHint:boolean;postprocess:'hint'|'normalize'|'suggest';confirmedByUser:boolean;enabled:boolean;revision:number;}
export interface DictionarySnapshot {schemaVersion:1;enabled:boolean;project:string;revision:string;terms:Term[];conflicts:{alias:string;terms:string[]}[];}
export interface DictionaryData {terms:Term[];projects:{id:string;name:string}[];snapshot:DictionarySnapshot;}
export class LocalDictionary {
 constructor(private python:string,private script:string,private root:string,readonly vaultId:string){}
 request<T=DictionaryData>(request:Record<string,unknown>):Promise<T>{
  return new Promise((resolve,reject)=>{
   const child=spawn(this.python,[this.script,'--root',this.root,'--vault',this.vaultId],{shell:false,stdio:'pipe'});
   let out='',error='',done=false;
   const finish=(err?:Error)=>{if(done)return;done=true;clearTimeout(timer);if(err)reject(err);else try{resolve(JSON.parse(out) as T);}catch{reject(new Error('사전 응답을 읽을 수 없습니다.'));}};
   const timer=setTimeout(()=>{child.kill();finish(new Error('사전 처리 시간이 초과됐습니다.'));},15000);
   child.on('error',finish);child.stdout.on('data',(b:Buffer)=>{out+=b.toString();if(out.length>8_000_000){child.kill();finish(new Error('사전 응답이 너무 큽니다.'));}});
   child.stderr.on('data',(b:Buffer)=>{error=(error+b.toString()).slice(-2000);});
   child.on('close',code=>finish(code===0?undefined:new Error(error||`사전 처리 실패 (${code})`)));
   child.stdin.on('error',finish);child.stdin.end(JSON.stringify(request));
  });
 }
}
export function dictionaryCsv(terms:Term[]){const quote=(s:string)=>'"'+s.replace(/"/g,'""')+'"';return '\uFEFF'+[['표준 용어','발음과 별칭','확인된 오인식','종류','범위','정책'],...terms.map(t=>[t.canonical,t.pronunciations.join(' / '),t.observedErrors.join(' / '),t.category,t.scope.kind,t.postprocess])].map(row=>row.map(quote).join(',')).join('\r\n');}
