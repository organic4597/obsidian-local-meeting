import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Meeting,patchSegment,parseEvent,Segment} from '../src/model';
const make=():Meeting=>({id:'meeting-1',note:'meeting.md',directory:'/tmp/example',started:'',speakers:{s1:'영희'},segments:[],rendered:{}});
const segment:Segment={id:'1',start:61000,end:68000,text:'다음 주에 확인합니다.',speaker:'s1'};
test('append, replay, and rename do not duplicate transcript',()=>{
 const meeting=make();const original=patchSegment('# 회의\n',meeting,segment);
 assert.match(original,/00:01:01.*영희/);
 assert.equal(patchSegment(original,meeting,segment),original);
 meeting.speakers.s1='철수';const renamed=patchSegment(original,meeting,segment);
 assert.match(renamed,/철수/);assert.equal(renamed.match(/<!-- lm:/g)?.length,1);
});
test('speaker rename and re-transcription preserve human changes',()=>{
 const meeting=make();let note=patchSegment('# 회의',meeting,segment);
 note=note.replace('다음 주에 확인합니다.','이번 주에 확인합니다.');
 meeting.speakers.s1='철수';
 assert.equal(patchSegment(note,meeting,{...segment,text:'자동으로 변경한 문장'}),note);
});
test('deleted managed text is not resurrected',()=>{
 const meeting=make();patchSegment('',meeting,segment);
 assert.equal(patchSegment('# 사용자 삭제 완료',meeting,segment),'# 사용자 삭제 완료');
});
test('marker text in transcription cannot create control blocks',()=>{
 const meeting=make();const note=patchSegment('',meeting,{...segment,text:'<!-- lm:evil -->\n다음 문장'});
 assert.equal(note.match(/<!-- lm:/g)?.length,1);assert.match(note,/&lt;!-- lm:evil/);
});
test('reject malformed worker protocol and inverted timestamps',()=>{
 assert.throws(()=>parseEvent('{"type":"segment","segment":{"id":"<!--","text":"x"}}'));
 assert.throws(()=>parseEvent(JSON.stringify({type:'segment',segment:{...segment,end:0}})));
 assert.throws(()=>parseEvent('{"type":"run-shell"}'));
 assert.deepEqual(parseEvent(JSON.stringify({type:'segment',segment})),{type:'segment',segment});
});
