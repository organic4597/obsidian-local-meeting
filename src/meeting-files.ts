export function meetingFolder(value:string){const p=value.trim().replace(/\\/g,'/').replace(/\/+$/,'');if(!p||p.startsWith('/')||/^[a-z]:/i.test(p)||p.split('/').some(x=>!x||x==='.'||x==='..'||x.toLowerCase()==='.obsidian')||/[\x00-\x1f:*?"<>|]/.test(p))throw new Error('회의록 폴더를 Vault 내부 상대 경로로 지정하세요.');return p;}
/** Date folders use the Korean meeting start day; existing meetings are never migrated. */
export function meetingDayFolder(folder:string,started:string){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(started));const get=(kind:string)=>parts.find(p=>p.type===kind)!.value;return `${meetingFolder(folder)}/${get('year')}-${get('month')}-${get('day')}`;}
export function meetingTimeFolder(folder:string,started:string){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(started));return meetingFolder(folder)+'/'+['month','day','hour'].map(kind=>parts.find(p=>p.type===kind)!.value).join('-');}
export interface NoteVault {kind(path:string):'file'|'folder'|undefined;mkdir(path:string):Promise<unknown>;create(path:string,text:string):Promise<unknown>;}
export interface NotePreparation {started:string;folder:string;path?:string;created?:boolean;sessionFolder?:string;folderCreated?:boolean;metadata?:{speakerCount:number;speakerCountMode:'maximum'|'exact';audio:'microphone'|'system'|'app'};}
/** Save folder and note intents before creation. An ambiguous acknowledgement never creates a second copy. */
export async function createMeetingNote(vault:NoteVault,intent:NotePreparation,save:()=>Promise<void>){
 if(intent.path&&vault.kind(intent.path)){if(intent.created)return intent.path;throw new Error('이전 회의록 준비 기록이 있습니다. 문서를 확인한 뒤 계속하세요.');}
 const root=meetingFolder(intent.folder),folder=meetingDayFolder(root,intent.started);let parent='';
 if(intent.sessionFolder&&!intent.folderCreated)throw new Error('이전 회의 폴더 준비 기록이 있습니다. 폴더를 확인한 뒤 계속하세요.');
 if(!intent.sessionFolder){intent.sessionFolder=folder;intent.folderCreated=false;await save();}
 for(const part of intent.sessionFolder.split('/')){parent=parent?parent+'/'+part:part;const kind=vault.kind(parent);if(kind==='file')throw new Error('회의록 폴더 위치에 파일이 있습니다.');if(!kind)try{await vault.mkdir(parent);}catch(error){if(parent===intent.sessionFolder&&vault.kind(parent))throw new Error('회의 폴더 생성 응답을 확인하지 못했습니다. 준비 기록을 확인해 주세요.');if(vault.kind(parent)!=='folder')throw error;}}
 intent.folderCreated=true;await save();
 const day=folder.slice(-5);
 let path=intent.path;
 if(!path)for(let i=1;i<=1000;i++){const candidate=intent.sessionFolder+'/'+day+(i===1?'':' '+i)+'.md';if(!vault.kind(candidate)){path=candidate;break;}}
 if(!path)throw new Error('같은 날짜의 회의록이 너무 많습니다.');
 if(vault.kind(path))throw new Error('준비한 회의록 위치에 다른 파일이 있습니다. 기존 파일을 확인해 주세요.');
 intent.path=path;intent.created=false;await save();try{await vault.create(path,meetingNoteHeader(intent));}catch(error){if(vault.kind(path)==='file')throw new Error('회의록 파일은 생성됐지만 완료 응답을 확인하지 못했습니다. 준비 문서를 확인해 주세요.');throw error;}intent.created=true;await save();return path;
}
export function meetingNoteHeader(intent:NotePreparation){
 const date=new Date(intent.started),parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date),get=(kind:string)=>parts.find(p=>p.type===kind)!.value;
 const day=get('year')+'-'+get('month')+'-'+get('day'),clock=get('hour')+':'+get('minute')+':'+get('second'),m=intent.metadata;
 const count=m?.speakerCount?String(m.speakerCount)+'명 ('+(m.speakerCountMode==='exact'?'고정':'최대')+')':'자동 추정';
 const audio=m?.audio==='system'?'마이크 + 시스템 오디오':m?.audio==='app'?'마이크 + 선택한 앱':'마이크';
 return '# '+get('month')+'-'+get('day')+' 회의록\n\n시작: '+day+' '+clock+' (Asia/Seoul · UTC+09:00)\n\n참여 인원 설정: '+count+'\n\n녹음 방식: '+audio+'\n\n## 필기\n\n';
}
