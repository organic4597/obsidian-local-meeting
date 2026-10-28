import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {dirname,join} from 'node:path';
export interface PlaybackRange {start:number;end:number;label:string;from:number;to:number;}
export const rangePattern=/\b(?:\d{1,3}:)?\d{1,2}:\d{2}\s*[–—~−-]\s*(?:\d{1,3}:)?\d{1,2}:\d{2}\b/g;
export function parsePlaybackTime(text:string){const p=text.trim().split(':').map(Number);if(p.length<2||p.length>3||p.some(n=>!Number.isSafeInteger(n)||n<0)||p.at(-1)!>=60||p.length===3&&p[1]!>=60)return null;const ms=p.length===3?(p[0]!*3600+p[1]!*60+p[2]!)*1000:(p[0]!*60+p[1]!)*1000;return ms<=24*3600*1000?ms:null;}
export function playbackRanges(text:string){const ranges:PlaybackRange[]=[];for(const match of text.matchAll(rangePattern)){const [a,b]=match[0].split(/[–—~−-]/),start=parsePlaybackTime(a!),end=parsePlaybackTime(b!);if(start===null||end===null||end<=start)continue;ranges.push({start,end,label:match[0],from:match.index!,to:match.index!+match[0].length});}return ranges;}
export const validSession=(id:unknown):id is string=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export function recordingPath(root:string,session:string){if(!validSession(session))throw new Error('잘못된 회의 녹음 정보입니다.');return join(root,session,'recording.wav');}
/** Local note-to-session index contains no note contents, tokens, or user-supplied audio paths. */
export class SummaryAudioIndex {
 private entries:Record<string,string>={};private writes:Promise<void>=Promise.resolve();
 constructor(private path:string|undefined,private changed:()=>void=()=>{}){}
 async load(){if(!this.path)return;try{const data=JSON.parse(await readFile(this.path,'utf8'));if(data&&typeof data==='object'&&!Array.isArray(data))for(const [note,id] of Object.entries(data))if(note.endsWith('.md')&&validSession(id))this.entries[note]=id;}catch{}}
 session(note:string){return this.entries[note];}
 register(note:string|undefined,session:string){if(!note?.endsWith('.md')||!validSession(session)||this.entries[note]===session)return;this.entries[note]=session;this.changed();const snapshot=JSON.stringify(this.entries,null,2),path=this.path;if(path)this.writes=this.writes.catch(()=>{}).then(async()=>{await mkdir(dirname(path),{recursive:true});await writeFile(path+'.tmp',snapshot,{mode:0o600});await rename(path+'.tmp',path);});void this.writes.catch(()=>{});}
 async flush(){await this.writes;}
}
