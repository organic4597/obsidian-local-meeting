import {isUnconfirmedSpeaker} from './meeting-presentation';
import {Meeting,Segment,SpeakerRefinement,SpeakerTurn} from './model';

const known=(id:string)=>!['unknown','overlap','pending'].includes(id);
/** Exclusive time is identity evidence; simultaneous activity never votes for one person. */
function evidence(turns:SpeakerTurn[],start:number,end:number){
 const relevant=turns.filter(t=>t.start<end&&t.end>start),points=[...new Set([start,end,...relevant.flatMap(t=>[Math.max(start,t.start),Math.min(end,t.end)])])].sort((a,b)=>a-b);
 const single=new Map<string,number>();let speech=0,overlap=0;
 for(let i=1;i<points.length;i++){const a=points[i-1]!,b=points[i]!,ids=[...new Set(relevant.filter(t=>t.start<b&&t.end>a).map(t=>t.speaker))];if(!ids.length)continue;speech+=b-a;if(ids.length>1)overlap+=b-a;else single.set(ids[0]!, (single.get(ids[0]!)??0)+b-a);}
 return {single,speech,overlap};
}
/** Maximum-weight one-to-one assignment, Hungarian algorithm; supports up to 32 clusters. */
function align(weights:number[][]){
 const rows=weights.length,cols=weights[0]?.length??0,n=Math.max(rows,cols);if(!n||!cols)return [] as [number,number][];
 const u=Array(n+1).fill(0),v=Array(n+1).fill(0),p=Array(n+1).fill(0),way=Array(n+1).fill(0);
 for(let i=1;i<=n;i++){p[0]=i;let j0=0;const minv=Array(n+1).fill(Infinity),used=Array(n+1).fill(false);
  do{used[j0]=true;const i0=p[j0];let delta=Infinity,j1=0;for(let j=1;j<=n;j++)if(!used[j]){const cost=-(weights[i0-1]?.[j-1]??0)-u[i0]-v[j];if(cost<minv[j]){minv[j]=cost;way[j]=j0;}if(minv[j]<delta){delta=minv[j];j1=j;}}
   for(let j=0;j<=n;j++)if(used[j]){u[p[j]]+=delta;v[j]-=delta;}else minv[j]-=delta;j0=j1;
  }while(p[j0]!==0);
  do{const j1=way[j0];p[j0]=p[j1];j0=j1;}while(j0);
 }
 const pairs:[number,number][]=[];for(let j=1;j<=n;j++)if(p[j]<=rows&&j<=cols&&(weights[p[j]-1]?.[j-1]??0)>0)pairs.push([p[j]-1,j-1]);return pairs;
}
export function refineSpeakers(meeting:Meeting,pass:SpeakerRefinement,expected=0){
 if(meeting.speakerPassId===pass.passId)return [];
 delete meeting.voiceAutoAssignments;
 const clusters=[...new Set(pass.turns.map(t=>t.speaker))].sort(),old=[...new Set(meeting.segments.map(s=>s.speaker).filter(id=>known(id)&&!isUnconfirmedSpeaker(meeting,id)))].sort((a,b)=>meeting.segments.filter(s=>s.speaker===b).reduce((n,s)=>n+(s.end-s.start)*(s.speakerLocked?10:1),0)-meeting.segments.filter(s=>s.speaker===a).reduce((n,s)=>n+(s.end-s.start)*(s.speakerLocked?10:1),0)).slice(0,32);
 const spans=new Map(meeting.segments.map(s=>[s.id,evidence(pass.turns,s.start,s.end)]));
 // A user-assigned speaker is a strong anchor, but an edited paragraph is kept intact below.
 const weights=clusters.map(c=>old.map(id=>meeting.segments.filter(s=>s.speaker===id).reduce((sum,s)=>sum+(spans.get(s.id)!.single.get(c)??0)*(s.speakerLocked?10:1),0)));
 const conflicts=new Set(clusters.filter(c=>new Set(meeting.segments.filter(s=>s.speakerLocked&&known(s.speaker)&&(spans.get(s.id)!.single.get(c)??0)>=200).map(s=>s.speaker)).size>1));
 const mapping=new Map<string,string>();
 for(const [i,j] of align(weights)){
  const row=weights[i]!,total=row.reduce((a,b)=>a+b,0);
  if(total&&row[j]!/total>=.65)mapping.set(clusters[i]!,old[j]!);
 }
 const hasPeople=Object.keys(meeting.speakers).some(id=>!isUnconfirmedSpeaker(meeting,id));
 for(const c of clusters)if(!mapping.has(c)){
  // A split cluster must get its own slot instead of inheriting the same old name twice.
  const id=hasPeople?`candidate_${pass.passId.slice(0,16)}_${c}`:`auto_${c}`;mapping.set(c,id);
  if(hasPeople){meeting.speakerCandidates??={};meeting.speakerCandidates[id]={label:`미확정 음성 그룹 ${clusters.indexOf(c)+1}`,passId:pass.passId};}
  else meeting.speakers[id]??=`화자 ${clusters.indexOf(c)+1}`;
 }
 meeting.speakerClusters=Object.fromEntries(mapping);meeting.speakerClusterConflicts=[...conflicts];
 const changed:string[]=[];
 for(const s of meeting.segments){
  const anchor=meeting.anchors?.[s.id];
  if(s.speakerLocked||anchor?.locked&&anchor.speakerShown!==false||anchor?.deleted)continue;
  const e=spans.get(s.id)!,best=[...e.single].sort((a,b)=>b[1]-a[1])[0];
  const match=best?mapping.get(best[0]):undefined;
  const speaker=e.overlap>=200?'overlap':best&&!conflicts.has(best[0])&&best[1]/Math.max(1,e.speech)>=.85?match?.startsWith('candidate_')?'unknown':match!:'unknown';
  const reasons=(s.reviewReasons??[]).filter(x=>!['화자 활동 근거 부족','화자 전환 경계 확인 필요','동시 활성 발언 확인 필요'].includes(x));
  if(speaker==='unknown')reasons.push('종료 후 화자 경계 확인 필요');
  if(speaker==='overlap')reasons.push('종료 후 동시 발언 확인 필요');
  if(match?.startsWith('candidate_'))reasons.push('미확정 음성 그룹 연결 가능');
  if(best&&conflicts.has(best[0]))reasons.push('사용자 지정 화자가 하나로 합쳐진 구간 확인 필요');
  if(s.speaker!==speaker)s.reviewedRevision=undefined;
  s.speaker=speaker;s.speakerState=speaker==='overlap'?'overlap':speaker==='unknown'?'unknown':'single';
  s.reviewReasons=[...new Set(reasons)];s.candidates=[...e.single].sort((a,b)=>b[1]-a[1]).map(([c,ms])=>({speaker:mapping.get(c)!,activity:ms/Math.max(1,e.speech),activeSeconds:ms/1000}));
  // No text, timings, segment IDs, revisions, edits, or review history are rewritten.
  changed.push(s.id);
 }
 const warning=expected>pass.detectedSpeakers?`예상 ${expected}명 중 ${pass.detectedSpeakers}개 화자만 검출했습니다. 서로 다른 사람이 합쳐졌을 수 있습니다. 원음을 확인해 새 참여자로 직접 지정하세요.`:'';
 meeting.transcriptMode='dialogue';meeting.speakerPassId=pass.passId;meeting.speakerRefinement={detected:pass.detectedSpeakers,expected,warning,processingSeconds:pass.processingSeconds};
 return changed;
}
