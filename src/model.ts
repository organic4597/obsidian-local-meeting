import {textEdits} from './text-edits';
export interface TermChange {id:string;termId:string;start:number;end:number;before:string;after:string;state:'suggested'|'applied'|'dismissed';}
export interface Candidate {speaker:string;activity:number;activeSeconds:number;}
export interface ReviewHistory {at:string;before:{text:string;speaker:string;textLocked?:boolean;speakerLocked?:boolean;speakerState?:Segment['speakerState'];suggestions?:TermChange[];reviewedRevision?:number};afterText:string;afterSpeaker:string;userRevision:number;}
export interface Segment { id: string; start: number; end: number; text: string; speaker: string; speakerLocked?:boolean; textLocked?:boolean;revision?:number;eventId?:string;rawText?:string;textState?:'stable'|'provisional'|'review_required';speakerState?:'single'|'overlap'|'unknown'|'manual';candidates?:Candidate[];reviewReasons?:string[];suggestions?:TermChange[];dictionaryRevision?:string;reviewedRevision?:number;userRevision?:number;history?:ReviewHistory[]; }
export interface Anchor {from:number;to:number;locked?:boolean;deleted?:boolean;continuation?:boolean;speakerShown?:boolean;}
export interface Meeting { id:string;note:string;directory:string;started:string;speakers:Record<string,string>;segments:Segment[];rendered:Record<string,string>;anchors?:Record<string,Anchor>;noteSnapshot?:string;paragraphPauseMs?:number;pipelineVersion?:number;dictionaryRevision?:string;speakerPassId?:string;speakerRefinement?:{detected:number;expected:number;warning:string;processingSeconds:number};transcriptMode?:'text-only'|'dialogue';speakerCount?:number;speakerCountMode?:'maximum'|'exact';originalSegments?:Record<string,Segment>;aiSummary?:{sourceHash:string;note:string;model:string;created:string;stale:boolean}; }
export interface SpeakerTurn {start:number;end:number;speaker:string;}
export interface SpeakerRefinement {type:'speaker_refinement';session:string;passId:string;preset:'v3-offline'|'community-1-mps';alignments?:Record<string,{text:string;words:{from:number;to:number;start:number;end:number}[];reviewRequired?:boolean}>;turns:SpeakerTurn[];detectedSpeakers:number;processingSeconds:number;}
export function timestamp(ms:number):string {const s=Math.floor(ms/1000);return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}
const clean=(s:string)=>s.replace(/[\r\n]+/g,' ').replace(/<!--/g,'&lt;!--');
export function speakerName(segment:Segment,speakers:Record<string,string>):string {return clean(speakers[segment.speaker]??(segment.speaker==='pending'?'화자 구분 대기':segment.speaker==='unknown'?'화자 미확정':segment.speaker==='overlap'?'동시 발언':segment.speaker.replace(/^speaker_/, '화자 ')));}
export function segmentText(segment:Segment,speakers:Record<string,string>,showTime=false,showSpeaker=true):string {return `${showTime?`(${timestamp(segment.start)}) `:''}${showSpeaker?speakerName(segment,speakers)+': ':''}${clean(segment.text)}`;}
export function rebaseAnchors(meeting:Meeting,before:string,after:string){
 if(before===after)return;
 for(const edit of textEdits(before,after).reverse()){
  const start=edit.from,a=edit.to,delta=edit.insert.length-(a-start);
  for(const anchor of Object.values(meeting.anchors??{})){
   if(anchor.deleted)continue;
   if(a<=anchor.from&&!(a===start&&start===anchor.from&&!edit.insert.includes('\n'))){anchor.from+=delta;anchor.to+=delta;}
   else if(start>=anchor.to)continue;
   else{anchor.locked=true;if(start<=anchor.from&&a>=anchor.to){anchor.deleted=true;continue;}anchor.from=Math.min(anchor.from,start);anchor.to=Math.max(anchor.from,anchor.to+delta);}
  }
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
 if(meeting.noteSnapshot!==undefined)rebaseAnchors(meeting,meeting.noteSnapshot,next);
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
 const showSpeaker=meeting.transcriptMode!=='text-only';
 const old=meeting.rendered[segment.id];let anchor=meeting.anchors[segment.id];
 if(!anchor&&old!==undefined){const plain=legacyLine(old);const pos=note.indexOf(plain);if(pos<0||note.indexOf(plain,pos+plain.length)>=0)return note;anchor=meeting.anchors[segment.id]={from:pos,to:pos+plain.length};meeting.rendered[segment.id]=plain;}
 const index=meeting.segments.findIndex(s=>s.id===segment.id),previous=index>0?meeting.segments[index-1]:undefined;
 const previousAnchor=previous?meeting.anchors[previous.id]:undefined;
 const continuous=!!previous&&previous.speaker===segment.speaker&&(!showSpeaker||segment.speaker!=='unknown'&&segment.speaker!=='overlap')&&segment.start>=previous.start&&segment.start-previous.end<(meeting.paragraphPauseMs??2500);
 const canLink=continuous&&!!previousAnchor&&!previousAnchor.deleted;
 const body=()=>clean(segment.text);
 const replace=(from:number,to:number,gap:string,content:string,continuation:boolean)=>{
  const delta=gap.length+content.length-(to-from);
  for(const [id,other] of Object.entries(meeting.anchors!))if(id!==segment.id&&!other.deleted&&other.from>=to){other.from+=delta;other.to+=delta;}
  anchor??={from:0,to:0};anchor.from=from+gap.length;anchor.to=anchor.from+content.length;anchor.continuation=continuation;anchor.speakerShown=showSpeaker&&!continuation;
  meeting.anchors![segment.id]=anchor;meeting.rendered[segment.id]=content;
  const result=note.slice(0,from)+gap+content+note.slice(to);meeting.noteSnapshot=result;return result;
 };
 if(!anchor){
  // Join only the exact untouched separator produced by this plugin. User notes stay separate.
  if(canLink&&!previousAnchor!.locked&&note.slice(previousAnchor!.to)==='\n\n')return replace(previousAnchor!.to,previousAnchor!.to,' ',body(),true);
  const prefix=note.length?(note.endsWith('\n\n')?'':note.endsWith('\n')?'\n':'\n\n'):'';
  const result=replace(note.length,note.length,prefix,segmentText(segment,meeting.speakers,showTime,showSpeaker),false)+'\n\n';meeting.noteSnapshot=result;return result;
 }
 if(anchor.deleted)return note;
 const current=note.slice(anchor.from,anchor.to),wasInline=!!anchor.continuation;
 if(current!==meeting.rendered[segment.id])anchor.locked=true;
 if(anchor.locked&&(mode==='normal'||current.includes('\n')))return note;
 const gap=previousAnchor&&!previousAnchor.deleted?note.slice(previousAnchor.to,anchor.from):undefined;
 const inline=!!canLink&&(wasInline||(!anchor.locked&&!previousAnchor!.locked&&gap==='\n\n'));
 let next=inline?body():segmentText(segment,meeting.speakers,showTime,showSpeaker);
 const previouslyShown=anchor.speakerShown!==false;
 if(anchor.locked){
  next=current.replace(/^\(\d\d:\d\d:\d\d\) /,'');
  if(showSpeaker&&!inline&&!previouslyShown)next=speakerName(segment,meeting.speakers)+': '+next;
  else if(showSpeaker&&wasInline&&!inline)next=speakerName(segment,meeting.speakers)+': '+next;
  else if(showSpeaker&&mode==='speaker'&&!wasInline){const previousName=(old??'').replace(/^\(\d\d:\d\d:\d\d\) /,'').split(': ')[0];if(previousName&&next.startsWith(previousName+': '))next=speakerName(segment,meeting.speakers)+next.slice(previousName.length);}
  if(showTime&&!inline)next=`(${timestamp(segment.start)}) `+next;
 }
 if(inline&&!wasInline)return replace(previousAnchor!.to,anchor.to,' ',next,true);
 if(!inline&&wasInline&&(gap===' '||gap===''))return replace(previousAnchor!.to,anchor.to,'\n\n',next,false);
 return replace(anchor.from,anchor.to,'',next,inline);
}
export type WorkerEvent=SpeakerRefinement|{type:'ready'|'stopped';session:string}|{type:'hello';session:string;protocol:number;features:string[]}|{type:'config_applied';session:string;revision:string;afterSample:number}|{type:'status';pending:number;lag:number;state:string;diagnostics?:Record<string,unknown>;pendingAudioSeconds?:number;oldestUnprocessedAge?:number;captureCommittedSample?:number;transcriptCommittedSample?:number}|{type:'segment';session?:string;segment:Segment}|{type:'error';message:string;fatal?:boolean};
export function parseEvent(line:string):WorkerEvent {
 const x:unknown=JSON.parse(line);if(!x||typeof x!=='object'||!('type'in x))throw new Error('잘못된 워커 메시지');const e=x as Record<string,unknown>;
 if(e.type==='segment'){const s=e.segment as Segment|undefined;if(!s||typeof s.id!=='string'||!/^[a-zA-Z0-9_-]+$/.test(s.id)||typeof s.text!=='string'||typeof s.speaker!=='string'||!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<s.start)throw new Error('잘못된 전사 구간');
  if(s.revision!==undefined&&(!Number.isSafeInteger(s.revision)||s.revision<1))throw new Error('잘못된 개정 번호');
  if(s.candidates!==undefined&&(!Array.isArray(s.candidates)||s.candidates.length>32||s.candidates.some(c=>typeof c.speaker!=='string'||!Number.isFinite(c.activity)||c.activity<0||c.activity>1||!Number.isFinite(c.activeSeconds)||c.activeSeconds<0)))throw new Error('잘못된 화자 후보');
  if(s.suggestions!==undefined&&(!Array.isArray(s.suggestions)||s.suggestions.some(c=>typeof c.id!=='string'||typeof c.before!=='string'||typeof c.after!=='string'||!Number.isInteger(c.start)||!Number.isInteger(c.end)||c.start<0||c.end<c.start||c.end>s.text.length||!['suggested','applied','dismissed'].includes(c.state))))throw new Error('잘못된 용어 교정');
 }
 else if(e.type==='speaker_refinement'){
  const r=e as unknown as SpeakerRefinement;
  if(typeof r.session!=='string'||typeof r.passId!=='string'||!/^[a-f0-9]{64}$/.test(r.passId)||!['v3-offline','community-1-mps'].includes(r.preset)||!Number.isInteger(r.detectedSpeakers)||r.detectedSpeakers<0||r.detectedSpeakers>32||!Number.isFinite(r.processingSeconds)||r.processingSeconds<0||!Array.isArray(r.turns)||r.turns.length>200000||r.turns.some(t=>!(/^offline_[1-8]$/.test(t.speaker)||/^community_\d{1,2}$/.test(t.speaker))||!Number.isFinite(t.start)||!Number.isFinite(t.end)||t.start<0||t.end<=t.start)||new Set(r.turns.map(t=>t.speaker)).size!==r.detectedSpeakers)throw new Error('잘못된 종료 후 화자 결과');
  if(r.alignments&&(typeof r.alignments!=='object'||Object.keys(r.alignments).length>50000||Object.values(r.alignments).some(a=>typeof a.text!=='string'||a.text.length>10000||!Array.isArray(a.words)||a.words.length>3000||a.words.some(w=>!Number.isSafeInteger(w.from)||!Number.isSafeInteger(w.to)||w.from<0||w.to<=w.from||w.to>a.text.length||!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.start<0||w.end<w.start))))throw new Error('잘못된 단어 정렬 결과');
 }
 else if(e.type==='error'){if(typeof e.message!=='string')throw new Error('잘못된 오류');}
 else if(e.type==='status'){if(typeof e.state!=='string'||!Number.isFinite(e.pending)||!Number.isFinite(e.lag))throw new Error('잘못된 상태');}
 else if(e.type==='hello'){if(typeof e.session!=='string'||e.protocol!==2||!Array.isArray(e.features))throw new Error('지원하지 않는 워커 프로토콜');}
 else if(e.type==='config_applied'){if(typeof e.session!=='string'||typeof e.revision!=='string'||!Number.isSafeInteger(e.afterSample))throw new Error('잘못된 사전 적용 응답');}
 else if(e.type!=='ready'&&e.type!=='stopped')throw new Error('알 수 없는 워커 메시지');return x as WorkerEvent;
}
