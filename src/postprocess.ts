import {readFile,open,unlink,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {atomicJson} from './session-registry';
export type StageStatus='running'|'succeeded'|'failed'|'waiting_input';
export interface StageState {inputKey:string;status:StageStatus;message?:string;artifact?:string;updated:string;cached?:boolean;}
export class PostprocessLedger {
 private chain:Promise<unknown>=Promise.resolve();
 constructor(private directory:string){}
 async read():Promise<{schemaVersion:1;stages:Record<string,StageState>;publish?:{key:string;note:string;bodyHash:string;created:boolean}}>{
  let failure:unknown;for(const name of ['postprocess-v1.json','postprocess-v1.json.bak'])try{const d=JSON.parse(await readFile(join(this.directory,name),'utf8'));if(d.schemaVersion!==1||!d.stages||typeof d.stages!=='object')throw new Error('후처리 상태 형식이 다릅니다.');return d;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')failure??=e;}
  if(failure)throw failure;return {schemaVersion:1,stages:{}};
 }
 async update(fn:(d:Awaited<ReturnType<PostprocessLedger['read']>>)=>void){const work=this.chain.then(async()=>{const d=await this.read();fn(d);d.schemaVersion=1;await atomicJson(join(this.directory,'postprocess-v1.json.bak'),await this.read());await atomicJson(join(this.directory,'postprocess-v1.json'),d);});this.chain=work.catch(()=>{});await work;}
 async mark(stage:string,state:Omit<StageState,'updated'>){await this.update(d=>{d.stages[stage]={...state,updated:new Date().toISOString()};});}
 async track<T>(stage:string,input:unknown,work:()=>Promise<T>){const inputKey=stageKey(input);await this.mark(stage,{inputKey,status:'running'});try{const result=await work();await this.mark(stage,{inputKey,status:'succeeded'});return result;}catch(e){await this.mark(stage,{inputKey,status:'failed',message:String(e)});throw e;}}
 async lock<T>(work:()=>Promise<T>){await mkdir(this.directory,{recursive:true});const path=join(this.directory,'.postprocess-app.lock'),token=randomUUID();let acquired=false;for(let i=0;i<2;i++){try{const f=await open(path,'wx',0o600);await f.writeFile(JSON.stringify({pid:process.pid,token}));await f.close();acquired=true;break;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const old=JSON.parse(await readFile(path,'utf8'));try{process.kill(old.pid,0);throw new Error('이 회의의 다른 문서 반영 작업이 실행 중입니다.');}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH'){await unlink(path);continue;}throw error;}}}if(!acquired)throw new Error('후처리 잠금을 확인해 주세요.');try{return await work();}finally{try{if(JSON.parse(await readFile(path,'utf8')).token===token)await unlink(path);}catch{}}}
}
export const stageKey=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
