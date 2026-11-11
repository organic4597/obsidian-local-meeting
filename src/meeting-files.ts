export function meetingFolder(value:string){const p=value.trim().replace(/\\/g,'/').replace(/\/+$/,'');if(!p||p.startsWith('/')||/^[a-z]:/i.test(p)||p.split('/').some(x=>!x||x==='.'||x==='..'||x.toLowerCase()==='.obsidian')||/[\x00-\x1f:*?"<>|]/.test(p))throw new Error('회의록 폴더를 Vault 내부 상대 경로로 지정하세요.');return p;}
/** Legacy date helper; existing meetings and paths are not migrated. */
export function meetingDayFolder(folder:string,started:string){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(started));const get=(kind:string)=>parts.find(p=>p.type===kind)!.value;return `${meetingFolder(folder)}/${get('year')}-${get('month')}-${get('day')}`;}
export function meetingTimeFolder(folder:string,started:string){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(started));return meetingFolder(folder)+'/'+['month','day','hour'].map(kind=>parts.find(p=>p.type===kind)!.value).join('-');}
export interface NoteVault {kind(path:string):'file'|'folder'|undefined;mkdir(path:string):Promise<unknown>;create(path:string,text:string):Promise<unknown>;}
export interface NotePreparation {started:string;folder:string;path?:string;created?:boolean;sessionFolder?:string;folderCreated?:boolean;}
/** Save folder and note intents before creation. An ambiguous acknowledgement never creates a second copy. */
export async function createMeetingNote(vault:NoteVault,intent:NotePreparation,save:()=>Promise<void>){
 if(intent.path&&vault.kind(intent.path)){if(intent.created)return intent.path;throw new Error('이전 회의록 준비 기록이 있습니다. 문서를 확인한 뒤 계속하세요.');}
 const root=meetingFolder(intent.folder),base=meetingTimeFolder(root,intent.started);let parent='';
 for(const part of root.split('/')){parent=parent?parent+'/'+part:part;const kind=vault.kind(parent);if(kind==='file')throw new Error('회의록 폴더 위치에 파일이 있습니다.');if(!kind)try{await vault.mkdir(parent);}catch(error){if(vault.kind(parent)!=='folder')throw error;}}
 if(intent.sessionFolder){if(!intent.folderCreated)throw new Error('이전 회의 폴더 준비 기록이 있습니다. 폴더를 확인한 뒤 계속하세요.');if(vault.kind(intent.sessionFolder)!=='folder')throw new Error('준비한 회의 폴더를 찾지 못했습니다.');}
 else for(let i=1;i<=1000;i++){const folder=i===1?base:`${base}-${i}`;if(vault.kind(folder))continue;intent.sessionFolder=folder;intent.folderCreated=false;await save();try{await vault.mkdir(folder);}catch(error){if(vault.kind(folder))throw new Error('회의 폴더 생성 응답을 확인하지 못했습니다. 준비 기록을 확인해 주세요.');throw error;}intent.folderCreated=true;await save();break;}
 if(!intent.sessionFolder)throw new Error('같은 시작 시각의 회의 폴더가 너무 많습니다.');
 const path=intent.sessionFolder+'/회의록.md';if(vault.kind(path))throw new Error('준비한 회의록 위치에 다른 파일이 있습니다. 기존 파일을 확인해 주세요.');
 intent.path=path;intent.created=false;await save();try{await vault.create(path,'');}catch(error){if(vault.kind(path)==='file')throw new Error('회의록 파일은 생성됐지만 완료 응답을 확인하지 못했습니다. 준비 문서를 확인해 주세요.');throw error;}intent.created=true;await save();return path;
}
