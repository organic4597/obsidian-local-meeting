import {randomUUID} from 'node:crypto';
import {readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {EvidencePoint,MeetingEvent,MeetingTask,MeetingTerm,SummaryResult} from './ai-summary';
export type ReviewKind='event'|'task'|'term'|'decision'|'question';
export type ReviewValue=MeetingEvent|MeetingTask|MeetingTerm|EvidencePoint;
export interface ReviewItem {id:string;sourceHash:string;model:string;kind:ReviewKind;original:ReviewValue;edited:ReviewValue;status:'pending'|'excluded'|'accepted';calendar?:{state:'saving'|'saved'|'unknown';uid:string;eventId?:string;calendarId?:string};noteWrite?:{state:'saving'|'saved'|'unknown';path:string};dictionaryTermId?:string;similarSaved?:boolean;}
interface Data {schemaVersion:1;items:ReviewItem[];}
/** Per-meeting store; each mutation is serialized and persisted before it is exposed. */
export class SummaryReviewStore {
 private data:Data={schemaVersion:1,items:[]};private loaded=false;private pending:Promise<unknown>=Promise.resolve();
 constructor(private directory:string){}
 private async load(){if(this.loaded)return;try{const d=JSON.parse(await readFile(join(this.directory,'ai-review.json'),'utf8'));if(d.schemaVersion!==1||!Array.isArray(d.items))throw new Error('검토 데이터 형식을 확인하지 못했습니다.');this.data=d;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}this.loaded=true;}
 private mutate<T>(fn:()=>T):Promise<T>{const run=this.pending.then(async()=>{await this.load();const old=structuredClone(this.data);try{const value=fn();const file=join(this.directory,'ai-review.json');await writeFile(file+'.tmp',JSON.stringify(this.data,null,2),{mode:0o600});await rename(file+'.tmp',file);return structuredClone(value);}catch(e){this.data=old;throw e;}});this.pending=run.catch(()=>{});return run;}
 ensure(result:SummaryResult):Promise<ReviewItem[]>{return this.mutate(()=>{const sourceHash=result.sourceHash,model=result.model;const existing=this.data.items.filter(i=>i.sourceHash===sourceHash&&i.model===model);const all:[ReviewKind,ReviewValue[]][]=[['decision',result.value.decisions],['task',result.value.tasks],['event',result.value.events],['question',result.value.openQuestions],['term',result.value.terms??[]]];const used=new Set<string>();for(const [kind,values] of all)for(const value of values){const match=existing.find(i=>i.kind===kind&&!used.has(i.id)&&JSON.stringify(i.original)===JSON.stringify(value));if(match){used.add(match.id);continue;}const item:ReviewItem={id:randomUUID(),sourceHash,model,kind,original:structuredClone(value),edited:structuredClone(value),status:'pending'};this.data.items.push(item);existing.push(item);used.add(item.id);}return existing;});}
 update(id:string,fn:(item:ReviewItem)=>void){return this.mutate(()=>{const item=this.data.items.find(i=>i.id===id);if(!item)throw new Error('검토 항목을 찾을 수 없습니다.');fn(item);return item;});}
 async list(result:SummaryResult){const items=await this.ensure(result);return items.map(item=>{if(item.kind!=='event')return item;const title=(item.edited as MeetingEvent).title.normalize('NFC').trim().toLocaleLowerCase();return {...item,similarSaved:!!title&&this.data.items.some(other=>other.id!==item.id&&other.kind==='event'&&!!other.calendar&&(other.edited as MeetingEvent).title.normalize('NFC').trim().toLocaleLowerCase()===title)};});}
}
