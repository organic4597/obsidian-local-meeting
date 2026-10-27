/** Read-only verification on copies of a saved meeting and its current note. */
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {Meeting,SpeakerRefinement,rebaseAnchors} from '../src/model';
import {refineSpeakers} from '../src/speaker-refinement';
import {transcriptChanges} from '../src/editor-changes';
const [meetingPath,notePath,passPath,output]=process.argv.slice(2);
if(!meetingPath||!notePath||!passPath||!output)throw new Error('meeting.json note.md speaker-refinement.json output.json');
const meeting=JSON.parse(readFileSync(meetingPath,'utf8')) as Meeting,doc=readFileSync(notePath,'utf8'),event=JSON.parse(readFileSync(passPath,'utf8')) as SpeakerRefinement;
if(meeting.noteSnapshot!==undefined)rebaseAnchors(meeting,meeting.noteSnapshot,doc);
const protectedText=Object.entries(meeting.anchors??{}).filter(([,a])=>a.locked&&!a.deleted).map(([id,a])=>({id,text:doc.slice(a.from,a.to)}));
const locked=meeting.segments.filter(s=>s.speakerLocked).map(s=>({id:s.id,speaker:s.speaker,text:s.text}));
const before=structuredClone(meeting.segments),names=structuredClone(meeting.speakers);
const ids=refineSpeakers(meeting,event,7),next=transcriptChanges(doc,meeting,ids,false,'speaker').text;
for(const p of protectedText)assert.ok(next.includes(p.text),`edited note range lost: ${p.id}`);
for(const p of locked){const s=meeting.segments.find(x=>x.id===p.id)!;assert.equal(s.speaker,p.speaker);assert.equal(s.text,p.text);}
for(const [id,name] of Object.entries(names))assert.equal(meeting.speakers[id],name);
meeting.segments.forEach((s,i)=>{assert.equal(s.text,before[i]!.text);assert.equal(s.start,before[i]!.start);assert.equal(s.end,before[i]!.end);assert.equal(s.id,before[i]!.id);});
const after=JSON.stringify(meeting);assert.deepEqual(refineSpeakers(meeting,event,7),[]);assert.equal(JSON.stringify(meeting),after);
writeFileSync(output,JSON.stringify({verified:true,readOnlySource:true,segments:meeting.segments.length,protectedNoteRanges:protectedText.length,manualSpeakerAssignments:locked.length,namesPreserved:Object.keys(names).length,appliedSegments:ids.length,refinement:meeting.speakerRefinement},null,2));
console.log(readFileSync(output,'utf8'));
