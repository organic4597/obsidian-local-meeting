import {ChangeSet,EditorState,Transaction} from '@codemirror/state';
import {Meeting,patchSegment} from './model';

export function textChange(before:string,after:string):{from:number;to:number;insert:string}|null {
 if(before===after)return null;
 let from=0;while(from<before.length&&from<after.length&&before[from]===after[from])from++;
 let to=before.length,end=after.length;while(to>from&&end>from&&before[to-1]===after[end-1]){to--;end--;}
 return {from,to,insert:after.slice(from,end)};
}
export function transcriptChanges(before:string,meeting:Meeting,ids:string[],showTime=false,mode:'normal'|'time'|'speaker'='normal',reserveWritingLine=false){
 let text=before,changes=ChangeSet.empty(before.length);
 const apply=(next:string)=>{const change=textChange(text,next);if(change)changes=changes.compose(ChangeSet.of(change,text.length));text=next;};
 // Keep a place to type before the first utterance in a completely empty editor.
 if(reserveWritingLine&&!text&&ids.some(id=>!meeting.anchors?.[id]))apply('\n\n');
 const affected=new Set(ids);
 for(let i=0;i<meeting.segments.length;i++)if(ids.includes(meeting.segments[i]!.id)&&meeting.segments[i+1])affected.add(meeting.segments[i+1]!.id);
 for(const segment of meeting.segments)if(affected.has(segment.id))apply(patchSegment(text,meeting,segment,showTime,mode));
 return {text,changes};
}
export function transcriptTransaction(state:EditorState,changes:ChangeSet){
 return {changes,selection:state.selection.map(changes,-1),scrollIntoView:false,annotations:Transaction.addToHistory.of(false)};
}
