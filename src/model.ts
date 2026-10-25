export interface Segment { id: string; start: number; end: number; text: string; speaker: string; speakerLocked?:boolean; }
export interface Anchor {from:number;to:number;locked?:boolean;deleted?:boolean;}
export interface Meeting { id:string;note:string;directory:string;started:string;speakers:Record<string,string>;segments:Segment[];rendered:Record<string,string>;anchors?:Record<string,Anchor>;noteSnapshot?:string; }
export function timestamp(ms:number):string {const s=Math.floor(ms/1000);return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}
const clean=(s:string)=>s.replace(/[\r\n]+/g,' ').replace(/<!--/g,'&lt;!--');
export function speakerName(segment:Segment,speakers:Record<string,string>):string {return clean(speakers[segment.speaker]??(segment.speaker==='unknown'?'화자 미확정':segment.speaker==='overlap'?'동시 발언':segment.speaker.replace(/^speaker_/, '화자 ')));}
export function segmentText(segment:Segment,speakers:Record<string,string>,showTime=false):string {return `${showTime?`(${timestamp(segment.start)}) `:''}${speakerName(segment,speakers)}: ${clean(segment.text)}`;}
export function rebaseAnchors(meeting:Meeting,before:string,after:string){
 if(before===after)return;
 let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
 let a=before.length,b=after.length;while(a>start&&b>start&&before[a-1]===after[b-1]){a--;b--;}
 const delta=(b-start)-(a-start);
 for(const anchor of Object.values(meeting.anchors??{})){
  if(anchor.deleted)continue;
  if(a<=anchor.from && !(a===start&&start===anchor.from&&!after.slice(start,b).includes('\n'))){anchor.from+=delta;anchor.to+=delta;}
  else if(start>=anchor.to)continue;
  else {anchor.locked=true;if(start<=anchor.from&&a>=anchor.to){anchor.deleted=true;continue;}anchor.from=Math.min(anchor.from,start);anchor.to=Math.max(anchor.from,anchor.to+delta);}
 }
 meeting.noteSnapshot=after;
}
const legacyLine=(line:string)=>line.replace(/^\*\*\[\d\d:\d\d:\d\d\] (.*?)\*\*:\s?/, '$1: ');
export function cleanLegacyNote(note:string):string {
 let managed=false;
 return note.split('\n').filter(line=>{
  if(/^\s*<!--\s*\/?lm:[a-zA-Z0-9-]+:[a-zA-Z0-9_-]+\s*-->\s*$/.test(line)){managed=!/^\s*<!--\s*\/lm:/.test(line);return false;}
  if(/^## 회의 기록 \(/.test(line)||/^> 로컬 전사 · 화자 구분 미연결/.test(line))return false;
  return true;
 }).map(legacyLine).join('\n');
}
export function migrateMeeting(note:string,meeting:Meeting):string {
 const next=cleanLegacyNote(note);meeting.anchors??={};
 for(const [id,text] of Object.entries(meeting.rendered)){
  const plain=legacyLine(text);meeting.rendered[id]=plain;
  if(meeting.anchors[id])continue;
  const pos=next.indexOf(plain);
  if(pos>=0&&next.indexOf(plain,pos+plain.length)<0)meeting.anchors[id]={from:pos,to:pos+plain.length};
  else meeting.anchors[id]={from:0,to:0,deleted:true,locked:true};
 }
 meeting.noteSnapshot=next;return next;
}
export function patchSegment(note:string,meeting:Meeting,segment:Segment,showTime=false,mode:'normal'|'time'|'speaker'='normal'):string {
 meeting.anchors??={};
 if(meeting.noteSnapshot!==undefined)rebaseAnchors(meeting,meeting.noteSnapshot,note);
 const old=meeting.rendered[segment.id];let anchor=meeting.anchors[segment.id];
 if(!anchor&&old!==undefined){const plain=legacyLine(old);const pos=note.indexOf(plain);if(pos<0||note.indexOf(plain,pos+plain.length)>=0)return note;anchor=meeting.anchors[segment.id]={from:pos,to:pos+plain.length};meeting.rendered[segment.id]=plain;}
 let next=segmentText(segment,meeting.speakers,showTime);
 if(!anchor){const prefix=note.length?(note.endsWith('\n\n')?'':note.endsWith('\n')?'\n':'\n\n'):'';const from=note.length+prefix.length;meeting.anchors[segment.id]={from,to:from+next.length};meeting.rendered[segment.id]=next;const result=note+prefix+next+'\n\n';meeting.noteSnapshot=result;return result;}
 if(anchor.deleted)return note;
 const current=note.slice(anchor.from,anchor.to);
 if(current!==meeting.rendered[segment.id])anchor.locked=true;
 if(anchor.locked){
  if(mode==='normal')return note;
  next=current.replace(/^\(\d\d:\d\d:\d\d\) /,'');
  if(mode==='speaker'){
   const previous=(old??'').replace(/^\(\d\d:\d\d:\d\d\) /,'').split(': ')[0];
   if(previous&&next.startsWith(previous+': '))next=speakerName(segment,meeting.speakers)+next.slice(previous.length);
  }
  if(showTime)next=`(${timestamp(segment.start)}) `+next;
 }
 const start=anchor.from,end=anchor.to,delta=next.length-(end-start);
 for(const other of Object.values(meeting.anchors))if(other!==anchor&&!other.deleted&&other.from>=end){other.from+=delta;other.to+=delta;}
 anchor.to=start+next.length;meeting.rendered[segment.id]=next;
 const result=note.slice(0,start)+next+note.slice(end);meeting.noteSnapshot=result;return result;
}
export type WorkerEvent={type:'ready'|'stopped';session:string}|{type:'status';pending:number;lag:number;state:string}|{type:'segment';segment:Segment}|{type:'error';message:string;fatal?:boolean};
export function parseEvent(line:string):WorkerEvent {
 const x:unknown=JSON.parse(line);if(!x||typeof x!=='object'||!('type'in x))throw new Error('잘못된 워커 메시지');const e=x as Record<string,unknown>;
 if(e.type==='segment'){const s=e.segment as Segment|undefined;if(!s||typeof s.id!=='string'||!/^[a-zA-Z0-9_-]+$/.test(s.id)||typeof s.text!=='string'||typeof s.speaker!=='string'||!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<s.start)throw new Error('잘못된 전사 구간');}
 else if(e.type==='error'){if(typeof e.message!=='string')throw new Error('잘못된 오류');}
 else if(e.type==='status'){if(typeof e.state!=='string'||!Number.isFinite(e.pending)||!Number.isFinite(e.lag))throw new Error('잘못된 상태');}
 else if(e.type!=='ready'&&e.type!=='stopped')throw new Error('알 수 없는 워커 메시지');return x as WorkerEvent;
}
