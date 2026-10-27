import {Meeting,SpeakerRefinement,Segment} from './model';
/** Split only untouched text at measured word boundaries; typed text remains one protected block. */
export function splitAlignedSpeakers(meeting:Meeting,pass:SpeakerRefinement,doc:string){
 if(meeting.transcriptMode!=='text-only'||!pass.alignments)return;
 const next:Segment[]=[];
 for(const s of meeting.segments){
  const anchor=meeting.anchors?.[s.id],a=pass.alignments[s.id];
  if(!anchor||anchor.locked||anchor.deleted||s.textLocked||s.speakerLocked||!a?.words.length||a.text!==s.text||doc.slice(anchor.from,anchor.to)!==meeting.rendered[s.id]){next.push(s);continue;}
  const prefix=(meeting.rendered[s.id]??'').match(/^\(\d\d:\d\d:\d\d\) /)?.[0]??'';
  if(doc.slice(anchor.from+prefix.length,anchor.to)!==s.text||a.words.some((w,i)=>i>0&&(w.from<a.words[i-1]!.to||w.start<a.words[i-1]!.start))){next.push(s);continue;}
  const groups:{speaker:string;from:number;start:number;end:number}[]=[];
  for(const w of a.words){const midpoint=(w.start+w.end)/2,ids=[...new Set(pass.turns.filter(t=>t.start<=midpoint&&t.end>midpoint).map(t=>t.speaker))],speaker=ids.length===1?ids[0]!:'unknown',last=groups.at(-1);
   if(last&&last.speaker===speaker)last.end=w.end;else groups.push({speaker,from:w.from,start:w.start,end:w.end});}
  if(groups.length<2){next.push(s);continue;}
  meeting.originalSegments??={};meeting.originalSegments[s.id]??=structuredClone(s);
  const original={...anchor};
  groups.forEach((g,i)=>{const from=i===0?0:g.from,to=groups[i+1]?.from??s.text.length,id=i===0?s.id:`${s.id}_w${i}`,segment={...s,id,text:s.text.slice(from,to),start:i===0?s.start:g.start,end:i===groups.length-1?s.end:Math.min(s.end,groups[i+1]!.start),speaker:'pending',rawText:undefined};
   next.push(segment);const begin=original.from+(i===0?0:prefix.length+from),end=original.from+prefix.length+to;
   meeting.anchors![id]={from:begin,to:end,continuation:i>0||original.continuation,speakerShown:false};meeting.rendered[id]=doc.slice(begin,end);
  });
 }
 meeting.segments=next;
}
