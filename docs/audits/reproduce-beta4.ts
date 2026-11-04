import {refineSpeakers} from '../../src/speaker-refinement.ts';
import {needsReview} from '../../src/quality-model.ts';
import {acceptRevision} from '../../src/quality-model.ts';
import {timedNotes} from '../../src/note-timing.ts';
import {previewText} from '../../src/live-preview.ts';
import {recordingPath} from '../../src/summary-playback.ts';
const base:any={id:'12345678-1234-1234-1234-123456789abc',note:'n.md',directory:'/old/session',started:'',segments:[],speakers:{},rendered:{},transcriptMode:'text-only',presentation:'ghost'};
const m=structuredClone(base);m.segments=[{id:'u_0',start:0,end:1000,speaker:'p',text:'사용자 교정',textLocked:true,textState:'provisional',revision:1}];
const v=acceptRevision(m,{id:'u_0',start:0,end:5000,speaker:'p',text:'처음 발언 그리고 이어진 새로운 발언',textState:'stable',revision:2});
console.log(JSON.stringify({probe:'partial_correction',displayed:v?.segment.text,rawEnd:v?.segment.end,finalState:v?.segment.textState}));
const n=structuredClone(base);n.noteTimingSnapshot='메모';n.noteTimings=[{id:'n',from:0,to:2,start:1000,end:1000,source:'capture-clock',uncertaintyMs:300,updated:'2026-11-03'}];
console.log(JSON.stringify({probe:'external_note_edit',document:'추가 내용\n메모',linkedText:timedNotes(n,'추가 내용\n메모')[0]?.text}));
console.log(JSON.stringify({probe:'storage_path',originalDirectory:m.directory,playbackAfterSettingChange:recordingPath('/new-storage',m.id)}));
for(const count of [100,1000,3000]){const p=structuredClone(base);p.segments=Array.from({length:count},(_,i)=>({id:'u_'+i,start:i*2000,end:i*2000+1500,speaker:'p',text:'회의 발언을 검토하고 다음 업무를 진행합니다.'}));const samples=[];for(let i=0;i<4;i++){const start=performance.now();previewText(p);samples.push(performance.now()-start);}console.log(JSON.stringify({probe:'preview_cost',segments:count,ms:samples.map(n=>Math.round(n*10)/10)}));}

const reviewMeeting:any={id:'m',note:'m',directory:'/',started:'',speakers:{live_1:'잠정 화자 1'},rendered:{},segments:[{id:'a',start:0,end:5000,text:'발언',speaker:'live_1',textState:'stable',revision:2,reviewReasons:['실시간 잠정 화자 · 종료 후 재분석']}],transcriptMode:'text-only'};
refineSpeakers(reviewMeeting,{type:'speaker_refinement',session:'m',passId:'f'.repeat(64),preset:'community-1-mps',turns:[{start:0,end:5000,speaker:'community_00'}],detectedSpeakers:1,processingSeconds:1});
console.log(JSON.stringify({probe:'stale_review_reason',speaker:reviewMeeting.segments[0].speaker,speakerState:reviewMeeting.segments[0].speakerState,reasons:reviewMeeting.segments[0].reviewReasons,needsReview:needsReview(reviewMeeting.segments[0])}));
