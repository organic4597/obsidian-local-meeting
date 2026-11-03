import {textEdits} from './text-edits';
import {ChangeSet} from '@codemirror/state';
import {Meeting,NoteTiming} from './model';
export interface NoteClock {audioMs:number;uncertaintyMs:number;source:'capture-clock'|'estimated';wallMs:number;}
export function noteClock(diagnostics:Record<string,unknown>,now:number):NoteClock|null{
 const samples=Number(diagnostics.samples),rate=Number(diagnostics.sampleRate),at=Number(diagnostics.captureWallTimeMs);
 if(!Number.isFinite(samples)||samples<0||!Number.isFinite(rate)||rate<=0||!Number.isFinite(at)||at<=0)return null;
 const age=Math.max(0,now-at);if(age>10000)return null;
 return {audioMs:Math.round(samples/rate*1000+age),uncertaintyMs:Math.max(300,Math.round(age+100)),source:'capture-clock',wallMs:now};
}
/** Track note ranges independently of transcript anchors; never write into note text. */
export function timeNoteChanges(meeting:Meeting,changes:ChangeSet,clock:NoteClock|null,user=true){
 if(changes.empty)return;
 const marks=meeting.noteTimings??=[];
 for(const m of marks){if(m.deleted)continue;let erased=false;changes.iterChanges((a,b)=>{if(a<=m.from&&b>=m.to&&b>a)erased=true;});
  m.from=changes.mapPos(m.from,1);m.to=Math.max(m.from,changes.mapPos(m.to,-1));if(erased||m.from===m.to)m.deleted=true;
 }
 if(user&&clock)changes.iterChanges((_a,_b,from,to,insert)=>{
  if(!insert.toString().trim())return;
  const last=marks.at(-1),near=last&&!last.deleted&&clock.wallMs-Date.parse(last.updated)<2000&&from<=last.to+1&&to>=last.from;
  if(near){last.from=Math.min(last.from,from);last.to=Math.max(last.to,to);last.end=clock.audioMs;last.updated=new Date(clock.wallMs).toISOString();last.uncertaintyMs=Math.max(last.uncertaintyMs,clock.uncertaintyMs);}
  else marks.push({id:crypto.randomUUID(),from,to,start:clock.audioMs,end:clock.audioMs,updated:new Date(clock.wallMs).toISOString(),source:clock.source,uncertaintyMs:clock.uncertaintyMs});
 });
 meeting.noteTimings=marks;
}
export function timedNotes(meeting:Meeting,document:string){return (meeting.noteTimings??[]).filter(m=>!m.deleted&&m.from>=0&&m.to<=document.length).map(m=>({...m,text:document.slice(m.from,m.to),nearbySpeech:meeting.segments.filter(s=>s.end>=m.start-10000&&s.start<=m.end+10000).map(s=>s.id)}));}

export function timeNoteDocument(meeting:Meeting,before:string,after:string,changes:ChangeSet,clock:NoteClock|null,user=true){
 if(meeting.noteTimingSnapshot===after)return;
 const prior=meeting.noteTimingSnapshot;
 if(prior!==undefined&&prior!==before)timeNoteChanges(meeting,ChangeSet.of(textEdits(prior,before),prior.length),null,false);
 timeNoteChanges(meeting,changes,clock,user);meeting.noteTimingSnapshot=after;
}
