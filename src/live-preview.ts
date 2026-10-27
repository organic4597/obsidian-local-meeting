import {Meeting,SpeakerRefinement} from './model';
import {transcriptChanges} from './editor-changes';
import {splitAlignedSpeakers} from './aligned-speakers';
import {refineSpeakers} from './speaker-refinement';

/** Preview text never becomes a Markdown edit until explicitly committed. */
export function previewText(meeting:Meeting,showTime=false){
 const copy=structuredClone(meeting);copy.rendered={};copy.anchors={};copy.noteSnapshot='';
 return transcriptChanges('',copy,copy.segments.map(s=>s.id),showTime).text.trimEnd();
}
/** Align against a virtual transcript, without borrowing positions from the user's notes. */
export function refinePreview(meeting:Meeting,pass:SpeakerRefinement,expected=0){
 const copy=structuredClone(meeting);copy.rendered={};copy.anchors={};copy.noteSnapshot='';
 const doc=transcriptChanges('',copy,copy.segments.map(s=>s.id)).text;
 splitAlignedSpeakers(copy,pass,doc);refineSpeakers(copy,pass,expected);
 meeting.segments=copy.segments;meeting.speakers=copy.speakers;meeting.speakerCandidates=copy.speakerCandidates;meeting.originalSegments=copy.originalSegments;
 meeting.speakerPassId=copy.speakerPassId;meeting.speakerRefinement=copy.speakerRefinement;meeting.transcriptMode=copy.transcriptMode;
 meeting.presentation='committing';
}
const segmenter=new Intl.Segmenter('ko',{granularity:'grapheme'});
export function graphemes(text:string){return [...segmenter.segment(text)].map(s=>s.segment);}
/** Visual reveal only: no per-character document writes, model requests, or history entries. */
export class TextReveal {
 private units:string[]=[];private shown=0;private speed=90;private carry=0;private target='';
 constructor(private final=false){}
 set(text:string,final=this.final){
  if(text===this.target&&final===this.final)return;
  const next=graphemes(text);let common=0;
  if(final===this.final)while(common<Math.min(this.shown,next.length)&&this.units[common]===next[common])common++;
  this.units=next;this.shown=common;this.final=final;this.target=text;this.carry=0;
  this.speed=Math.max(final?65:90,(next.length-common)/(final?8:1.2));
 }
 step(ms:number){
  // Short updates feel typed; long backlogs catch up within 1.2 s (8 s for final text).
  this.carry+=this.speed*Math.max(0,ms)/1000;const count=Math.floor(this.carry);this.carry-=count;
  this.shown=Math.min(this.units.length,this.shown+count);
  return this.value;
 }
 finish(){this.shown=this.units.length;return this.value;}
 get value(){return this.units.slice(0,this.shown).join('');}
 get done(){return this.shown>=this.units.length;}
}

export function planPreviewCommit(meeting:Meeting,before:string,showTime=false){
 const copy=structuredClone(meeting);copy.rendered={};copy.anchors={};copy.noteSnapshot=before;
 const plan=transcriptChanges(before,copy,copy.segments.map(s=>s.id),showTime,'normal',true);
 return {before,after:plan.text,rendered:copy.rendered,anchors:copy.anchors!,changes:plan.changes};
}
/** Exact recovery never guesses whether an unrelated edit is a prior plugin write. */
export function recoverPreviewCommit(meeting:Meeting,doc:string){
 const pending=meeting.previewCommit;if(!pending)return 'pending' as const;
 if(doc===pending.after){meeting.rendered=pending.rendered;meeting.anchors=pending.anchors;meeting.noteSnapshot=doc;meeting.presentation='document';delete meeting.previewCommit;return 'committed' as const;}
 return doc===pending.before?'pending' as const:'ambiguous' as const;
}
