import {PostprocessLedger,stageKey} from './postprocess';
export interface SummaryVault {exists(path:string):boolean;read(path:string):Promise<string>;create(path:string,text:string):Promise<unknown>;}
/** A receipt distinguishes a completed create from a pending or ambiguous create. */
export async function publishSummary(vault:SummaryVault,ledger:PostprocessLedger,key:string,path:string,body:string,owned=false){const saved=(await ledger.read()).publish;const intent=saved?.key===key?saved:{key,note:path,bodyHash:stageKey(body),created:false};await ledger.update(d=>{d.publish=intent;});
 if(vault.exists(intent.note)){if(!intent.created&&!owned&&stageKey(await vault.read(intent.note))!==intent.bodyHash)throw new Error('정리 노트 생성 중 다른 내용이 생겼습니다. 기존 문서를 유지하고 확인이 필요합니다.');}
 else await vault.create(intent.note,body);
 await ledger.update(d=>{d.publish={...intent,created:true};});return intent.note;}
