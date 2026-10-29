import {Meeting,Segment} from './model';
import {needsReview,undoReview} from './quality-model';
export function isUnconfirmedSpeaker(m:Meeting,id:string){return !!m.speakerCandidates?.[id]||id.startsWith('final_')&&/^새 화자 \d+$/.test(m.speakers[id]??'')&&!m.segments.some(s=>s.speaker===id&&s.speakerLocked);}
export function participantIds(m:Meeting){return [...new Set([...m.segments.map(s=>s.speaker),...Object.keys(m.speakers)])].filter(id=>!['unknown','overlap','pending'].includes(id));}
export function candidateGroups(m:Meeting){const ids=new Set([...Object.keys(m.speakerCandidates??{}),...Object.keys(m.speakers).filter(id=>isUnconfirmedSpeaker(m,id))]);return [...ids].map(id=>({id,label:m.speakerCandidates?.[id]?.label??'미확정 음성 그룹',segments:m.segments.filter(s=>s.speaker===id||s.speaker==='unknown'&&s.candidates?.some(c=>c.speaker===id&&c.activity>=.85))})).filter(c=>c.segments.length);}
export function reviewGroups(m:Meeting){const groups=new Map<string,{key:string;label:string;segments:Segment[]}>();for(const s of m.segments){if(m.anchors?.[s.id]?.deleted||!needsReview(s))continue;
 const candidate=isUnconfirmedSpeaker(m,s.speaker)?s.speaker:s.candidates?.find(c=>m.speakerCandidates?.[c.speaker]&&c.activity>=.85)?.speaker;
 const key=s.suggestions?.some(c=>c.state==='suggested')?'terms':s.textState==='review_required'?'text':candidate?'candidate:'+candidate:s.speaker==='overlap'?'overlap':s.reviewReasons?.some(x=>x.includes('사용자 지정'))?'identity-conflict':s.speaker==='unknown'?'unknown':'other';
 const label=key==='terms'?'용어 교정':key==='text'?'전사 확인':key==='overlap'?'겹친 발언':key==='identity-conflict'?'화자 지정 충돌':key.startsWith('candidate:')?'참여자 연결':key==='unknown'?'화자 미확정':'발언 확인';
 if(!groups.has(key))groups.set(key,{key,label,segments:[]});groups.get(key)!.segments.push(s);
 }return [...groups.values()];}
export function compactStatus(state:string,active:boolean,stopping:boolean,ai:boolean,error:string,hasTranscript:boolean){return error?'오류':ai?'AI 정리':active?(stopping?'정리 중':state.includes('로딩')?'준비 중':'녹음 중'):hasTranscript?'완료':'준비';}

/** Upgrade only confidently associated old candidate groups; ambiguous or edited segments remain untouched. */
export function numberCandidateGroups(m:Meeting):string[]{
 const used=new Set(Object.values(m.speakers)),changed:string[]=[];
 for(const [id,candidate] of Object.entries(m.speakerCandidates??{})){
  if(Object.entries(m.speakerClusters??{}).some(([cluster,local])=>local===id&&m.speakerClusterConflicts?.includes(cluster)))continue;
  const segments=m.segments.filter(s=>s.speaker===id||s.speaker==='unknown'&&!s.speakerLocked&&!m.anchors?.[s.id]?.locked&&!m.anchors?.[s.id]?.deleted&&s.candidates?.some(c=>c.speaker===id&&c.activity>=.85));
  if(!segments.length)continue;
  let label=m.speakers[id];if(!label){let n=1;while(used.has(`화자 ${n}`))n++;label=`화자 ${n}`;m.speakers[id]=label;used.add(label);}candidate.label=label;
  for(const segment of segments){if(segment.speaker===id)continue;segment.speaker=id;segment.speakerState='unknown';changed.push(segment.id);}
 }
 return changed;
}

/** Explicit removal preserves spoken text, while assigning its owner deliberately. */
export function removeParticipant(m:Meeting,id:string,target:string):string[]{
 if(!participantIds(m).includes(id)||id===target||target!=='unknown'&&!participantIds(m).includes(target))throw new Error('참여자를 다시 선택해 주세요.');
 const affected=m.segments.filter(s=>s.speaker===id);if(affected.some(s=>m.anchors?.[s.id]?.locked||m.anchors?.[s.id]?.deleted))throw new Error('직접 수정하거나 삭제한 발언이 있습니다. 해당 발언을 먼저 확인해 주세요.');
 for(const s of affected){s.history=[...(s.history??[]),{at:new Date().toISOString(),before:{text:s.text,speaker:s.speaker,textLocked:s.textLocked,speakerLocked:s.speakerLocked,speakerState:s.speakerState,suggestions:structuredClone(s.suggestions),reviewedRevision:s.reviewedRevision},afterText:s.text,afterSpeaker:target,userRevision:(s.userRevision??0)+1,speakerNameBefore:m.speakers[id]}];s.userRevision=(s.userRevision??0)+1;s.speaker=target;s.speakerLocked=true;s.speakerState=target==='unknown'?'unknown':'manual';}
 for(const s of m.segments)if(s.candidates)s.candidates=s.candidates.filter(c=>c.speaker!==id);
 for(const [cluster,local] of Object.entries(m.speakerClusters??{}))if(local===id){delete m.speakerClusters![cluster];delete m.voiceAutoAssignments?.[cluster];m.speakerClusterConflicts=[...new Set([...(m.speakerClusterConflicts??[]),cluster])];}
 delete m.speakers[id];delete m.speakerCandidates?.[id];m.voiceConfirmedSpeakers=(m.voiceConfirmedSpeakers??[]).filter(x=>x!==id);return affected.map(s=>s.id);
}

/** Only undo an unchanged most-recent group deletion; never infer an identity. */
export function restoreDeletedGroups(m:Meeting):string[]{
 const changed:string[]=[];for(const s of m.segments){const h=s.history?.at(-1),id=h?.before.speaker,label=h?.speakerNameBefore;if(!h||!id||!/^candidate_[a-f0-9]{16}_community_\d{1,2}$/.test(id)||!label||h.afterSpeaker!=='unknown'||s.speaker!=='unknown'||s.text!==h.afterText||s.userRevision!==h.userRevision||m.anchors?.[s.id]?.locked||m.anchors?.[s.id]?.deleted)continue;
  const match=id.match(/^candidate_([a-f0-9]{16})_(community_\d{1,2})$/)!;if(!m.speakerPassId?.startsWith(match[1]!))continue;const existing=m.speakers[id];if(existing&&existing!==label)continue;
  undoReview(s);m.speakers[id]=label;m.speakerCandidates??={};m.speakerCandidates[id]={label,passId:m.speakerPassId};m.speakerClusters??={};if(!m.speakerClusters[match[2]!])m.speakerClusters[match[2]!]=id;changed.push(s.id);
 }return changed;
}
