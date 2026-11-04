import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {Segment} from './model';
export interface CorrectionCandidate {id:string;before:string;after:string;count:number;conflict:boolean;status:'pending'|'accepted'|'dismissed';}
interface Observation {session:string;segment:string;before:string;after:string;}
/** Bounded word/phrase expansion; semantic edits remain review candidates, never rules. */
export function correctionPair(before:string,after:string){
 before=before.normalize('NFC').trim();after=after.normalize('NFC').trim();if(before===after)return null;
 let a=0;while(a<Math.min(before.length,after.length)&&before[a]===after[a])a++;
 let b=before.length,c=after.length;while(b>a&&c>a&&before[b-1]===after[c-1]){b--;c--;}
 while(a>0&&!/\s/.test(before[a-1]!)&&!/\s/.test(after[a-1]!))a--;
 while(b<before.length&&!/\s/.test(before[b]!))b++;
 while(c<after.length&&!/\s/.test(after[c]!))c++;
 const old=before.slice(a,b).trim(),next=after.slice(a,c).trim();
 if(!old||!next||old===next||old.length>80||next.length>80||/[\d\r\n]/.test(old+next)||/^(안|못|아니요|아니오|없다|있다|불가|가능)$/.test(old)||/^(안|못|아니요|아니오|없다|있다|불가|가능)$/.test(next))return null;
 return {before:old,after:next};
}
export class CorrectionCandidates {
 private chain:Promise<unknown>=Promise.resolve();
 constructor(private file:string){}
 private async load():Promise<{observations:Record<string,Observation>;status:Record<string,CorrectionCandidate['status']>}>{try{const d=JSON.parse(await readFile(this.file,'utf8'));if(d.schemaVersion!==1||!d.observations||!d.status)throw new Error('교정 후보 저장 형식을 확인해 주세요.');return d;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {observations:{},status:{}};throw e;}}
 private async update(fn:(d:Awaited<ReturnType<CorrectionCandidates['load']>>)=>void){const work=this.chain.then(async()=>{const d=await this.load();fn(d);await mkdir(dirname(this.file),{recursive:true});await writeFile(this.file+'.tmp',JSON.stringify({schemaVersion:1,...d}),{mode:0o600});await rename(this.file+'.tmp',this.file);});this.chain=work.catch(()=>{});await work;}
 async observe(session:string,s:Segment){await this.update(d=>{const key=session+':'+s.id;const pair=s.textLocked&&s.textState!=='provisional'&&s.history?.length?correctionPair(s.rawText??s.history[0]!.before.text,s.text):null;if(pair)d.observations[key]={session,segment:s.id,...pair};else delete d.observations[key];const keys=Object.keys(d.observations);for(const k of keys.slice(0,Math.max(0,keys.length-5000)))delete d.observations[k];});}
 async status(id:string,status:CorrectionCandidate['status']){await this.update(d=>{d.status[id]=status;});}
 async list(){await this.chain;const d=await this.load(),groups=new Map<string,CorrectionCandidate>();for(const o of Object.values(d.observations)){const id=createHash('sha256').update(JSON.stringify([o.before,o.after])).digest('hex');const g=groups.get(id);if(g)g.count++;else groups.set(id,{id,before:o.before,after:o.after,count:1,conflict:false,status:d.status[id]??'pending'});}const all=[...groups.values()];for(const g of all)g.conflict=all.some(other=>other.before===g.before&&other.after!==g.after);return all.filter(g=>g.count>=2).sort((a,b)=>b.count-a.count);}
}
