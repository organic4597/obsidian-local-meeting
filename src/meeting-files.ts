export function meetingFolder(value:string){const p=value.trim().replace(/\\/g,'/').replace(/\/+$/,'');if(!p||p.startsWith('/')||/^[a-z]:/i.test(p)||p.split('/').some(x=>!x||x==='.'||x==='..'||x.toLowerCase()==='.obsidian')||/[\x00-\x1f:*?"<>|]/.test(p))throw new Error('회의록 폴더를 Vault 내부 상대 경로로 지정하세요.');return p;}
export function meetingDayFolder(folder:string,started:string){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(started));const get=(kind:string)=>parts.find(p=>p.type===kind)!.value;return `${meetingFolder(folder)}/${get('year')}-${get('month')}-${get('day')}`;}
export interface NoteVault {kind(path:string):'file'|'folder'|undefined;mkdir(path:string):Promise<unknown>;create(path:string,text:string):Promise<unknown>;}
export interface NotePreparation {started:string;folder:string;path?:string;created?:boolean;}
/** The intent callback must be durable before creating the note. Never adopt an ambiguous file. */
export async function createMeetingNote(vault:NoteVault,intent:NotePreparation,save:()=>Promise<void>){
 const folder=meetingDayFolder(intent.folder,intent.started);
 if(intent.path&&vault.kind(intent.path)){if(intent.created)return intent.path;throw new Error('이전 회의록 준비 기록이 있습니다. 문서를 확인한 뒤 계속하세요.');}
 let path='';for(const part of folder.split('/')){path=path?path+'/'+part:part;const kind=vault.kind(path);if(kind==='file')throw new Error('회의록 폴더 위치에 파일이 있습니다.');if(!kind)try{await vault.mkdir(path);}catch(e){if(vault.kind(path)!=='folder')throw e;}}
 for(let i=1;i<=1000;i++){const candidate=`${folder}/회의록${i===1?'':' '+i}.md`;if(vault.kind(candidate))continue;intent.path=candidate;intent.created=false;await save();try{await vault.create(candidate,'');}catch(e){if(vault.kind(candidate)==='file')throw new Error('회의록 파일은 생성됐지만 완료 응답을 확인하지 못했습니다. 준비 문서를 확인해 주세요.');throw e;}intent.created=true;await save();return candidate;}throw new Error('같은 날짜의 회의록이 너무 많습니다. 저장 폴더를 확인하세요.');
}
