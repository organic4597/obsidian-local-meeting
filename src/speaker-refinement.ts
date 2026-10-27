import {Meeting,Segment,SpeakerRefinement,SpeakerTurn} from './model';

const known=(id:string)=>!['unknown','overlap'].includes(id);
/** Exclusive time is identity evidence; simultaneous activity never votes for one person. */
function evidence(turns:SpeakerTurn[],start:number,end:number){
 const relevant=turns.filter(t=>t.start<end&&t.end>start),points=[...new Set([start,end,...relevant.flatMap(t=>[Math.max(start,t.start),Math.min(end,t.end)])])].sort((a,b)=>a-b);
 const single=new Map<string,number>();let speech=0,overlap=0;
 for(let i=1;i<points.length;i++){const a=points[i-1]!,b=points[i]!,ids=[...new Set(relevant.filter(t=>t.start<b&&t.end>a).map(t=>t.speaker))];if(!ids.length)continue;speech+=b-a;if(ids.length>1)overlap+=b-a;else single.set(ids[0]!, (single.get(ids[0]!)??0)+b-a);}
 return {single,speech,overlap};
}
/** At most eight clusters: exact one-to-one temporal matching by subset DP. */
function align(weights:number[][]){
 let states=new Map<number,{score:number;pairs:[number,number][]}>([[0,{score:0,pairs:[]}]]);
 for(let i=0;i<weights.length;i++){
  const next=new Map(states);
  for(const [mask,state] of states)for(let j=0;j<weights[i]!.length;j++)if(!(mask&(1<<j))&&weights[i]![j]!>0){const key=mask|(1<<j),score=state.score+weights[i]![j]!;if(score>(next.get(key)?.score??-1))next.set(key,{score,pairs:[...state.pairs,[i,j]]});}
  states=next;
 }
 return [...states.values()].sort((a,b)=>b.score-a.score)[0]!.pairs;
}
export function refineSpeakers(meeting:Meeting,pass:SpeakerRefinement,expected=0){
 if(meeting.speakerPassId===pass.passId)return [];
 const clusters=[...new Set(pass.turns.map(t=>t.speaker))].sort(),old=[...new Set(meeting.segments.map(s=>s.speaker).filter(known))].sort((a,b)=>meeting.segments.filter(s=>s.speaker===b).reduce((n,s)=>n+(s.end-s.start)*(s.speakerLocked?10:1),0)-meeting.segments.filter(s=>s.speaker===a).reduce((n,s)=>n+(s.end-s.start)*(s.speakerLocked?10:1),0)).slice(0,8);
 const spans=new Map(meeting.segments.map(s=>[s.id,evidence(pass.turns,s.start,s.end)]));
 // A user-assigned speaker is a strong anchor, but an edited paragraph is kept intact below.
 const weights=clusters.map(c=>old.map(id=>meeting.segments.filter(s=>s.speaker===id).reduce((sum,s)=>sum+(spans.get(s.id)!.single.get(c)??0)*(s.speakerLocked?10:1),0)));
 const conflicts=new Set(clusters.filter(c=>new Set(meeting.segments.filter(s=>s.speakerLocked&&known(s.speaker)&&(spans.get(s.id)!.single.get(c)??0)>=200).map(s=>s.speaker)).size>1));
 const mapping=new Map<string,string>();
 for(const [i,j] of align(weights)){
  const row=weights[i]!,total=row.reduce((a,b)=>a+b,0);
  if(total&&row[j]!/total>=.65)mapping.set(clusters[i]!,old[j]!);
 }
 for(const c of clusters)if(!mapping.has(c)){
  // A split cluster must get its own slot instead of inheriting the same old name twice.
  const id=`final_${pass.passId.slice(0,8)}_${c}`;mapping.set(c,id);meeting.speakers[id]??=`새 화자 ${clusters.indexOf(c)+1}`;
 }
 const changed:string[]=[];
 for(const s of meeting.segments){
  const anchor=meeting.anchors?.[s.id];
  if(s.speakerLocked||anchor?.locked||anchor?.deleted)continue;
  const e=spans.get(s.id)!,best=[...e.single].sort((a,b)=>b[1]-a[1])[0];
  const speaker=e.overlap>=200?'overlap':best&&!conflicts.has(best[0])&&best[1]/Math.max(1,e.speech)>=.85?mapping.get(best[0])!:'unknown';
  const reasons=(s.reviewReasons??[]).filter(x=>!['화자 활동 근거 부족','화자 전환 경계 확인 필요','동시 활성 발언 확인 필요'].includes(x));
  if(speaker==='unknown')reasons.push('종료 후 화자 경계 확인 필요');
  if(speaker==='overlap')reasons.push('종료 후 동시 발언 확인 필요');
  if(speaker.startsWith('final_'))reasons.push('새로 분리된 화자 이름 확인 필요');
  if(best&&conflicts.has(best[0]))reasons.push('사용자 지정 화자가 하나로 합쳐진 구간 확인 필요');
  if(s.speaker!==speaker)s.reviewedRevision=undefined;
  s.speaker=speaker;s.speakerState=speaker==='overlap'?'overlap':speaker==='unknown'?'unknown':'single';
  s.reviewReasons=[...new Set(reasons)];s.candidates=[...e.single].sort((a,b)=>b[1]-a[1]).map(([c,ms])=>({speaker:mapping.get(c)!,activity:ms/Math.max(1,e.speech),activeSeconds:ms/1000}));
  // No text, timings, segment IDs, revisions, edits, or review history are rewritten.
  changed.push(s.id);
 }
 const warning=expected>pass.detectedSpeakers?`예상 ${expected}명 중 ${pass.detectedSpeakers}개 화자만 검출했습니다. 서로 다른 사람이 합쳐졌을 수 있습니다. 원음을 확인해 새 참여자로 직접 지정하세요.`:'';
 meeting.speakerPassId=pass.passId;meeting.speakerRefinement={detected:pass.detectedSpeakers,expected,warning,processingSeconds:pass.processingSeconds};
 return changed;
}
