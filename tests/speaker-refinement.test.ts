import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Meeting,Segment,SpeakerRefinement,parseEvent,patchSegment,rebaseAnchors} from '../src/model';
import {refineSpeakers} from '../src/speaker-refinement';
import {transcriptChanges} from '../src/editor-changes';
const s=(id:string,start:number,end:number,speaker='speaker_1'):Segment=>({id,start,end,speaker,text:`${id} 대사`,revision:1,textState:'stable'});
const m=(segments:Segment[]):Meeting=>({id:'session',note:'a.md',directory:'/tmp/a',started:'',segments,speakers:{speaker_1:'기존 이름'},rendered:{}});
const pass=(turns:SpeakerRefinement['turns']):SpeakerRefinement=>({type:'speaker_refinement',session:'session',passId:'a'.repeat(64),preset:'v3-offline',turns,detectedSpeakers:new Set(turns.map(t=>t.speaker)).size,processingSeconds:1});
test('an additional offline cluster cannot inherit the same existing name',()=>{
 const meeting=m([s('a',0,6000),s('b',6000,10000)]),event=pass([{start:0,end:6000,speaker:'offline_1'},{start:6000,end:10000,speaker:'offline_2'}]);
 const before=meeting.segments.map(x=>({...x}));refineSpeakers(meeting,event,7);
 assert.equal(meeting.segments[0]!.speaker,'speaker_1');assert.notEqual(meeting.segments[1]!.speaker,'speaker_1');assert.match(meeting.segments[1]!.speaker,/^candidate_/);assert.equal(meeting.segments[1]!.speakerState,'unknown');assert.equal(meeting.speakers[meeting.segments[1]!.speaker],'화자 1');assert.equal(Object.keys(meeting.speakers).length,2);assert.equal(Object.keys(meeting.speakerCandidates??{}).length,1);assert.equal(meeting.speakers.speaker_1,'기존 이름');
 meeting.segments.forEach((x,i)=>{assert.equal(x.text,before[i]!.text);assert.equal(x.start,before[i]!.start);assert.equal(x.end,before[i]!.end);assert.equal(x.revision,1);});
 assert.match(meeting.speakerRefinement!.warning,/예상 7명 중 2개/);assert.deepEqual(refineSpeakers(meeting,event,7),[]);
});
test('manual assignment, typed body, typed name, deletion and review history survive a whole pass',()=>{
 const meeting=m([s('a',0,2000),{...s('b',2000,4000,'manual_person'),speakerLocked:true,textLocked:true},s('c',4000,6000),s('d',6000,8000)]);
 let doc='';for(const segment of meeting.segments)doc=patchSegment(doc,meeting,segment);
 const typed=doc.replace('기존 이름: a 대사','내가 쓴 이름: 직접 쓴 내용').replace('c 대사','직접 고친 문장');rebaseAnchors(meeting,doc,typed);
 meeting.anchors!.d!.deleted=true;
 const event=pass([{start:0,end:8000,speaker:'offline_7'}]);const ids=refineSpeakers(meeting,event);
 assert.deepEqual(ids,[]);assert.equal(transcriptChanges(typed,meeting,ids,false,'speaker').text,typed);assert.equal(meeting.segments[1]!.speaker,'manual_person');
});
test('conflicting user identities remain separate and uncertain shared cluster is reviewed',()=>{
 const meeting=m([{...s('a',0,2000,'person_A'),speakerLocked:true},{...s('b',2000,4000,'person_B'),speakerLocked:true},s('c',4000,6000)]);
 refineSpeakers(meeting,pass([{start:0,end:6000,speaker:'offline_1'}]));assert.equal(meeting.segments[0]!.speaker,'person_A');assert.equal(meeting.segments[1]!.speaker,'person_B');assert.equal(meeting.segments[2]!.speaker,'unknown');assert.match(meeting.segments[2]!.reviewReasons!.join(' '),/하나로 합쳐진/);
});
test('a phrase containing multiple sequential speakers is left unknown without inventing word times',()=>{
 const meeting=m([s('a',0,4000)]);refineSpeakers(meeting,pass([{start:0,end:2000,speaker:'offline_1'},{start:2000,end:4000,speaker:'offline_2'}]));assert.equal(meeting.segments[0]!.speaker,'unknown');assert.equal(meeting.segments[0]!.text,'a 대사');
});
test('all seven distinct clusters can appear, and invalid worker output is rejected',()=>{
 const meeting=m(Array.from({length:7},(_,i)=>s(String(i),i*3000,(i+1)*3000,`speaker_${i+1}`)));
 const event=pass(meeting.segments.map((x,i)=>({start:x.start,end:x.end,speaker:`offline_${7-i}`})));
 assert.equal(parseEvent(JSON.stringify(event)).type,'speaker_refinement');refineSpeakers(meeting,event,7);assert.equal(new Set(meeting.segments.map(x=>x.speaker)).size,7);assert.equal(meeting.speakerRefinement!.warning,'');
 assert.throws(()=>parseEvent(JSON.stringify({...event,detectedSpeakers:9})));assert.throws(()=>parseEvent(JSON.stringify({...event,turns:[{start:0,end:10,speaker:'offline_9'}]})));
});
test('timestamps appear only at paragraph heads and return after a speaker split',()=>{
 const meeting=m([s('a',0,2000),s('b',2000,4000)]);let doc=transcriptChanges('',meeting,['a','b'],true).text;assert.equal((doc.match(/\(00:/g)||[]).length,1);
 meeting.segments[1]!.speaker='speaker_2';doc=transcriptChanges(doc,meeting,['b'],true,'speaker').text;assert.equal((doc.match(/\(00:/g)||[]).length,2);assert.match(doc,/\n\n\(00:00:02\) 화자 2:/);
});
