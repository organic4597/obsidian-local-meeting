export interface Segment { id: string; start: number; end: number; text: string; speaker: string; }
export interface Meeting { id: string; note: string; directory: string; started: string; speakers: Record<string,string>; segments: Segment[]; rendered: Record<string,string>; }
export function timestamp(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}
const clean = (s:string) => s.replace(/[\r\n]+/g,' ').replace(/<!--/g,'&lt;!--');
export function segmentText(segment:Segment, speakers:Record<string,string>):string {
  return `**[${timestamp(segment.start)}] ${clean(speakers[segment.speaker] ?? (segment.speaker === 'unknown' ? '화자 미확정' : segment.speaker))}**: ${clean(segment.text)}`;
}
// Replace only an unchanged managed block. Human edits and removed blocks stay untouched.
export function patchSegment(note:string, meeting:Meeting, segment:Segment):string {
  const begin = `<!-- lm:${meeting.id}:${segment.id} -->`;
  const end = `<!-- /lm:${meeting.id}:${segment.id} -->`;
  const next = segmentText(segment,meeting.speakers);
  const at = note.indexOf(begin);
  const previous = meeting.rendered[segment.id];
  if(at < 0) {
    if(previous !== undefined) return note;
    meeting.rendered[segment.id] = next;
    return `${note.trimEnd()}\n\n${begin}\n${next}\n${end}\n`;
  }
  const tail = note.indexOf(end,at+begin.length);
  if(tail < 0) throw new Error('회의록 구간 종료 표시가 없어 자동 수정을 중지했습니다.');
  const current = note.slice(at+begin.length,tail).trim();
  if(previous !== undefined && current !== previous) return note;
  meeting.rendered[segment.id] = next;
  return note.slice(0,at+begin.length)+`\n${next}\n`+note.slice(tail);
}
export type WorkerEvent =
 | {type:'ready'|'stopped';session:string}
 | {type:'status';pending:number;lag:number;state:string}
 | {type:'segment';segment:Segment}
 | {type:'error';message:string;fatal?:boolean};
export function parseEvent(line:string):WorkerEvent {
  const x:unknown = JSON.parse(line);
  if(!x || typeof x !== 'object' || !('type' in x)) throw new Error('잘못된 워커 메시지');
  const e=x as Record<string,unknown>;
  if(e.type==='segment') {
    const s=e.segment as Segment|undefined;
    if(!s || typeof s.id!=='string' || !/^[a-zA-Z0-9_-]+$/.test(s.id) || typeof s.text!=='string' || typeof s.speaker!=='string' || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start<0 || s.end<s.start) throw new Error('잘못된 전사 구간');
  } else if(e.type==='error') {if(typeof e.message!=='string') throw new Error('잘못된 오류');}
  else if(e.type==='status') {if(typeof e.state!=='string'||!Number.isFinite(e.pending)||!Number.isFinite(e.lag)) throw new Error('잘못된 상태');}
  else if(e.type!=='ready' && e.type!=='stopped') throw new Error('알 수 없는 워커 메시지');
  return x as WorkerEvent;
}
