import {Meeting,Segment} from './model';

export function needsReview(s:Segment){return (s.reviewedRevision??-1)<(s.revision??0)&&!!(s.reviewReasons?.length||s.speaker==='unknown'||s.speaker==='overlap'||s.suggestions?.some(c=>c.state==='suggested'));}

export function acceptRevision(meeting:Meeting,incoming:Segment):{segment:Segment;mode:'normal'|'speaker'}|null {
 const previous=meeting.segments.find(s=>s.id===incoming.id);
 if(previous&&incoming.revision!==undefined&&(previous.revision??0)>=incoming.revision)return null;
 const anchor=meeting.anchors?.[incoming.id];
 const segment:Segment={...incoming};
 if(previous){
  segment.userRevision=previous.userRevision;segment.history=previous.history;segment.reviewedRevision=previous.reviewedRevision;
  if(previous.textLocked||anchor?.locked||anchor?.deleted){segment.text=previous.text;segment.textLocked=true;segment.suggestions=previous.suggestions;}
  if(previous.speakerLocked||(incoming.revision===undefined&&incoming.speaker==='unknown'&&previous.speaker!=='unknown')){
   segment.speaker=previous.speaker;segment.speakerLocked=true;segment.speakerState='manual';
  }
 }
 return {segment,mode:previous&&previous.speaker!==segment.speaker&&(anchor?.locked||previous.textLocked)?'speaker':'normal'};
}

export function reviewEdit(s:Segment,expectedRevision:number,expectedText:string,text:string,speaker:string){
 if((s.revision??0)!==expectedRevision||s.text!==expectedText)throw new Error('발언이 변경되었습니다. 최신 내용을 다시 확인해 주세요.');
 if(!text.trim()||text.length>10000||/[\r\n]/.test(text))throw new Error('발언은 1~10,000자의 한 문단으로 입력해 주세요.');
 const before={text:s.text,speaker:s.speaker,textLocked:s.textLocked,speakerLocked:s.speakerLocked,speakerState:s.speakerState,suggestions:structuredClone(s.suggestions),reviewedRevision:s.reviewedRevision};
 const userRevision=(s.userRevision??0)+1;
 s.history=[...(s.history??[]),{at:new Date().toISOString(),before,afterText:text,afterSpeaker:speaker,userRevision}];
 s.text=text;s.speaker=speaker;s.textLocked=true;s.speakerLocked=true;s.speakerState='manual';s.userRevision=userRevision;s.reviewedRevision=s.revision??0;
 s.suggestions=s.suggestions?.map(c=>({...c,state:'dismissed'}));
}

export function undoReview(s:Segment){
 const h=s.history?.at(-1);if(!h)throw new Error('되돌릴 교정이 없습니다.');
 if(s.text!==h.afterText||s.speaker!==h.afterSpeaker)throw new Error('교정 후 내용이 바뀌어 자동으로 되돌릴 수 없습니다.');
 Object.assign(s,h.before);s.history=s.history!.slice(0,-1);s.userRevision=(s.userRevision??0)+1;
}
