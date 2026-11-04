import {publishSummary} from './summary-publish';
import {PostprocessLedger,stageKey} from './postprocess';
import {homedir} from 'node:os';
import {SessionRegistry} from './session-registry';
import {createMeetingNote,meetingFolder,NotePreparation} from './meeting-files';
import {CorrectionCandidates} from './correction-candidates';
import {Transaction} from '@codemirror/state';
import {noteClock,timeNoteDocument,timedNotes} from './note-timing';
import {App,MarkdownView,FileSystemAdapter,ItemView,Notice,Plugin,PluginSettingTab,Setting,TFile,WorkspaceLeaf,Modal,normalizePath,setIcon,editorInfoField,TFolder} from 'obsidian';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync} from 'node:fs';
import {join,isAbsolute,dirname,basename} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {release as osRelease} from 'node:os';
import {mkdir,writeFile,readFile,rename,copyFile,readdir,unlink} from 'node:fs/promises';
import {hoverRecordingRanges} from './summary-content';
import {SummaryAudioIndex,playbackRanges,validSession} from './summary-playback';
import {SummaryReviewStore,ReviewItem} from './summary-review';
import {VoiceProfiles,VoiceFeatures,validateFeatures,autoMatch} from './voice-profiles';
import {VoiceProfilesModal} from './voice-profile-ui';
import {SummaryAudio} from './summary-audio-ui';
import {Meeting,WorkerEvent,rebaseAnchors,migrateMeeting,speakerName,timestamp} from './model';
import {WorkerBridge} from './bridge';
import {CalendarModal,TaskModal,openCalendarCandidate} from './calendar';
import {MeetingEditors} from './editor-sync';
import {textChange,transcriptChanges} from './editor-changes';
import {ChangeSet} from '@codemirror/state';
import {attachOverlayDrag,OverlayPosition} from './overlay';
import {LocalDictionary,dictionaryCsv} from './dictionary';
import {DictionaryModal,TermModal,ReviewModal} from './quality-ui';
import {acceptRevision,needsReview,reviewEdit,undoReview} from './quality-model';
import {refineSpeakers} from './speaker-refinement';
import {splitAlignedSpeakers} from './aligned-speakers';
import {previewText,refinePreview,planPreviewCommit,recoverPreviewCommit} from './live-preview';
import {reviewGroups,participantIds,candidateGroups,compactStatus,numberCandidateGroups,isUnconfirmedSpeaker,removeParticipant,restoreDeletedGroups} from './meeting-presentation';
import {dateContext,normalizeEvents,meetingDay} from './meeting-dates';
import {ChatGPTAuth} from './openai-auth';
import {MeetingSetupModal} from './meeting-setup';
import {AIControlsModal,ChatGPTWelcomeModal} from './ai-ui';
import {summaryInput,requestSummary,summaryMarkdown,validateSummary,chooseSummaryPath,evidenceRanges,wrapExistingRecordingRanges,SummaryResult,MeetingEvent} from './ai-summary';

interface Settings {vaultId:string;meetingFolder:string;qualityStorage:string;pendingStartDirectory:string;python:string;model:string;storage:string;device:string;lastSession:string;testAudio:string;showTime:boolean;calendarId:string;overlayPosition:OverlayPosition|null;paragraphPauseSeconds:number;dictionaryEnabled:boolean;dictionaryProject:string;expectedSpeakers:number;communityPython:string;communityModel:string;alignerModel:string;speakerCountMode:'maximum'|'exact';aiModel:string;aiAutoSummary:boolean;voiceProfilesEnabled:boolean;voiceAutoThreshold:string;voiceAutoMargin:string;summaryFolder:string;}
const DEFAULT:Settings={vaultId:'',meetingFolder:'',qualityStorage:'',pendingStartDirectory:'',python:'python3',model:'',storage:'',device:'',lastSession:'',testAudio:'',showTime:false,calendarId:'',overlayPosition:null,paragraphPauseSeconds:2.5,dictionaryEnabled:true,dictionaryProject:'',expectedSpeakers:0,communityPython:'',communityModel:'',alignerModel:'',speakerCountMode:'maximum',aiModel:'',aiAutoSummary:true,voiceProfilesEnabled:false,voiceAutoThreshold:'',voiceAutoMargin:'',summaryFolder:''};
const VIEW='local-meeting-controls';
export default class LocalMeeting extends Plugin {
  settings:Settings={...DEFAULT};
  meeting?:Meeting;
  bridge?:WorkerBridge;
  state='대기'; pending=0; lag=0; error='';typingPaused=false;
  diagnostics:Record<string,unknown>={};private protocol=0;private dictionaryUpdates:Promise<unknown>=Promise.resolve();private persistFailed=false;
  private ledgerInstance?:PostprocessLedger;private ledgerDirectory='';private registry?:SessionRegistry;private registryHome='';private summaryAudio?:SummaryAudio;private audioIndex?:SummaryAudioIndex;private reviewStore?:SummaryReviewStore;private reviewDirectory?:string;
  private auth!:ChatGPTAuth;private summaryBusy=false;private errorNotices=new Map<string,number>();
  private editors!:MeetingEditors;
  private writes:Promise<unknown>=Promise.resolve();
  private status!:HTMLElement;
  private closing=false;
  private transitioning=false;
  private sessionAudio?:{helper:string;pid?:number};
  private voiceStore?:VoiceProfiles;private voiceRoot='';
  private overlay!:HTMLElement;
  private overlayButton!:HTMLButtonElement;
  private overlayState!:HTMLElement;
  private overlayReview!:HTMLElement;
  private overlayDrag?:ReturnType<typeof attachOverlayDrag>;
  private popup!:HTMLElement;
  private persistTimer?:number;private checkpointTimer?:ReturnType<typeof setTimeout>;private candidatesStore?:CorrectionCandidates;private candidatesRoot='';
  async onload(){
    const saved=await this.loadData();
    if(saved&&typeof saved==='object'){
      const stale=['diarModel','diarLibrary','finalizeSpeakers'];
      if(stale.some(key=>key in saved)){for(const key of stale)delete saved[key];await this.saveData(saved);}
    }
    this.settings=Object.assign({},DEFAULT,saved);if(!validSession(this.settings.vaultId))this.settings.vaultId=randomUUID();if(!this.settings.qualityStorage&&isAbsolute(this.settings.storage))this.settings.qualityStorage=this.settings.storage;await this.saveData(this.settings);
    if(!Number.isInteger(this.settings.expectedSpeakers)||this.settings.expectedSpeakers<0||this.settings.expectedSpeakers>32)this.settings.expectedSpeakers=0;
    if(![2,2.5,3].includes(this.settings.paragraphPauseSeconds))this.settings.paragraphPauseSeconds=2.5;
    if(!['maximum','exact'].includes(this.settings.speakerCountMode))this.settings.speakerCountMode='maximum';
    if(typeof this.settings.voiceAutoThreshold!=='string')this.settings.voiceAutoThreshold='';if(typeof this.settings.voiceAutoMargin!=='string')this.settings.voiceAutoMargin='';
    const adapter=this.app.vault.adapter as FileSystemAdapter;
    try{const runtime=JSON.parse(await readFile(join(adapter.getBasePath(),this.manifest.dir!,'local-runtime.json'),'utf8'));for(const key of ['communityPython','communityModel','alignerModel'] as const)if(!this.settings[key]&&typeof runtime[key]==='string'&&isAbsolute(runtime[key])&&existsSync(runtime[key]))this.settings[key]=runtime[key];}catch{}
    const secretId='local-meeting-chatgpt-'+createHash('sha256').update(adapter.getBasePath()).digest('hex').slice(0,16);
    this.auth=new ChatGPTAuth({read:async()=>{const value=this.app.secretStorage.getSecret(secretId);return value?JSON.parse(value):null;},write:async value=>this.app.secretStorage.setSecret(secretId,JSON.stringify(value))},url=>require('electron').shell.openExternal(url));
    this.editors=new MeetingEditors(view=>view.state.field(editorInfoField,false)?.file?.path,paused=>{this.typingPaused=paused;this.refresh();},(path,update)=>{const m=this.meeting;if(!m||path!==m.note)return;const user=update.transactions.some(t=>t.docChanged&&t.annotation(Transaction.addToHistory)!==false);timeNoteDocument(m,update.startState.doc.toString(),update.state.doc.toString(),update.changes,this.bridge&&!this.closing?noteClock(this.diagnostics,Date.now()):null,user);});
    this.registerEditorExtension(this.editors.extension);
    this.registryHome=join(homedir(),'Library','Application Support','obsidian-local-meeting','vaults',this.settings.vaultId);
    this.registry=new SessionRegistry(join(this.registryHome,'registry.json'));await this.registry.load();
    const roots=[this.settings.storage,this.settings.qualityStorage,...(this.settings.lastSession?[dirname(this.settings.lastSession)]:[])].filter(p=>isAbsolute(p));const indexes:Record<string,string>[]=[];
    for(const root of new Set(roots))try{indexes.push(JSON.parse(await readFile(join(root,'.local-meeting-quality',`summary-audio-${createHash('sha256').update(adapter.getBasePath()).digest('hex').slice(0,16)}.json`),'utf8')));}catch{}
    await this.registry.importRoots(roots,indexes);
    this.audioIndex=new SummaryAudioIndex(join(this.registryHome,'summary-audio.json'),()=>this.summaryAudio?.refresh());await this.audioIndex.load();for(const entry of this.registry.summaryNotes())this.audioIndex.register(entry.path,entry.session);await this.audioIndex.flush();
    this.summaryAudio=new SummaryAudio(this.app,this.audioIndex,{root:()=>this.root(),resolveRecording:id=>this.recordingFile(id),recording:()=>!!this.bridge&&!this.closing,systemAudio:()=>!!this.sessionAudio,fileOf:view=>view.state.field(editorInfoField,false)?.file?.path});
    this.registerEditorExtension(this.summaryAudio.extension);this.registerMarkdownPostProcessor((element,context)=>this.summaryAudio?.process(element,context.sourcePath));
    this.registerView(VIEW,leaf=>new MeetingView(leaf,this));
    this.registerObsidianProtocolHandler('local-meeting',params=>{
      void this.guard(async()=>{
        if(params.op==='time'){await this.toggleTime();return;}
        if(params.op==='minimize'){for(const leaf of this.app.workspace.getLeavesOfType(VIEW))leaf.detach();return;}
        if(params.op==='calendar'){this.openCalendar();return;}
        if(params.op==='ai'){new AIControlsModal(this.app,this).open();return;}
        if(params.op==='dictionary'){new DictionaryModal(this.app,this).open();return;}
        if(params.op==='review'){new ReviewModal(this.app,this).open();return;}
        if(params.op==='controls'){await this.openControls();return;}
        if(params.op==='stop'){this.stop();return;}
        if(params.op==='recover'){await this.recover();return;}
        // File tests require an existing note in the dedicated test folder.
        // A URI can never select arbitrary audio, execute a command, or start a microphone.
        if(params.op==='test' && params.note?.startsWith('Local Meeting Tests/') && !params.note.includes('..')){
          const file=this.app.vault.getAbstractFileByPath(normalizePath(params.note));
          if(!(file instanceof TFile)||file.extension!=='md')throw new Error('테스트 노트가 없습니다.');
          await this.app.workspace.getLeaf(false).openFile(file);
          await this.start(this.settings.testAudio);
        }
      });
    });
    this.addSettingTab(new MeetingSettings(this.app,this));
    this.registerEvent(this.app.workspace.on('active-leaf-change',()=>this.refresh()));
    this.app.workspace.onLayoutReady(()=>{this.writes=this.writes.then(()=>this.migrateCurrentNote()).catch(error=>this.showError(String(error)));});
    this.status=this.addStatusBarItem();this.createOverlay();this.refresh();
    this.registerEvent(this.app.workspace.on('editor-change',(editor,info)=>{
      const meeting=this.meeting;if(!meeting||info.file?.path!==meeting.note)return;
      const value=editor.getValue();if(meeting.noteSnapshot!==undefined)rebaseAnchors(meeting,meeting.noteSnapshot,value);
      window.clearTimeout(this.persistTimer);this.persistTimer=window.setTimeout(()=>{this.writes=this.writes.then(()=>this.saveMeeting()).catch(error=>this.showError(String(error)));},400);
    }));
    this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{this.writes=this.writes.then(async()=>{await this.registry?.renameNote(oldPath,file.path);this.audioIndex?.rename(oldPath,file.path);await this.audioIndex?.flush();const m=this.meeting;if(!m)return;const moved=(p:string)=>p===oldPath?file.path:p.startsWith(oldPath+'/')?file.path+p.slice(oldPath.length):p;const old=m.note;m.note=moved(m.note);if(m.aiSummary)m.aiSummary.note=moved(m.aiSummary.note);await this.ledger().update(d=>{if(d.publish)d.publish.note=moved(d.publish.note);});if(old!==m.note){this.editors.clearPreview(old);this.showPreview();}await this.saveMeeting();}).catch(e=>this.showError(String(e)));}));
    this.addCommand({id:'postprocess',name:'회의 처리 단계와 이어서 처리',callback:()=>{void this.guard(()=>this.openPostprocess());}});
    this.addCommand({id:'session-locations',name:'회의 저장 위치 연결',callback:()=>{void this.guard(()=>this.openSessionLocations());}});
    this.addCommand({id:'pending-note-start',name:'미완료 회의록 준비 확인',callback:()=>{void this.guard(()=>this.openPendingStart());}});
    this.addRibbonIcon('mic','로컬 회의록',()=>{void this.openControls();});
    this.addCommand({id:'toggle',name:'녹음 시작 / 중지',hotkeys:[{modifiers:['Mod','Shift'],key:'M'}],callback:()=>this.toggleRecording()});
    this.addCommand({id:'timed-notes',name:'필기 시점과 주변 발언 검토',callback:()=>{void this.guard(()=>this.openTimedNotes());}});
    this.addCommand({id:'confirm-preview',name:'임시 전사를 본문으로 확정',callback:()=>{void this.reviewWrite(async()=>{if(this.bridge)throw new Error('녹음과 후처리가 끝난 뒤 확정하세요.');if(this.meeting?.presentation&&this.meeting.presentation!=='document')await this.finishPreview();});}});
    this.addCommand({id:'timestamps',name:'시간 표시 켜기 / 끄기',hotkeys:[{modifiers:['Mod','Alt'],key:'T'}],callback:()=>{void this.guard(()=>this.toggleTime());}});
    this.addCommand({id:'calendar',name:'연결된 캘린더 열기',hotkeys:[{modifiers:['Mod','Alt'],key:'C'}],callback:()=>this.openCalendar()});
    this.addCommand({id:'task',name:'현재 노트에 할 일 추가',callback:()=>new TaskModal(this.app).open()});
    this.addCommand({id:'start',name:'새 회의록 만들고 녹음 시작',callback:()=>{void this.guard(()=>this.start());}});
    this.addCommand({id:'stop',name:'녹음 중지 및 남은 전사 처리',callback:()=>this.stop()});
    this.addCommand({id:'recordings',name:'현재 회의 녹음 파일 보기',callback:()=>{void this.guard(()=>this.openRecordingFolder());}});
    this.addCommand({id:'number-unknown-speakers',name:'현재 회의의 미확정 음성 그룹에 화자 번호 표시',callback:()=>{void this.guard(()=>this.numberUnknownSpeakers());}});
    this.addCommand({id:'recover',name:'마지막 세션 복구 및 전사 재시도',callback:()=>{void this.guard(()=>this.recover());}});
    this.addCommand({id:'test-audio',name:'테스트 WAV를 현재 노트에 전사',callback:()=>{void this.guard(()=>this.start(this.settings.testAudio));}});
    this.addCommand({id:'controls',name:'상세 보기 / 최소화',hotkeys:[{modifiers:['Mod','Alt'],key:'M'}],callback:()=>{void this.toggleControls();}});
    this.addCommand({id:'dictionary',name:'회의 사전 열기',callback:()=>new DictionaryModal(this.app,this).open()});
    this.addCommand({id:'voice-profiles',name:'화자 음성 프로필 관리',callback:()=>new VoiceProfilesModal(this.app,this).open()});
    this.addCommand({id:'dictionary-toggle',name:'회의 사전 켜기 / 끄기',callback:()=>{this.settings.dictionaryEnabled=!this.settings.dictionaryEnabled;void this.guard(()=>this.dictionaryChanged());}});
    this.addCommand({id:'dictionary-selection',name:'선택한 표현을 사전에 추가',callback:()=>{void this.guard(async()=>{const selection=this.app.workspace.getActiveViewOfType(MarkdownView)?.editor.getSelection()??'';const data=await this.dictionary().request({type:'list'});new TermModal(this.app,this,data,undefined,undefined,selection).open();});}});
    this.addCommand({id:'correction-candidates',name:'반복 오인식 사전 후보',callback:()=>{void this.guard(()=>this.openCorrectionCandidates());}});
    this.addCommand({id:'retranscription-candidates',name:'종료 후 재전사 후보',callback:()=>{void this.guard(()=>this.openRetranscriptionCandidates());}});
    this.addCommand({id:'review',name:'확인 필요한 발언 검토',callback:()=>new ReviewModal(this.app,this).open()});
    this.addCommand({id:'ai-summary',name:'OpenAI 요약·할 일·일정 정리',callback:()=>new AIControlsModal(this.app,this).open()});
    this.addCommand({id:'refine-speakers',name:'현재 회의 종료 후 화자 재분석',callback:()=>{void this.guard(()=>this.reanalyseSpeakers());}});
    this.addCommand({id:'diagnostics',name:'현재 회의 진단 내보내기',callback:()=>{void this.guard(()=>this.exportDiagnostics());}});
  }
  async guard(action:()=>Promise<void>){try{await action();}catch(error){this.showError(String(error));}}
  showError(error:string){this.error=error;const now=Date.now();if(now-(this.errorNotices.get(error)??0)>60000){this.errorNotices.set(error,now);new Notice(error,8000);}this.refresh();}
  refresh(force=false){
    const label=compactStatus(this.state,!!this.bridge,this.closing,this.summaryBusy,this.error,!!this.meeting?.segments.length);
    this.status?.setText(`회의록 · ${label}${this.bridge&&this.pending>0?' · 처리 중 '+this.pending+'개':''}`);
    this.overlay?.toggleClass('is-running',!!this.bridge&&!this.closing);this.overlay?.toggleClass('is-processing',!!this.bridge&&this.closing||this.summaryBusy);this.overlay?.toggleClass('has-error',!!this.error);
    if(this.overlayReview)this.overlayReview.hidden=true;
    this.overlayState?.setText(label);
    this.overlayButton?.setAttribute('aria-label',`로컬 회의록: ${label}. 클릭하면 제어 메뉴를 엽니다.`);
    this.overlayButton?.setAttribute('title',`${this.state}\n드래그하여 이동 · ⌘⇧M 시작/중지`);
    for(const leaf of this.app.workspace.getLeavesOfType(VIEW)) if(leaf.view instanceof MeetingView) leaf.view.render(force);
  }
  async openControls(){let leaf=this.app.workspace.getLeavesOfType(VIEW)[0];if(!leaf){leaf=this.app.workspace.getRightLeaf(false)??undefined;await leaf?.setViewState({type:VIEW,active:true});}if(leaf)await this.app.workspace.revealLeaf(leaf);}
  private createOverlay(){
    this.overlay=document.body.createDiv({cls:'lm-overlay'});this.overlayButton=this.overlay.createEl('button',{cls:'lm-overlay-icon',attr:{'aria-label':'로컬 회의록 제어','aria-expanded':'false'}});setIcon(this.overlayButton,'mic');
    this.overlayButton.createSpan({cls:'lm-overlay-label',text:'회의록'});
    this.overlayState=this.overlayButton.createSpan({cls:'lm-overlay-state',text:'대기'});
    this.overlayReview=this.overlayButton.createSpan({cls:'lm-overlay-review'});this.overlayReview.hidden=true;
    this.popup=this.overlay.createDiv({cls:'lm-overlay-menu'});this.popup.hidden=true;
    const action=(label:string,fn:()=>void)=>{this.popup.createEl('button',{text:label}).addEventListener('click',()=>{fn();this.popup.hidden=true;this.overlayButton.setAttribute('aria-expanded','false');});};
    this.overlayDrag=attachOverlayDrag({overlay:this.overlay,button:this.overlayButton,menu:this.popup,getPosition:()=>this.settings.overlayPosition,savePosition:position=>{this.settings.overlayPosition=position;void this.guard(()=>this.saveData(this.settings));}});
    this.register(()=>this.overlayDrag?.dispose());
    action('녹음 시작 / 중지  ⌘⇧M',()=>this.toggleRecording());action('상세 보기  ⌘⌥M',()=>{void this.openControls();});action('시간 표시 켜기 / 끄기  ⌘⌥T',()=>{void this.guard(()=>this.toggleTime());});action('캘린더  ⌘⌥C',()=>this.openCalendar());action('노트에 할 일 추가',()=>new TaskModal(this.app).open());
    action('버튼 위치 초기화',()=>{this.settings.overlayPosition=null;this.overlayDrag?.refreshPosition();void this.guard(()=>this.saveData(this.settings));});
    action('임시 전사를 본문으로 확정',()=>{void this.reviewWrite(async()=>{if(this.bridge)throw new Error('녹음과 후처리가 끝난 뒤 확정하세요.');await this.finishPreview();});});
    action('회의 사전',()=>new DictionaryModal(this.app,this).open());action('확인 필요한 발언 검토',()=>new ReviewModal(this.app,this).open());
    this.overlayButton.addEventListener('click',()=>{this.popup.hidden=!this.popup.hidden;this.overlayButton.setAttribute('aria-expanded',String(!this.popup.hidden));this.overlayDrag?.layoutMenu();});
    this.registerDomEvent(document,'keydown',event=>{if(event.key==='Escape'&&!this.popup.hidden){this.popup.hidden=true;this.overlayButton.setAttribute('aria-expanded','false');this.overlayButton.focus();}});
    this.registerDomEvent(document,'click',event=>{if(!this.overlay.contains(event.target as Node)){this.popup.hidden=true;this.overlayButton.setAttribute('aria-expanded','false');}});
  }
  get isStopping(){return this.closing&&!!this.bridge;}
  toggleRecording(){if(this.bridge)this.stop();else void this.guard(async()=>{const meeting=this.meeting;if(meeting?.aiSummary&&meeting.aiSummary.note===this.app.workspace.getActiveFile()?.path){const source=this.app.vault.getAbstractFileByPath(meeting.note);if(source instanceof TFile)await this.app.workspace.getLeaf(false).openFile(source);}await this.start();});}
  async toggleControls(){const leaves=this.app.workspace.getLeavesOfType(VIEW);if(leaves.length)for(const leaf of leaves)leaf.detach();else await this.openControls();}
  openCalendar(){const adapter=this.app.vault.adapter as FileSystemAdapter;new CalendarModal(this.app,{helper:join(adapter.getBasePath(),this.manifest.dir!,'native/calendar-bridge'),calendarId:this.settings.calendarId,saveCalendar:async id=>{this.settings.calendarId=id;await this.saveData(this.settings);}}).open();}
  async openRecordingFolder(){
    const path=this.meeting?(this.registry?await this.registry.directory(this.meeting.id):this.meeting.directory):undefined;if(!path)throw new Error('저장된 회의 녹음이 없습니다.');
    const recording=join(path,'recording.wav');
    if(!existsSync(recording)){
      if(this.bridge)throw new Error('녹음 파일을 준비 중입니다. 잠시 후 다시 열어 주세요.');
      const adapter=this.app.vault.adapter as FileSystemAdapter;
      new Notice('이전 회의의 전체 녹음 파일을 준비합니다.');
      await promisify(execFile)(this.settings.python,[join(adapter.getBasePath(),this.manifest.dir!,'worker/recording.py'),'--session',path],{timeout:90000,maxBuffer:65536});
    }
    const shell=require('electron').shell as {showItemInFolder:(path:string)=>void};shell.showItemInFolder(recording);
  }

  async toggleTime(){this.settings.showTime=!this.settings.showTime;await this.saveData(this.settings);this.writes=this.writes.then(async()=>{if(this.meeting)await this.renderSegments(this.meeting.segments.map(s=>s.id),'time');this.refresh(true);});await this.writes;new Notice(this.settings.showTime?'시간 표시 켬':'시간 표시 끔');}
  async migrateCurrentNote(){
    if(!this.meeting&&this.settings.lastSession){const id=basename(this.settings.lastSession),path=this.registry&&validSession(id)?await this.registry.directory(id):this.settings.lastSession;this.meeting=JSON.parse(await readFile(join(path,'meeting.json'),'utf8'));}
    const meeting=this.meeting;if(!meeting)return;
    if(this.registry){meeting.directory=await this.registry.directory(meeting.id);meeting.note=this.registry.resolveNote(meeting.id,meeting.note);if(meeting.aiSummary)meeting.aiSummary.note=this.registry.resolveNote(meeting.id,meeting.aiSummary.note);}
    await this.registerSummaryAudio(meeting);
    if(meeting.presentation&&meeting.presentation!=='document'){
      const file=this.app.vault.getAbstractFileByPath(meeting.note);if(!(file instanceof TFile))return;
      const doc=this.editors.find(meeting.note)?.state.doc.toString()??await this.app.vault.read(file),recovery=recoverPreviewCommit(meeting,doc);
      if(recovery==='committed'){this.editors.clearPreview(meeting.note);await this.saveMeeting();}
      else if(recovery==='ambiguous'){meeting.presentation='ghost';this.showPreview();new Notice('확정 기록 중 본문이 바뀌었습니다. 임시 전사는 보존됐습니다. 본문 확인 후 ‘임시 전사를 본문으로 확정’을 실행하세요.',15000);}
      else if(meeting.presentation==='committing')await this.finishPreview();else this.showPreview();
      this.refresh();return;
    }
    const file=this.app.vault.getAbstractFileByPath(meeting.note);if(!(file instanceof TFile))return;
    if(!meeting.pipelineVersion){const backup=join(meeting.directory,'meeting.pre-quality.json');if(!existsSync(backup))await copyFile(join(meeting.directory,'meeting.json'),backup);}
    if(!await this.editors.ready(meeting.note))return;
    const disk=await this.app.vault.read(file),view=this.editors.find(meeting.note);
    // A just-created editor may still be loading; an unsaved buffer must also win.
    if(view&&view.state.doc.toString()!==disk){this.refresh();return;}
    // Existing meetings are not reprocessed or reformatted by this upgrade.
    if(!meeting.pipelineVersion){if(meeting.noteSnapshot!==undefined)rebaseAnchors(meeting,meeting.noteSnapshot,disk);this.refresh();return;}
    if(view){const before=view.state.doc.toString(),next=migrateMeeting(before,meeting),change=textChange(before,next);if(change)this.editors.apply(view,ChangeSet.of(change,before.length));}
    else await this.app.vault.process(file,text=>migrateMeeting(text,meeting));
    await this.renderSegments(meeting.segments.map(s=>s.id),'time');this.refresh();
  }
  private ledger(){if(!this.meeting)throw new Error('회의가 없습니다.');if(this.ledgerDirectory!==this.meeting.directory){this.ledgerDirectory=this.meeting.directory;this.ledgerInstance=new PostprocessLedger(this.meeting.directory);}return this.ledgerInstance!;}
  async continuePostprocess(stage?:string){if(this.bridge||this.summaryBusy||this.transitioning)throw new Error('진행 중인 처리가 끝난 뒤 실행하세요.');await this.writes;const m=this.meeting;if(!m)throw new Error('회의가 없습니다.');if(this.registry)m.directory=await this.registry.directory(m.id);const ledger=await this.ledger().read();if(stage==='rescan'){this.launch(true,undefined,false,'rescan');return;}if(stage==='commit'&&m.speakerPassId&&m.presentation!=='document'){await this.finishPreview();return;}if(['ai','publish'].includes(stage??'')&&m.presentation==='document'){await this.generateSummary();return;}if(m.speakerPassId&&m.presentation&&m.presentation!=='document'&&!['diarization','alignment','asr'].some(k=>['failed','waiting_input','running'].includes(ledger.stages[k]?.status??''))){await this.finishPreview();return;}if(m.presentation==='document'&&m.speakerPassId&&!['diarization','alignment','asr'].some(k=>['failed','waiting_input','running'].includes(ledger.stages[k]?.status??''))){await this.generateSummary();return;}await this.saveMeeting();this.launch(true);}
  async openPostprocess(){
    const d=await this.ledger().read(),modal=new Modal(this.app);modal.setTitle('회의 처리 단계');modal.modalEl.addClass('lm-process-modal');
    modal.contentEl.createEl('p',{text:'실패한 단계부터 계속할 수 있습니다. 완료된 결과는 확인 후 재사용합니다.',cls:'lm-hint'});
    if(!Object.keys(d.stages).length&&this.meeting?.speakerPassId)modal.contentEl.createEl('p',{text:'이전 버전에서 완료한 회의입니다. 단계별 기록은 다음 처리부터 남습니다.',cls:'lm-hint'});
    const labels:Record<string,string>={asr:'전사 마감',rescan:'재전사 후보',diarization:'화자 분석',alignment:'시간 정렬',commit:'회의록 반영',ai:'AI 정리',publish:'정리 노트 생성'};
    for(const [id,label] of Object.entries(labels)){
      const state=d.stages[id],row=modal.contentEl.createDiv({cls:'lm-stage-row'});row.createEl('strong',{text:label});row.createSpan({text:state?({running:'진행 중 또는 중단됨',succeeded:state.cached?'완료 · 저장 결과 재사용':'완료',failed:'실패',waiting_input:'확인 필요'})[state.status]:this.meeting?.speakerPassId?'이전 기록':'대기',cls:'lm-hint'});
      if(state?.message)row.createEl('p',{text:state.message,cls:'lm-stage-message'});
      if(state&&state.status!=='succeeded')row.createEl('button',{text:'이 단계부터 계속'}).addEventListener('click',()=>{void this.guard(()=>this.continuePostprocess(id));modal.close();});
    }
    modal.contentEl.createDiv({cls:'lm-form-actions'}).createEl('button',{text:'이어서 처리',cls:'mod-cta'}).addEventListener('click',()=>{void this.guard(()=>this.continuePostprocess());modal.close();});
    modal.contentEl.createEl('p',{text:'기존 필기와 화자 수정은 유지합니다. 이미 반영한 일정·할 일·사전은 다시 등록하지 않습니다. 상태는 창을 연 시점 기준입니다.',cls:'lm-hint'});modal.open();
  }

  private qualityRoot(){return this.settings.qualityStorage||this.root();}
  async recordingFile(id=this.meeting?.id){if(!id)throw new Error('회의가 없습니다.');if(this.meeting?.id===id&&this.bridge)return join(this.meeting.directory,'recording.wav');return this.registry?this.registry.recording(id):join(this.meeting!.directory,'recording.wav');}
  async openPendingStart(){const directory=this.settings.pendingStartDirectory;if(!directory){new Notice('미완료 준비 기록이 없습니다.');return;}const modal=new Modal(this.app);modal.setTitle('미완료 회의록 준비');let intent:NotePreparation|undefined;try{intent=JSON.parse(await readFile(join(directory,'note-preparation.json'),'utf8'));}catch{}modal.contentEl.createEl('p',{text:intent?.path??directory});modal.contentEl.createEl('p',{text:'기존 문서와 일부 녹음은 삭제하지 않습니다. 준비한 문서를 확인한 뒤 새 회의를 시작할 수 있습니다.'});if(intent?.path)modal.contentEl.createEl('button',{text:'준비 문서 열기'}).addEventListener('click',()=>{const f=this.app.vault.getAbstractFileByPath(intent!.path!);if(f instanceof TFile)void this.app.workspace.getLeaf(false).openFile(f);});modal.contentEl.createEl('button',{text:'준비 기록 보관하고 새 회의 허용'}).addEventListener('click',()=>{this.settings.pendingStartDirectory='';void this.saveData(this.settings).then(()=>modal.close());});modal.open();}
  async openSessionLocations(){const modal=new Modal(this.app);modal.setTitle('회의 저장 위치 연결');modal.contentEl.createEl('p',{text:'새 기본 폴더를 바꿔도 과거 회의는 원래 위치를 사용합니다. 이동한 회의 폴더는 기존 교정 정보와 녹음이 같은지 확인합니다.'});const scan=modal.contentEl.createEl('input',{type:'text',attr:{placeholder:'이전 오디오 저장 폴더의 절대 경로','aria-label':'이전 오디오 저장 폴더'}}),report=modal.contentEl.createEl('p');modal.contentEl.createEl('button',{text:'이전 저장 폴더 찾기'}).addEventListener('click',()=>{void this.registry!.importRoots([scan.value.trim()]).then(errors=>{report.setText(errors.length?errors.map(x=>x.path+': '+x.error).join('\n'):'가져오기를 마쳤습니다. 이 창을 다시 열면 확인할 수 있습니다. 원본 파일은 변경하지 않았습니다.');}).catch(e=>report.setText(String(e)));});for(const [id,e] of Object.entries(this.registry?.entries()??{})){const row=modal.contentEl.createEl('details');row.createEl('summary',{text:e.notes.find(n=>n.role==='source')?.path??id});row.createEl('p',{text:e.directory});if(e.conflicts.length)row.createEl('p',{text:'같은 회의 ID의 다른 복사본: '+e.conflicts.join(' · ')});const input=row.createEl('input',{type:'text',attr:{placeholder:'이동한 세션 폴더의 절대 경로','aria-label':'회의 폴더'}});const status=row.createEl('p');row.createEl('button',{text:'확인하고 연결'}).addEventListener('click',()=>{void Promise.resolve().then(()=>{if(this.bridge&&this.meeting?.id===id)throw new Error('회의 종료 후 저장 위치를 연결하세요.');return this.registry!.link(id,input.value.trim());}).then(async()=>{if(this.meeting?.id===id){this.meeting.directory=await this.registry!.directory(id);this.settings.lastSession=this.meeting.directory;await this.saveData(this.settings);}status.setText('기존 녹음과 교정 정보를 확인해 연결했습니다.');}).catch(e=>status.setText(String(e)));});}modal.open();}
  private root():string {
    if(!this.settings.storage || !isAbsolute(this.settings.storage)) throw new Error('설정에서 Vault 외부의 절대 저장 경로를 지정하세요.');
    const adapter=this.app.vault.adapter;
    if(!(adapter instanceof FileSystemAdapter)) throw new Error('데스크톱 파일 시스템이 필요합니다.');
    const vault=adapter.getBasePath();
    const storage=this.settings.storage.replace(/\/+$/,'');
    if(storage===vault||storage.startsWith(vault+'/')) throw new Error('오디오와 모델은 Vault 외부에 보관하세요.');
    return storage;
  }
  private validate(){
    if(this.bridge||this.summaryBusy) throw new Error('진행 중인 전사와 AI 정리가 끝날 때까지 기다리세요.');
    if(!isAbsolute(this.settings.model)) throw new Error('로컬 MLX 모델 폴더의 절대 경로가 필요합니다.');
    this.root();
    if(!this.settings.communityPython||!this.settings.communityModel||!this.settings.alignerModel)throw new Error('설정에서 Community-1 Python·로컬 모델·대사 정렬 모델을 연결하세요.');
  }
  async start(inputWav?:string){
    if(this.transitioning)return;
    this.validate();this.transitioning=true;
    try {
    await this.writes;
    if(inputWav!==undefined && !isAbsolute(inputWav))throw new Error('설정에서 테스트 WAV 절대 경로를 지정하세요.');
    let note=inputWav?this.app.workspace.getActiveFile():null;
    if(inputWav&&(!(note instanceof TFile)||note.extension!=='md')) throw new Error('회의를 기록할 Markdown 노트를 먼저 여세요.');
    const adapter=this.app.vault.adapter as FileSystemAdapter;
    const audioHelper=join(adapter.getBasePath(),this.manifest.dir!,'native','Local Meeting Audio.app','Contents','MacOS','LocalMeetingAudio');
    const [darwinMajor=0,darwinMinor=0]=osRelease().split('.').map(Number);const audioAvailable=process.platform==='darwin'&&(darwinMajor>23||darwinMajor===23&&darwinMinor>=2)&&existsSync(audioHelper);let audioOptions:{pid:number;name:string}[]=[];
    if(!inputWav&&this.settings.pendingStartDirectory){await this.openPendingStart();return;}
    if(!inputWav&&audioAvailable)try{const {stdout}=await promisify(execFile)(audioHelper,['--list'],{timeout:5000,maxBuffer:65536});const data:unknown=JSON.parse(stdout);if(Array.isArray(data))audioOptions=data.filter((v):v is {pid:number;name:string}=>!!v&&Number.isSafeInteger(v.pid)&&v.pid>0&&typeof v.name==='string').slice(0,100);}catch{}
    const participantLimit=inputWav?{count:this.settings.expectedSpeakers,mode:this.settings.speakerCountMode,audio:'microphone' as const,voiceProfiles:false,liveSpeakers:false,folder:''}:await MeetingSetupModal.ask(this.app,{count:this.settings.expectedSpeakers,mode:this.settings.speakerCountMode,voiceProfiles:this.settings.voiceProfilesEnabled,folder:this.settings.meetingFolder},audioOptions,audioAvailable);
    if(!participantLimit)return;
    if(participantLimit.audio!=='microphone'&&this.settings.device.trim())throw new Error('시스템 오디오는 현재 기본 마이크에서만 지원합니다. 설정의 입력 장치 번호를 비워 주세요.');
    if(participantLimit.audio==='app'&&(!Number.isSafeInteger(participantLimit.audioPid)||(participantLimit.audioPid??0)<=0))throw new Error('녹음할 앱을 다시 선택하세요.');
    this.sessionAudio=participantLimit.audio==='microphone'?undefined:{helper:audioHelper,...(participantLimit.audio==='app'?{pid:participantLimit.audioPid}:{})};
    const id=randomUUID(),started=new Date().toISOString(),directory=join(this.root(),id);
    await mkdir(directory,{recursive:true});
    const dictionary=await this.dictionary().request({type:'snapshot',project:this.settings.dictionaryProject,meeting:id,enabled:this.settings.dictionaryEnabled});
    const modelConfig=await readFile(join(this.settings.model,'config.json'),'utf8');
    await writeFile(join(directory,'pipeline.json'),JSON.stringify({schemaVersion:3,workflow:'text-then-community',streamingSTT:true,retranscribeAfterStop:true,audioMode:participantLimit.audio,voiceProfiles:participantLimit.voiceProfiles,liveSpeakers:participantLimit.liveSpeakers,dictionary:dictionary.snapshot,speakerCount:participantLimit.count,speakerCountMode:participantLimit.mode,asrConfigHash:createHash('sha256').update(modelConfig).digest('hex'),pluginVersion:this.manifest.version},null,2));
    if(!inputWav){this.settings.meetingFolder=meetingFolder(participantLimit.folder);this.settings.pendingStartDirectory=directory;await this.saveData(this.settings);const intent:NotePreparation={folder:this.settings.meetingFolder,started};const path=await createMeetingNote({kind:p=>{const f=this.app.vault.getAbstractFileByPath(p);return f instanceof TFolder?'folder':f instanceof TFile?'file':undefined;},mkdir:p=>this.app.vault.createFolder(p),create:(p,t)=>this.app.vault.create(p,t)},intent,()=>writeFile(join(directory,'note-preparation.json'),JSON.stringify(intent,null,2)));const created=this.app.vault.getAbstractFileByPath(path);note=created instanceof TFile?created:null;}
    if(!(note instanceof TFile))throw new Error('새 회의록 문서를 확인하지 못했습니다. 준비 기록을 확인하세요.');
    if(!inputWav)this.settings.voiceProfilesEnabled=participantLimit.voiceProfiles;
    this.meeting={id,note:note.path,directory,started,speakers:{},segments:[],rendered:{},paragraphPauseMs:this.settings.paragraphPauseSeconds*1000,pipelineVersion:3,transcriptMode:'text-only',presentation:'ghost',speakerCount:participantLimit.count,speakerCountMode:participantLimit.mode,dictionaryRevision:dictionary.snapshot.revision};
    await this.saveMeeting();
    this.settings.lastSession=directory;this.settings.pendingStartDirectory='';await this.saveData(this.settings);if(!inputWav)await this.app.workspace.getLeaf(false).openFile(note);
    this.meeting.noteSnapshot=await this.app.vault.read(note);
    this.summaryAudio?.stop();this.showPreview();this.launch(false,inputWav);
    } finally {this.transitioning=false;}
  }
  async recover(){
    if(this.transitioning)return;
    this.validate();this.transitioning=true;
    try {
    await this.writes;
    if(!this.settings.lastSession) throw new Error('복구할 세션이 없습니다.');
    const directory=this.settings.lastSession,id=basename(directory);const resolved=this.registry&&validSession(id)?await this.registry.directory(id):directory;
    const data=JSON.parse(await readFile(join(resolved,'meeting.json'),'utf8')) as Meeting;data.directory=resolved;data.note=this.registry?.resolveNote(data.id,data.note)??data.note;
    if(!data.id||!data.note||!Array.isArray(data.segments)||data.directory!==resolved) throw new Error('잘못된 세션 파일');
    if(!(this.app.vault.getAbstractFileByPath(data.note) instanceof TFile)) throw new Error('원래 회의 노트를 찾을 수 없습니다.');
    this.meeting=data;await this.migrateCurrentNote();this.launch(true);
    } finally {this.transitioning=false;}
  }
  async numberUnknownSpeakers(){await this.reviewWrite(async()=>{const m=this.meeting;if(!m||this.bridge)throw new Error('회의 종료 후 실행하세요.');if(!await this.editors.ready(m.note))throw new Error('편집기가 사용 중입니다. 입력을 마친 뒤 다시 시도하세요.');const file=this.app.vault.getAbstractFileByPath(m.note);if(!(file instanceof TFile))throw new Error('회의 노트를 찾을 수 없습니다.');const doc=this.editors.find(m.note)?.state.doc.toString()??await this.app.vault.read(file);if(m.noteSnapshot!==undefined)rebaseAnchors(m,m.noteSnapshot,doc);const backup=structuredClone(m),ids=numberCandidateGroups(m);try{if(ids.length)await this.renderSegments(ids,'speaker');else await this.saveMeeting();}catch(e){if(!(e as {noteCommitted?:boolean}).noteCommitted)this.meeting=backup;throw e;}this.refresh(true);new Notice(ids.length?`${ids.length}개 발언에 음성 그룹별 화자 번호를 표시했습니다.`:'번호를 표시할 미확정 음성 그룹이 없습니다.');});}
  async reanalyseSpeakers(){
    if(this.bridge||this.transitioning||this.summaryBusy)throw new Error('진행 중인 녹음과 처리가 끝난 뒤 실행하세요.');
    if(!this.meeting)throw new Error('불러온 회의가 없습니다.');
    if(this.registry)this.meeting.directory=await this.registry.directory(this.meeting.id);
    if(!existsSync(join(this.meeting.directory,'recording.wav')))throw new Error('회의 전체 WAV가 없습니다.');
    this.transitioning=true;
    try{await this.writes;await this.saveMeeting();this.launch(true,undefined,true);}finally{this.transitioning=false;}
  }
  private launch(resume:boolean,inputWav?:string,refineOnly=false,retryStage?:string){
    const meeting=this.meeting!;
    const adapter=this.app.vault.adapter as FileSystemAdapter;
    const script=join(adapter.getBasePath(),this.manifest.dir!,'worker','main.py');
    this.error='';this.state=resume?'복구 중':'녹음 시작 중';this.closing=refineOnly;
    this.protocol=0;this.diagnostics={};
    const bridge=new WorkerBridge(event=>{if(this.bridge===bridge)this.receive(event,meeting.id);},()=>{
      if(this.meeting?.id!==meeting.id||this.bridge!==bridge)return;
      this.bridge=undefined;this.state='종료';this.refresh();this.writes=this.writes.then(()=>this.saveMeeting()).catch(error=>this.showError(String(error)));
      void this.writes.then(async()=>{if(this.meeting?.id===meeting.id&&!retryStage&&meeting.pipelineVersion===3&&meeting.speakerPassId&&!this.error&&this.settings.aiAutoSummary)await this.generateSummary(true);}).catch(error=>this.showError(String(error)));
    });
    this.bridge=bridge;
    try {bridge.start(this.settings.python,script,this.settings.model,meeting.directory,resume,this.settings.device,inputWav,resume&&!refineOnly&&(meeting.pipelineVersion??0)<3,refineOnly,{python:this.settings.communityPython,model:this.settings.communityModel,aligner:this.settings.alignerModel,...(refineOnly?{count:meeting.speakerCount??this.settings.expectedSpeakers,mode:meeting.speakerCountMode??this.settings.speakerCountMode}:{})},resume||inputWav?undefined:this.sessionAudio,retryStage);}
    catch(error){this.bridge=undefined;this.state='오류';throw error;}
    this.refresh();
  }
  receive(event:WorkerEvent,expectedSession=this.meeting?.id){
    if(!this.meeting||this.meeting.id!==expectedSession)return;
    if('session'in event&&event.session&&event.session!==expectedSession)return;
    if(event.type==='postprocess_stage'){this.writes=this.writes.then(async()=>{if(this.meeting?.id!==expectedSession)return;await this.ledger().mark(event.stage,{inputKey:event.inputKey,status:event.status,artifact:event.artifact,message:event.message,cached:event.cached});if(event.stage==='rescan'&&event.artifact&&['succeeded','waiting_input'].includes(event.status)){const data=JSON.parse(await readFile(join(this.meeting!.directory,event.artifact),'utf8'));if(typeof data.candidateFile==='string'&&data.candidateFile.startsWith('postprocess/artifacts/')&&!data.candidateFile.split('/').includes('..')){this.meeting!.retranscriptionFiles=[...new Set([...(this.meeting!.retranscriptionFiles??[]),data.candidateFile])];await this.loadRetranscriptions();await this.saveMeeting();}}}).catch(e=>this.showError(String(e)));}
    if(event.type==='error'){this.showError(event.message);return;}
    if(event.type==='capture_clock'){this.diagnostics={...this.diagnostics,samples:event.samples,sampleRate:event.rate,captureWallTimeMs:event.wallTimeMs};}
    if(event.type==='hello'){this.protocol=event.protocol;}
    if(event.type==='config_applied'){this.meeting.dictionaryRevision=event.revision;this.writes=this.writes.then(()=>this.saveMeeting()).catch(e=>this.showError(String(e)));}
    if(event.type==='status'){if(event.state.includes('종료 후 화자'))this.closing=true;this.state=event.state;this.pending=event.pending;this.lag=event.pendingAudioSeconds??event.lag;if(event.diagnostics){const old=Number(this.diagnostics.captureWallTimeMs??0);this.diagnostics={...this.diagnostics,...event.diagnostics,...(old>Number(event.diagnostics.captureWallTimeMs??0)?{samples:this.diagnostics.samples,sampleRate:this.diagnostics.sampleRate,captureWallTimeMs:old}:{})};}}
    if(event.type==='ready'){if((this.meeting.pipelineVersion??0)>=2&&this.protocol!==2){this.showError('워커 버전이 맞지 않습니다. 녹음을 중지합니다.');this.stop();return;}this.state='전사 준비 완료';}
    if(event.type==='speaker_refinement'){
      this.writes=this.writes.then(async()=>{
        const meeting=this.meeting;if(!meeting||meeting.id!==expectedSession)return;
        if((meeting.refinementApplicationId??meeting.speakerPassId)===(event.applicationId??event.passId)){if(this.persistFailed)await this.saveMeeting();if(meeting.presentation&&meeting.presentation!=='document')await this.finishPreview();return;}
        meeting.voiceFeaturesArtifact=event.voiceFeaturesArtifact;
        if(!await this.editors.ready(meeting.note))throw new Error('편집기가 종료되어 화자 적용을 보류했습니다. 세션 복구로 재시도하세요.');
        const file=this.app.vault.getAbstractFileByPath(meeting.note);if(!(file instanceof TFile))throw new Error('회의 노트를 찾을 수 없습니다.');
        const doc=this.editors.find(meeting.note)?.state.doc.toString()??await this.app.vault.read(file);
        if(meeting.noteSnapshot!==undefined)rebaseAnchors(meeting,meeting.noteSnapshot,doc);
        const backup=structuredClone(meeting);
        const backupPath=join(meeting.directory,`meeting.pre-speaker-${event.passId.slice(0,8)}.json`);
        if(!existsSync(backupPath))await writeFile(backupPath,JSON.stringify(backup,null,2),{flag:'wx'});
        const expected=(meeting.speakerCount??this.settings.expectedSpeakers)||Object.keys(meeting.speakers).filter(id=>!['unknown','overlap'].includes(id)&&!id.startsWith('final_')).length;
        if(meeting.presentation&&meeting.presentation!=='document'){
          refinePreview(meeting,event,expected);await this.loadRetranscriptions();await this.applyVoiceAutoMatches(meeting).catch(e=>{new Notice('프로필 비교를 보류했습니다. '+String(e),8000);return [];});await this.saveMeeting();await this.finishPreview();if((meeting.presentation as string)==='document'){await this.collectConfirmedVoice(meeting);await this.collectAutoVoice(meeting).catch(e=>new Notice('음성 특징 자동 수집을 보류했습니다. '+String(e),8000));}
          this.refresh(true);return;
        }
        splitAlignedSpeakers(meeting,event,doc);
        const ids=refineSpeakers(meeting,event,expected);await this.loadRetranscriptions();ids.push(...await this.applyVoiceAutoMatches(meeting).catch(e=>{new Notice('프로필 비교를 보류했습니다. '+String(e),8000);return [];}));
        try{await this.ledger().lock(()=>this.ledger().track('commit',[meeting.id,event.applicationId??event.passId],()=>this.renderSegments(ids,'speaker')));}
        catch(e){if(!(e as {noteCommitted?:boolean}).noteCommitted)this.meeting=backup;throw e;}
        await this.collectConfirmedVoice(meeting);
        await this.collectAutoVoice(meeting).catch(e=>new Notice('음성 특징 자동 수집을 보류했습니다. '+String(e),8000));

        this.refresh(true);
      }).catch(error=>this.showError(String(error)));
    }
    if(event.type==='segment'){
      this.writes=this.writes.then(async()=>{
        const meeting=this.meeting;if(!meeting||meeting.id!==expectedSession)return;
        const view=this.editors.find(meeting.note);if(view&&meeting.noteSnapshot!==undefined)rebaseAnchors(meeting,meeting.noteSnapshot,view.state.doc.toString());
        if(meeting.pipelineVersion===3&&meeting.speakerPassId){if(event.segment.revision)this.bridge?.command({type:'ack',id:event.segment.id,revision:event.segment.revision});return;}
        const index=meeting.segments.findIndex(s=>s.id===event.segment.id);
        if(index<0&&!event.segment.text.trim()){if(event.segment.revision)this.bridge?.command({type:'ack',id:event.segment.id,revision:event.segment.revision});return;}
        const accepted=acceptRevision(meeting,event.segment),previous=index>=0?meeting.segments[index]:undefined;
        if(accepted){
          if(/^live_\d+$/.test(accepted.segment.speaker))meeting.speakers[accepted.segment.speaker]??='잠정 화자 '+accepted.segment.speaker.slice(5);
          if(index>=0)meeting.segments[index]=accepted.segment;else meeting.segments.push(accepted.segment);
          try{await this.renderSegments([event.segment.id],accepted.mode,false);}catch(e){if(!(e as {noteCommitted?:boolean}).noteCommitted){if(previous)meeting.segments[index]=previous;else meeting.segments=meeting.segments.filter(s=>s.id!==event.segment.id);}throw e;}
        }else if(this.persistFailed)await this.saveMeeting();
        if(event.segment.revision)this.bridge?.command({type:'ack',id:event.segment.id,revision:event.segment.revision});
      }).catch(error=>this.showError(String(error)));
    }
    this.refresh();
  }
  private async registerSummaryAudio(meeting:Meeting){
    this.audioIndex?.register(meeting.aiSummary?.note,meeting.id);
    // Earlier hash-named summaries can be linked reliably through this session's saved result files.
    try{for(const name of await readdir(meeting.directory)){const match=name.match(/^ai-summary-([a-f0-9]{64})-([a-f0-9]{8})\.json$/);if(!match)continue;const note=normalizePath(join(dirname(meeting.note),`${basename(meeting.note,'.md')} - AI 정리 (${match[1]!.slice(0,8)} ${match[2]!.slice(0,4)}).md`));if(this.app.vault.getAbstractFileByPath(note) instanceof TFile)this.audioIndex?.register(note,meeting.id);}}catch{}
    await this.audioIndex?.flush();
  }
  private async saveMeeting(){
    const meeting=this.meeting;if(!meeting)return;
    if(!await this.editors.ready(meeting.note))return;
    const cm=this.editors.find(meeting.note),info=cm?.state.field(editorInfoField,false);
    const editorView=this.app.workspace.getLeavesOfType('markdown').map(leaf=>leaf.view).find(view=>view instanceof MarkdownView&&view.file?.path===meeting.note&&view.editor===info?.editor);
    // Persist the editor before its matching metadata, without reading/writing a stale disk copy.
    const snapshot=JSON.stringify(meeting,null,2);
    try{if(editorView instanceof MarkdownView)await editorView.save();const file=join(meeting.directory,'meeting.json');await writeFile(file+'.tmp',snapshot);await rename(file+'.tmp',file);this.audioIndex?.register(meeting.aiSummary?.note,meeting.id);await this.audioIndex?.flush();await this.registry?.register(meeting);this.persistFailed=false;}catch(e){this.persistFailed=true;throw e;}
  }
  private async renderSegments(ids:string[],mode:'normal'|'time'|'speaker'='normal',checkpoint=true){
    const meeting=this.meeting;if(!meeting)return;
    if(meeting.presentation&&meeting.presentation!=='document'){this.showPreview();if(checkpoint||this.persistFailed)await this.saveMeeting();else if(!this.checkpointTimer){const id=meeting.id;this.checkpointTimer=setTimeout(()=>{this.checkpointTimer=undefined;if(this.meeting?.id===id)this.writes=this.writes.then(()=>this.saveMeeting()).catch(e=>this.showError(String(e)));},3000);}this.refresh();return;}
    const file=this.app.vault.getAbstractFileByPath(normalizePath(meeting.note));
    if(!(file instanceof TFile))throw new Error('회의 대상 노트를 찾을 수 없습니다. 원본 오디오는 저장됩니다.');
    if(!await this.editors.ready(meeting.note))return;
    const old={...meeting.rendered};const oldAnchors=structuredClone(meeting.anchors);const oldSnapshot=meeting.noteSnapshot;let committed=false;
    try {
      const view=this.editors.find(meeting.note);
      if(view){const plan=transcriptChanges(view.state.doc.toString(),meeting,ids,this.settings.showTime,mode,true);this.editors.apply(view,plan.changes);}
      else {let opened=false;await this.app.vault.process(file,text=>{if(this.editors.find(meeting.note)){opened=true;return text;}return transcriptChanges(text,meeting,ids,this.settings.showTime,mode).text;});if(opened){await this.renderSegments(ids,mode);return;}}
      committed=true;await this.saveMeeting();
    }catch(error){if(!committed){meeting.rendered=old;meeting.anchors=oldAnchors;meeting.noteSnapshot=oldSnapshot;}throw Object.assign(error instanceof Error?error:new Error(String(error)),{noteCommitted:committed});}
    this.refresh();
  }
  private showPreview(){const m=this.meeting;if(m&&m.presentation&&m.presentation!=='document')this.editors.preview(m.note,m.id,previewText(m,this.settings.showTime),m.presentation==='committing');}
  private async finishPreview(){const m=this.meeting;if(!m?.presentation||m.presentation==='document')return;await this.ledger().lock(()=>this.ledger().track('commit',[m.id,m.refinementApplicationId,m.segments.map(s=>[s.id,s.revision,s.userRevision])],()=>this.finishPreviewBody()));}
  private async finishPreviewBody(){
    const m=this.meeting;if(!m?.presentation||m.presentation==='document')return;
    const file=this.app.vault.getAbstractFileByPath(m.note);if(!(file instanceof TFile))throw new Error('회의 노트를 찾을 수 없습니다. 임시 전사는 저장돼 있습니다.');
    m.presentation='committing';await this.saveMeeting();this.state='확정 기록 작성 중';this.refresh();
    if(!await this.editors.finalPreview(m.note,m.id,previewText(m,this.settings.showTime)))return;
    // Write ahead the exact document change; recovery can distinguish an applied write from a pending one.
    for(;;){
      if(!await this.editors.ready(m.note))return;
      const view=this.editors.find(m.note),before=view?.state.doc.toString()??await this.app.vault.read(file),plan=planPreviewCommit(m,before,this.settings.showTime);
      m.previewCommit={before,after:plan.after,rendered:plan.rendered,anchors:plan.anchors};await this.saveMeeting();
      const current=this.editors.find(m.note);if(current){if(current.state.doc.toString()!==before)continue;this.editors.apply(current,plan.changes);}
      else {let applied=false;await this.app.vault.process(file,text=>{if(text!==before||this.editors.find(m.note))return text;applied=true;return plan.after;});if(!applied)continue;}
      m.rendered=plan.rendered;m.anchors=plan.anchors;m.noteSnapshot=plan.after;m.presentation='document';delete m.previewCommit;
      this.editors.clearPreview(m.note);await this.saveMeeting();this.state='전사 확정 완료';this.refresh(true);return;
    }
  }
  updateSpeaker(id:string,name:string){
    this.writes=this.writes.then(async()=>{const m=this.meeting;if(!m)return;const previous=m.speakers[id];m.speakers[id]=name.trim()||id;if(m.speakerCandidates?.[id]&&!/^화자 \d+$/.test(m.speakers[id]!))delete m.speakerCandidates[id];m.voiceConfirmedSpeakers=[...new Set([...(m.voiceConfirmedSpeakers??[]),id])];await this.renderSegments(m.segments.filter(s=>s.speaker===id).map(s=>s.id),'speaker');if(previous&&previous!==name&&!/^화자 \d+$/.test(previous))await this.invalidateVoiceForSpeaker(m,id,false);await this.enrollVoiceSpeaker(m,id).catch(e=>new Notice('음성 프로필 수집을 보류했습니다. '+String(e),8000));this.refresh(true);}).catch(error=>this.showError(String(error)));
  }
  assignSpeaker(segmentId:string,speaker:string){
    this.writes=this.writes.then(async()=>{const m=this.meeting,s=m?.segments.find(s=>s.id===segmentId);if(!m||!s)return;const before=structuredClone(s),next=speaker.trim()||'unknown';if(before.speaker!==next)await this.invalidateVoiceForSegment(m,before);const userRevision=(s.userRevision??0)+1;s.history=[...(s.history??[]),{at:new Date().toISOString(),before:{text:s.text,speaker:s.speaker,textLocked:s.textLocked,speakerLocked:s.speakerLocked,speakerState:s.speakerState,suggestions:structuredClone(s.suggestions),reviewedRevision:s.reviewedRevision},afterText:s.text,afterSpeaker:next,userRevision}];s.userRevision=userRevision;s.speaker=next;s.speakerLocked=true;s.speakerState='manual';await this.renderSegments([s.id],'speaker');this.refresh(true);}).catch(error=>this.showError(String(error)));
  }
  async restoreRemovedGroups(){await this.reviewWrite(async()=>{const m=this.meeting;if(!m||this.bridge)throw new Error('회의 종료 후 실행하세요.');if(!await this.editors.ready(m.note))throw new Error('편집이 끝난 뒤 다시 시도하세요.');const f=this.app.vault.getAbstractFileByPath(m.note);if(!(f instanceof TFile))throw new Error('회의 원문을 찾을 수 없습니다.');const doc=this.editors.find(m.note)?.state.doc.toString()??await this.app.vault.read(f);if(m.noteSnapshot!==undefined)rebaseAnchors(m,m.noteSnapshot,doc);const backup=structuredClone(m),preview=structuredClone(m);if(!restoreDeletedGroups(preview).length){new Notice('복구할 수 있는 미연결 음성 그룹이 없습니다.');return;}const base=join(m.directory,`before-speaker-recovery-${Date.now()}`);await writeFile(base+'.note.md',doc,{mode:0o600,flag:'wx'});await writeFile(base+'.meeting.json',JSON.stringify(backup),{mode:0o600,flag:'wx'});const ids=restoreDeletedGroups(m);try{await this.renderSegments(ids,'speaker');}catch(e){if(!(e as {noteCommitted?:boolean}).noteCommitted)this.meeting=backup;throw e;}new Notice(`${ids.length}개 발언의 음성 그룹을 복구했습니다. 이름 연결은 직접 선택해 주세요.`,10000);this.refresh(true);});}
  async deleteParticipant(id:string,target:string){await this.reviewWrite(async()=>{const m=this.meeting;if(!m||this.bridge)throw new Error('녹음과 후처리가 끝난 뒤 삭제하세요.');if(!await this.editors.ready(m.note))throw new Error('입력을 마친 뒤 다시 시도하세요.');const f=this.app.vault.getAbstractFileByPath(m.note);if(!(f instanceof TFile))throw new Error('회의 노트를 찾을 수 없습니다.');const doc=this.editors.find(m.note)?.state.doc.toString()??await this.app.vault.read(f);if(m.noteSnapshot!==undefined)rebaseAnchors(m,m.noteSnapshot,doc);const preview=structuredClone(m);removeParticipant(preview,id,target);const backup=structuredClone(m);await this.invalidateVoiceForSpeaker(m,id);const ids=removeParticipant(m,id,target);try{if(ids.length)await this.renderSegments(ids,'speaker');else await this.saveMeeting();}catch(e){if(!(e as {noteCommitted?:boolean}).noteCommitted)this.meeting=backup;throw e;}this.refresh(true);});}
  async connectCandidate(candidate:string,target:string){await this.reviewWrite(async()=>{
    const m=this.meeting;if(!m||this.bridge)throw new Error('후처리가 끝난 뒤 연결하세요.');const group=candidateGroups(m).find(c=>c.id===candidate);if(!group)throw new Error('연결할 음성 그룹이 없습니다.');
    if(!target)throw new Error('참여자를 선택하거나 새 이름을 입력하세요.');if(!group.segments.some(s=>!s.speakerLocked&&!m.anchors?.[s.id]?.locked&&!m.anchors?.[s.id]?.deleted))throw new Error('직접 수정·지정한 발언만 남아 있습니다. 개별 발언에서 확인해 주세요.');const backup=structuredClone(m);let id=target;
    if(target.startsWith('name:')){const name=target.slice(5).trim();if(!name||name.length>60)throw new Error('이름은 1~60자로 입력하세요.');id='manual_'+randomUUID();m.speakers[id]=name;}
    else if(!participantIds(m).includes(id))throw new Error('기존 참여자를 선택하세요.');
    m.voiceConfirmedSpeakers=[...new Set([...(m.voiceConfirmedSpeakers??[]),id])];
    const ids:string[]=[];for(const segment of group.segments){const a=m.anchors?.[segment.id];if(segment.speakerLocked||a?.locked||a?.deleted)continue;segment.speaker=id;segment.speakerLocked=true;segment.speakerState='manual';segment.reviewReasons=segment.reviewReasons?.filter(r=>!r.includes('화자')&&!r.includes('음성 그룹'));ids.push(segment.id);}
    for(const [cluster,local] of Object.entries(m.speakerClusters??{}))if(local===candidate)m.speakerClusters![cluster]=id;
    if(!m.segments.some(s=>s.speaker===candidate)){delete m.speakerCandidates?.[candidate];delete m.speakers[candidate];}
    try{await this.renderSegments(ids,'speaker');}catch(e){if(!(e as {noteCommitted?:boolean}).noteCommitted)this.meeting=backup;throw e;}await this.enrollVoiceSpeaker(m,id).catch(e=>new Notice('음성 프로필 수집을 보류했습니다. '+String(e),8000));this.refresh(true);
  });}
  voiceProfiles(){const root=this.qualityRoot();if(this.voiceRoot!==root){this.voiceRoot=root;this.voiceStore=new VoiceProfiles(root);}return this.voiceStore!;}
  async voiceFeatures(m=this.meeting):Promise<VoiceFeatures|null>{if(!m||!m.speakerPassId)return null;try{const config=JSON.parse(await readFile(join(m.directory,'pipeline.json'),'utf8'));if(config.voiceProfiles!==true)return null;return validateFeatures(JSON.parse(await readFile(join(m.directory,m.voiceFeaturesArtifact??'voice-features.json'),'utf8')),m.id,m.speakerPassId);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
  private async applyVoiceAutoMatches(m:Meeting):Promise<string[]>{
    if(!this.settings.voiceAutoThreshold.trim()||!this.settings.voiceAutoMargin.trim())return [];
    const features=await this.voiceFeatures(m);if(!features)return [];const store=this.voiceProfiles(),choices=[];
    for(const f of features.items){const local=m.speakerClusters?.[f.cluster];if(!local||m.speakerClusterConflicts?.includes(f.cluster))continue;const name=m.speakers[local];if(name&&!/^화자 \d+$/.test(name))continue;const matches=await store.match(features,f.cluster),best=autoMatch(matches,f.speechMs,this.settings.voiceAutoThreshold,this.settings.voiceAutoMargin);if(best)choices.push({feature:f,local,best});}
    const changed:string[]=[];for(const choice of choices){if(choices.filter(x=>x.best.profileId===choice.best.profileId).length!==1)continue;const {feature,local,best}=choice,affected=m.segments.filter(s=>s.speaker===local||s.speaker==='unknown'&&s.candidates?.some(c=>c.speaker===local&&c.activity>=.85));if(affected.some(s=>s.speakerLocked&&s.speaker!==local)||!affected.some(s=>!s.speakerLocked&&!m.anchors?.[s.id]?.locked&&!m.anchors?.[s.id]?.deleted))continue;m.speakers[local]=best.name;delete m.speakerCandidates?.[local];m.voiceAutoAssignments??={};m.voiceAutoAssignments[feature.cluster]={profileId:best.profileId,name:best.name,score:best.score,passId:features.passId};for(const s of affected){const anchor=m.anchors?.[s.id];if(s.speakerLocked||anchor?.locked||anchor?.deleted)continue;s.speaker=local;s.speakerState='single';changed.push(s.id);}}
    return changed;
  }
  private async collectAutoVoice(m:Meeting){const features=await this.voiceFeatures(m);if(!features)return;for(const [cluster,match] of Object.entries(m.voiceAutoAssignments??{}))if(match.passId===features.passId&&!m.speakerClusterConflicts?.includes(cluster))await this.voiceProfiles().observe(match.profileId,features,cluster);}
  private async collectConfirmedVoice(m:Meeting){for(const id of m.voiceConfirmedSpeakers??[])await this.enrollVoiceSpeaker(m,id).catch(e=>new Notice('음성 프로필 수집을 보류했습니다. '+String(e),8000));}
  private async enrollVoiceSpeaker(m:Meeting,id:string,profileId?:string){const features=await this.voiceFeatures(m);if(!features)return;const names=Object.entries(m.speakerClusters??{}).filter(([,local])=>local===id).map(([cluster])=>cluster).filter(cluster=>!m.speakerClusterConflicts?.includes(cluster));if(names.length!==1)return;const cluster=names[0]!;const linked=m.segments.filter(s=>s.speaker===id||s.candidates?.some(c=>c.speaker===id&&c.activity>=.85));if(linked.some(s=>s.speakerLocked&&s.speaker!==id))return;const name=m.speakers[id];if(!name||/^화자 \d+$/.test(name))return;await this.voiceProfiles().enroll(name,features,cluster,profileId);}
  private async invalidateVoiceForSpeaker(m:Meeting,id:string,markConflict=true){if(!m.speakerPassId)return;const clusters=Object.entries(m.speakerClusters??{}).filter(([,local])=>local===id).map(([cluster])=>cluster);if(!clusters.length)return;for(const cluster of clusters)delete m.voiceAutoAssignments?.[cluster];if(markConflict)m.speakerClusterConflicts=[...new Set([...(m.speakerClusterConflicts??[]),...clusters])];await this.saveMeeting();for(const cluster of clusters)await this.voiceProfiles().invalidate(m.id,m.speakerPassId,cluster,markConflict);}
  private async invalidateVoiceForSegment(m:Meeting,segment:import('./model').Segment){const ids=new Set([segment.speaker,...(segment.candidates??[]).filter(c=>c.activity>=.85).map(c=>c.speaker)]);for(const id of ids)await this.invalidateVoiceForSpeaker(m,id);}
  async confirmVoiceCluster(cluster:string,profileId:string){await this.reviewWrite(async()=>{const m=this.meeting;if(!m||this.bridge)throw new Error('회의 후처리가 끝난 뒤 연결하세요.');const local=m.speakerClusters?.[cluster];if(!local||m.speakerClusterConflicts?.includes(cluster))throw new Error('충돌이 있는 음성 그룹은 개별 발언부터 수정해 주세요.');const profile=(await this.voiceProfiles().list()).find(p=>p.id===profileId&&p.enabled);if(!profile)throw new Error('사용 가능한 음성 프로필이 없습니다.');const prior=m.speakers[local];if(prior&&!/^화자 \d+$/.test(prior)&&prior!==profile.name)throw new Error('사용자가 이름을 지정한 그룹입니다. 기존 이름을 먼저 확인하세요.');const affected=m.segments.filter(s=>s.speaker===local||s.speaker==='unknown'&&s.candidates?.some(c=>c.speaker===local&&c.activity>=.85));if(affected.some(s=>s.speakerLocked&&s.speaker!==local))throw new Error('서로 다른 수동 화자가 있는 그룹입니다. 개별 발언을 확인해 주세요.');const backup=structuredClone(m);m.speakers[local]=profile.name;m.voiceConfirmedSpeakers=[...new Set([...(m.voiceConfirmedSpeakers??[]),local])];delete m.speakerCandidates?.[local];for(const s of affected){if(s.speakerLocked||m.anchors?.[s.id]?.locked||m.anchors?.[s.id]?.deleted)continue;s.speaker=local;s.speakerLocked=true;s.speakerState='manual';}try{await this.renderSegments(affected.map(s=>s.id),'speaker');}catch(e){if(!(e as {noteCommitted?:boolean}).noteCommitted)this.meeting=backup;throw e;}await this.enrollVoiceSpeaker(m,local,profileId);this.refresh(true);});}
  dictionary(){const adapter=this.app.vault.adapter as FileSystemAdapter;return new LocalDictionary(this.settings.python,join(adapter.getBasePath(),this.manifest.dir!,'worker/dictionary.py'),this.qualityRoot(),createHash('sha256').update(adapter.getBasePath()).digest('hex').slice(0,20));}
  async dictionaryChanged(){
    this.dictionaryUpdates=this.dictionaryUpdates.catch(()=>undefined).then(async()=>{await this.saveData(this.settings);const data=await this.dictionary().request({type:'snapshot',project:this.settings.dictionaryProject,meeting:this.meeting?.id??'',enabled:this.settings.dictionaryEnabled});
      if(this.bridge&&this.protocol===2)this.bridge.command({type:'dictionary',snapshot:data.snapshot});
      else new Notice(this.settings.dictionaryEnabled?'사전 설정을 저장했습니다. 새 회의부터 적용됩니다.':'사전 사용을 껐습니다.');this.refresh(true);
    });await this.dictionaryUpdates;
  }
  async exportDictionary(format:'json'|'csv'){const data=await this.dictionary().request({type:'export'});const folder=join(this.qualityRoot(),'.local-meeting-quality','exports');await mkdir(folder,{recursive:true});const target=join(folder,`dictionary-${Date.now()}.${format}`);await writeFile(target,format==='json'?JSON.stringify({schemaVersion:1,terms:data.terms},null,2):dictionaryCsv(data.terms));require('electron').shell.showItemInFolder(target);}
  private correctionCandidates(){const root=this.qualityRoot(),vault=(this.app.vault.adapter as FileSystemAdapter).getBasePath();const key=root+vault;if(this.candidatesRoot!==key){this.candidatesRoot=key;this.candidatesStore=new CorrectionCandidates(join(root,'.local-meeting-quality','correction-candidates-'+createHash('sha256').update(vault).digest('hex').slice(0,16)+'.json'));}return this.candidatesStore!;}
  async openCorrectionCandidates(){
    const m=this.meeting,store=this.correctionCandidates();if(m)for(const s of m.segments)if(s.history?.length)await store.observe(m.id,s);
    const candidates=await store.list(),modal=new Modal(this.app);modal.setTitle('반복 오인식 사전 후보');modal.contentEl.createEl('p',{text:'서로 다른 발언에서 2회 이상 확인된 교정을 모았습니다. 의미 수정일 수도 있으므로 확인 전에는 인식 규칙에 사용하지 않습니다.',cls:'lm-hint'});
    const visible=candidates.filter(c=>c.status==='pending');if(!visible.length)modal.contentEl.createEl('p',{text:'반복된 교정 후보가 없습니다. 발언 검토에서 대사를 교정하면 수집됩니다.'});
    for(const c of visible){const row=modal.contentEl.createEl('details');row.createEl('summary',{text:`${c.before} → ${c.after} · ${c.count}개 발언${c.conflict?' · 서로 다른 교정 있음':''}`});row.createEl('p',{text:'확인한 뒤 인식 힌트 또는 교정 제안으로 등록하세요.'});row.createEl('button',{text:'사전 등록 검토'}).addEventListener('click',()=>{void this.dictionary().request({type:'list'}).then(data=>new TermModal(this.app,this,data,undefined,async()=>{await store.status(c.id,'accepted');modal.close();},'',{canonical:c.after,observedErrors:[c.before]}).open()).catch(e=>new Notice(String(e)));});row.createEl('button',{text:'후보에서 제외'}).addEventListener('click',()=>{void store.status(c.id,'dismissed').then(()=>{row.remove();}).catch(e=>new Notice(String(e)));});}modal.open();
  }
  async markSuspect(id:string){await this.reviewWrite(async()=>{const s=this.meeting?.segments.find(s=>s.id===id);if(!s)throw new Error('발언이 없습니다.');s.suspect=true;this.bridge?.command({type:'suspect',id});await this.saveMeeting();new Notice('종료 후 재전사할 의심 구간으로 표시했습니다.');});}
  private async retranscriptionData(){const m=this.meeting;if(!m)return {items:{},pending:[]};const data:{items:Record<string,import('./model').Retranscription>;pending:string[]}={items:{},pending:[]};for(const path of ['retranscription.json',...(m.retranscriptionFiles??[])]){if(path!=='retranscription.json'&&(!path.startsWith('postprocess/')||path.split('/').includes('..')))throw new Error('잘못된 재전사 결과 경로');try{const next=JSON.parse(await readFile(join(m.directory,path),'utf8'));Object.assign(data.items,next.items??{});data.pending=next.pending??[];}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}return data;}
  private async loadRetranscriptions(){const m=this.meeting;if(!m)return;const data=await this.retranscriptionData();for(const s of m.segments){const candidate=data.items[s.id];if(candidate&&typeof candidate.text==='string'&&candidate.text.length<=10000&&candidate.start===s.start&&candidate.end===s.end){const state=s.retranscription?.text===candidate.text?s.retranscription!.state:'candidate';s.retranscription={...candidate,state};}}}
  async retranscribeSegment(id:string){
    const m=this.meeting;if(!m||this.bridge||this.summaryBusy)throw new Error('회의와 후처리가 끝난 뒤 실행하세요.');if(!m.segments.some(s=>s.id===id))throw new Error('발언이 없습니다.');
    const adapter=this.app.vault.adapter as FileSystemAdapter;const session=m.id;this.summaryBusy=true;this.refresh();
    const outputRelative='postprocess/manual-rescan/'+randomUUID(),output=join(m.directory,outputRelative);const target=m.segments.find(s=>s.id===id)!,request=join(m.directory,'retranscription-request-'+randomUUID()+'.json');
    try{await this.writes;await writeFile(request,JSON.stringify({id,start:target.start,end:target.end,text:target.text,rawText:target.rawText}),{mode:0o600});const {stdout}=await promisify(execFile)(this.settings.python,['-u',join(adapter.getBasePath(),this.manifest.dir!,'worker/retranscribe.py'),'--session',m.directory,'--model',this.settings.model,'--id',id,'--request',request,'--output-root',output],{timeout:180000,maxBuffer:8000000,env:{...process.env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'}});const result=JSON.parse(stdout);if(result.errors?.[id]||!result.items?.[id])throw new Error('재전사 후보를 만들지 못했습니다. 원음과 교정은 보존됩니다.');if(this.meeting?.id!==session)return;delete target.retranscription;m.retranscriptionFiles=[...(m.retranscriptionFiles??[]),outputRelative+'/retranscription.json'];await this.loadRetranscriptions();await this.saveMeeting();new Notice('재전사 후보를 만들었습니다. 원문과 화자 지정은 유지됩니다.');}finally{await unlink(request).catch(()=>{});this.summaryBusy=false;this.refresh(true);}
  }
  async openRetranscriptionCandidates(){await this.loadRetranscriptions();const m=this.meeting;if(!m)throw new Error('회의가 없습니다.');const modal=new Modal(this.app);modal.setTitle('종료 후 재전사 후보');try{const data=await this.retranscriptionData();if(!Object.keys(data.items).length)modal.contentEl.createEl('p',{text:'생성된 후보가 없습니다. 발언 검토에서 의심 구간을 표시하거나 종료 후 다시 전사할 수 있습니다.'});for(const [id,value] of Object.entries(data.items??{})){const c=value as import('./model').Retranscription,row=modal.contentEl.createEl('details');row.createEl('summary',{text:`${timestamp(c.start)}–${timestamp(c.end)} · ${c.reason}`});row.createEl('p',{text:'기존 인식: '+c.sourceText});row.createEl('p',{text:'동일 구간 재전사: '+c.text});if(c.contextText)row.createEl('p',{text:'전후 음성을 포함한 참고 후보 (인접 발언 포함): '+c.contextText});row.createEl('p',{text:m.segments.some(s=>s.id===id&&s.start===c.start&&s.end===c.end)?'발언 검토에서 후보를 확인·편집해 적용할 수 있습니다.':'최종 화자 분석으로 나뉜 원본 구간입니다. 각 발언을 직접 검토해 주세요.',cls:'lm-hint'});}if(data.pending?.length)modal.contentEl.createEl('p',{text:`이번 처리 한도를 넘긴 후보 ${data.pending.length}개는 보류됐습니다.`});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;modal.contentEl.createEl('p',{text:'생성된 후보가 없습니다. 발언 검토에서 의심 구간을 표시하거나 종료 후 다시 전사할 수 있습니다.'});}modal.open();}
  private async reviewWrite(action:()=>Promise<void>){const next=this.writes.then(action);this.writes=next.catch(e=>this.showError(String(e)));await next;}
  async reviewApply(id:string,revision:number,before:string,text:string,speaker:string){await this.reviewWrite(async()=>{
    const m=this.meeting,s=m?.segments.find(x=>x.id===id);if(!m||!s)throw new Error('현재 회의에 없는 발언입니다.');
    await this.editors.ready(m.note);const file=this.app.vault.getAbstractFileByPath(m.note);if(!(file instanceof TFile))throw new Error('회의 노트가 없습니다.');
    const doc=this.editors.find(m.note)?.state.doc.toString()??await this.app.vault.read(file);if(m.noteSnapshot!==undefined)rebaseAnchors(m,m.noteSnapshot,doc);
    if(m.anchors?.[id]?.locked||m.anchors?.[id]?.deleted)throw new Error('본문에서 직접 수정하거나 삭제한 발언입니다. 노트에서 확인해 주세요.');
    if(!['unknown','overlap',...m.segments.map(x=>x.speaker),...Object.keys(m.speakers)].includes(speaker))throw new Error('현재 회의의 참여자를 선택해 주세요.');
    const backup=structuredClone(s);reviewEdit(structuredClone(s),revision,before,text,speaker);if(backup.speaker!==speaker)await this.invalidateVoiceForSegment(m,backup);try{reviewEdit(s,revision,before,text,speaker);await this.renderSegments([id]);await this.correctionCandidates().observe(m.id,s).catch(e=>new Notice('교정 후보 수집 보류: '+String(e)));}catch(e){if(!(e as {noteCommitted?:boolean}).noteCommitted)m.segments[m.segments.indexOf(s)]=backup;throw e;}this.refresh(true);
  });}
  async reviewKeep(id:string,revision:number){await this.reviewWrite(async()=>{const s=this.meeting?.segments.find(x=>x.id===id);if(!s||(s.revision??0)!==revision)throw new Error('발언이 변경되었습니다. 새로고침해 주세요.');s.reviewedRevision=revision;if(s.retranscription)s.retranscription.state='dismissed';await this.saveMeeting();this.refresh(true);});}
  async reviewUndo(id:string){await this.reviewWrite(async()=>{const m=this.meeting,s=m?.segments.find(x=>x.id===id);if(!m||!s)throw new Error('발언이 없습니다.');await this.editors.ready(m.note);const file=this.app.vault.getAbstractFileByPath(m.note);if(!(file instanceof TFile))throw new Error('회의 노트가 없습니다.');const doc=this.editors.find(m.note)?.state.doc.toString()??await this.app.vault.read(file);if(m.noteSnapshot!==undefined)rebaseAnchors(m,m.noteSnapshot,doc);if(m.anchors?.[id]?.locked||m.anchors?.[id]?.deleted)throw new Error('본문 수정이 있어 자동으로 되돌릴 수 없습니다.');const backup=structuredClone(s),removedName=s.history?.at(-1)?.speakerNameBefore;try{undoReview(s);if(removedName&&!m.speakers[s.speaker])m.speakers[s.speaker]=removedName;await this.renderSegments([id]);await this.correctionCandidates().observe(m.id,s).catch(e=>new Notice('교정 후보 수집 보류: '+String(e)));}catch(e){if(!(e as {noteCommitted?:boolean}).noteCommitted)m.segments[m.segments.indexOf(s)]=backup;throw e;}this.refresh(true);});}
  async exportDiagnostics(){const m=this.meeting;if(!m)throw new Error('회의가 없습니다.');const target=join(m.directory,'diagnostics.json');await writeFile(target,JSON.stringify({schemaVersion:1,pluginVersion:this.manifest.version,pipelineVersion:m.pipelineVersion??1,session:m.id,diagnostics:this.diagnostics,segments:m.segments.length,review:m.segments.filter(needsReview).length,speakerCounts:m.segments.reduce<Record<string,number>>((counts,s)=>{counts[s.speaker]=(counts[s.speaker]??0)+1;return counts;},{})},null,2));require('electron').shell.showItemInFolder(target);}
  async exportEvaluation(){const m=this.meeting;if(!m)throw new Error('회의가 없습니다.');const target=join(m.directory,'reference-template.json');if(existsSync(target))throw new Error('기존 정답 양식을 덮어쓰지 않습니다. 파일명을 바꾼 뒤 다시 내보내세요.');await writeFile(target,JSON.stringify({schemaVersion:1,instructions:'원음을 듣고 referenceText와 referenceSpeakers를 채우세요. 비어 있는 양식은 정확도 점수를 계산하지 않습니다.',segments:m.segments.map(s=>({id:s.id,start:s.start,end:s.end,hypothesis:s.rawText??s.text,referenceText:null,referenceSpeakers:null}))},null,2),{flag:'wx'});require('electron').shell.showItemInFolder(target);}
  aiStatus(){return this.auth.status();}
  aiModels(){return this.auth.models();}
  aiCancel(){this.auth.cancel();}
  async aiLogin(add=false){await this.auth.login(add);if(await this.auth.welcome())new ChatGPTWelcomeModal(this.app).open();this.refresh(true);}
  async aiSelect(id:string){if(this.summaryBusy)throw new Error('AI 정리가 끝난 뒤 계정을 변경해 주세요.');await this.auth.select(id);this.settings.aiModel='';await this.saveAISettings();}
  async aiLogout(){const revoked=await this.auth.logout();this.settings.aiModel='';await this.saveAISettings();if(!revoked)new Notice('기기에서는 로그아웃했습니다. 원격 연결 해제를 확인하지 못했으므로 ChatGPT 설정에서 앱 접근을 해제할 수 있습니다.',12000);}
  async saveAISettings(){await this.saveData(this.settings);}
  private summaryFile(directory:string,sourceHash:string,model:string){return join(directory,`ai-summary-${sourceHash}-${createHash('sha256').update(model).digest('hex').slice(0,8)}.json`);}
  private termsFile(directory:string,sourceHash:string,model:string){return join(directory,`ai-terms-${sourceHash}-${createHash('sha256').update(model).digest('hex').slice(0,8)}.json`);}
  private reviews(){const m=this.meeting;if(!m)throw new Error('회의가 없습니다.');if(this.reviewDirectory!==m.directory){this.reviewDirectory=m.directory;this.reviewStore=new SummaryReviewStore(m.directory);}return this.reviewStore!;}
  async reviewItems(){const result=await this.currentSummary();return result?this.reviews().list(result):[];}
  async updateReview(id:string,edited:ReviewItem['edited'],status:ReviewItem['status']){await this.reviews().update(id,item=>{if(item.calendar?.state==='saving')throw new Error('일정 저장이 진행 중입니다.');item.edited=edited;item.status=status;});}
  async saveTermCandidate(item:ReviewItem,canonical:string,scope:'meeting'|'project'|'vault'|'personal'){
    if(item.kind!=='term'||!canonical.trim())throw new Error('용어를 확인해 주세요.');
    const dict=this.dictionary(),data=await dict.request({type:'list'}),scopeId=scope==='meeting'?this.meeting?.id:scope==='project'?this.settings.dictionaryProject:scope==='vault'?dict.vaultId:'shared';if(!scopeId)throw new Error('사전 적용 범위를 먼저 선택하세요.');
    const termId='ai_'+item.id.replace(/-/g,'');const candidate=item.edited as import('./ai-summary').MeetingTerm;
    const prior=data.terms.find(t=>t.canonical.normalize('NFC').toLocaleLowerCase()===canonical.trim().normalize('NFC').toLocaleLowerCase()&&t.scope.kind===scope&&t.scope.id===scopeId);
    if(prior&&prior.id!==termId)throw new Error('같은 범위에 이미 있는 용어입니다. 회의 사전에서 확인해 주세요.');
    if(!prior)await dict.request({type:'save',term:{id:termId,canonical,category:candidate.category,scope:{kind:scope,id:scopeId},pronunciations:[],observedErrors:[],contextTags:[],recognitionHint:true,postprocess:'hint',confirmedByUser:true,enabled:true}});
    await this.reviews().update(item.id,i=>{i.edited={...candidate,canonicalCandidate:canonical.trim()};i.dictionaryTermId=termId;i.status='accepted';});await this.dictionaryChanged();
  }
  async addReviewedTask(item:ReviewItem){
    const meeting=this.meeting;if(!meeting||item.kind!=='task')throw new Error('회의와 할 일을 확인하세요.');const store=this.reviews();
    const task=item.edited as import('./ai-summary').MeetingTask,clean=(s:string)=>s.replace(/[\r\n]+/g,' ').replace(/\\/g,'\\\\').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/([\[\]!])/g,'\\$1');
    if(!task.title.trim())throw new Error('할 일을 입력하세요.');
    const line=`\n- [ ] ${clean(task.title.trim())}${task.assignee?' · 담당: '+clean(task.assignee):''}${task.due?' · 기한: '+clean(task.due):''}\n`;
    await store.update(item.id,i=>{if(i.noteWrite)throw new Error('이미 처리했거나 기록 결과를 확인해야 합니다.');i.noteWrite={state:'saving',path:meeting.note};});
    try{await this.reviewWrite(async()=>{if(this.meeting?.id!==meeting.id)throw new Error('회의가 변경됐습니다.');const file=this.app.vault.getAbstractFileByPath(meeting.note);if(!(file instanceof TFile))throw new Error('회의 노트를 찾을 수 없습니다.');if(!await this.editors.ready(meeting.note))throw new Error('편집기가 종료됐습니다.');if(this.meeting?.id!==meeting.id)throw new Error('회의가 변경됐습니다.');
      const view=this.editors.find(meeting.note);if(view){view.dispatch({changes:{from:view.state.doc.length,insert:line}});await this.saveMeeting();}
      else{let opened=false;await this.app.vault.process(file,text=>{if(this.editors.find(meeting.note)){opened=true;return text;}return text+line;});if(opened)throw new Error('노트가 열렸습니다. 기록 결과를 확인해 주세요.');}
    });
      await store.update(item.id,i=>{i.noteWrite={state:'saved',path:meeting.note};i.status='accepted';});
    }catch(e){await store.update(item.id,i=>{if(i.noteWrite)i.noteWrite.state='unknown';}).catch(()=>{});throw new Error('할 일 기록 결과를 확인해 주세요. '+String(e));}
  }
  async currentSummary():Promise<SummaryResult|null>{const m=this.meeting;if(!m?.aiSummary)return null;try{const result:SummaryResult=JSON.parse(await readFile(this.summaryFile(m.directory,m.aiSummary.sourceHash,m.aiSummary.model),'utf8'));result.value.events=normalizeEvents(result.value.events,m.started);if(result.value.terms===undefined){try{const extra=JSON.parse(await readFile(this.termsFile(m.directory,result.sourceHash,result.model),'utf8'));if(extra.sourceHash===result.sourceHash&&extra.model===result.model&&Array.isArray(extra.terms))result.value.terms=validateSummary({...result.value,terms:extra.terms},new Set(m.segments.map(s=>s.id))).terms;}catch{}}return result;}catch{return null;}}
  async extractTerms(){const m=this.meeting,result=await this.currentSummary();if(!m||!result)throw new Error('저장된 정리 결과가 없습니다.');if(this.summaryBusy||this.bridge)throw new Error('진행 중인 작업이 끝난 뒤 다시 시도하세요.');if(result.value.terms!==undefined)throw new Error('이미 용어 후보가 있습니다.');if(await this.summaryChanged())throw new Error('원문이 변경됐습니다. 먼저 최신 내용으로 다시 정리하세요.');
    this.summaryBusy=true;this.refresh(true);try{const input=await this.currentInput(),generated=await requestSummary(input,result.model,await this.auth.access());if(generated.value.terms===undefined)throw new Error('용어 후보를 받지 못했습니다.');const target=this.termsFile(m.directory,result.sourceHash,result.model);await writeFile(target+'.tmp',JSON.stringify({sourceHash:result.sourceHash,model:result.model,terms:generated.value.terms},null,2),{mode:0o600});await rename(target+'.tmp',target);}finally{this.summaryBusy=false;this.refresh(true);}}
  async openTimedNotes(){
    const m=this.meeting;if(!m)throw new Error('회의가 없습니다.');const file=this.app.vault.getAbstractFileByPath(m.note);if(!(file instanceof TFile))return;
    const doc=this.editors.find(m.note)?.state.doc.toString()??await this.app.vault.read(file),modal=new Modal(this.app);modal.setTitle('필기 시점과 주변 발언');
    modal.contentEl.createEl('p',{text:'필기 시각 전후 10초의 발언입니다. 입력 시점은 발언과의 관련성이나 사실 여부를 보장하지 않습니다.',cls:'lm-hint'});
    const notes=timedNotes(m,doc);if(!notes.length)modal.contentEl.createEl('p',{text:'녹음 중 기록한 필기 시점이 없습니다. 새 회의부터 입력 시점을 기록합니다.'});
    for(const note of notes){const card=modal.contentEl.createEl('details');card.createEl('summary',{text:`${timestamp(note.start)} · ${note.text.slice(0,80)}`});card.createEl('p',{text:note.text});card.createEl('p',{text:`시간 오차 추정 ±${Math.ceil(note.uncertaintyMs/1000)}초`,cls:'lm-hint'});for(const id of note.nearbySpeech){const s=m.segments.find(s=>s.id===id)!;card.createEl('p',{text:`${timestamp(s.start)} ${m.speakers[s.speaker]??s.speaker}: ${s.text}`});}const start=Math.max(0,note.start-10000),end=Math.min(Number(this.diagnostics.samples||0)/Number(this.diagnostics.sampleRate||16000)*1000||Math.max(...m.segments.map(s=>s.end),note.end),note.end+10000);if(end>start)card.createEl('button',{text:'주변 녹음 듣기'}).addEventListener('click',()=>this.summaryAudio?.play(m.id,{start,end,label:`${timestamp(start)}–${timestamp(end)}`,from:0,to:0}));}
    modal.open();
  }
  private async currentInput(){const m=this.meeting;if(!m)throw new Error('회의가 없습니다.');const file=this.app.vault.getAbstractFileByPath(m.note);if(!(file instanceof TFile))throw new Error('회의 노트가 없습니다.');const doc=this.editors.find(m.note)?.state.doc.toString()??await this.app.vault.read(file);return summaryInput(m,doc);}
  async summaryChanged(){const m=this.meeting;if(!m?.aiSummary)return false;const input=await this.currentInput();const legacy=createHash('sha256').update(JSON.stringify({started:input.started,document:input.document,sources:input.sources})).digest('hex');return !!m.aiSummary.stale||![input.sourceHash,legacy].includes(m.aiSummary.sourceHash);}
  async reviewRanges(item:ReviewItem){const input=await this.currentInput();return playbackRanges(evidenceRanges(item.edited.evidence,input)).map(r=>r.label);}
  async playReviewRange(item:ReviewItem,index:number){const m=this.meeting;if(!m||!this.summaryAudio)throw new Error('회의 녹음을 찾을 수 없습니다.');const input=await this.currentInput(),range=playbackRanges(evidenceRanges(item.edited.evidence,input))[index];if(!range)throw new Error('녹음 구간을 찾을 수 없습니다.');this.summaryAudio.play(m.id,range);}
  private summaryDirectory(m:Meeting){const value=this.settings.summaryFolder.trim();if(!value)return dirname(m.note);if(value.startsWith('/')||value.split('/').some(part=>part==='..'))throw new Error('정리 저장 폴더는 Vault 내부의 상대 경로로 지정하세요.');const folder=normalizePath(value),entry=this.app.vault.getAbstractFileByPath(folder);if(!(entry instanceof TFolder))throw new Error('정리 저장 폴더가 없습니다. Obsidian에서 폴더를 만들거나 설정을 확인하세요.');return folder;}
  async refreshSummaryLayout(){const m=this.meeting;if(!m?.aiSummary)throw new Error('저장된 정리 노트가 없습니다.');const file=this.app.vault.getAbstractFileByPath(m.aiSummary.note);if(!(file instanceof TFile))throw new Error('기존 정리 노트를 찾을 수 없습니다.');if(!await this.editors.ready(file.path))throw new Error('편집을 마친 뒤 다시 시도하세요.');const doc=this.editors.find(file.path)?.state.doc.toString()??await this.app.vault.read(file),formatted=hoverRecordingRanges(wrapExistingRecordingRanges(doc));const base=normalizePath(join(this.summaryDirectory(m),`${basename(m.note,'.md')} - 회의 정리 (문장 재생).md`));let note=base,n=2;while(this.app.vault.getAbstractFileByPath(note))note=base.replace(/\.md$/,` ${n++}.md`);await this.app.vault.create(note,formatted);m.aiSummary={...m.aiSummary,note};await this.saveMeeting();await this.openSummary();}

  async createReviewedSummary(){const m=this.meeting,result=await this.currentSummary();if(!m||!result||!m.aiSummary)throw new Error('저장된 정리 결과가 없습니다.');const input=await this.currentInput(),items=await this.reviewItems();const visible=(kind:ReviewItem['kind'])=>items.filter(i=>i.kind===kind&&i.status!=='excluded').map(i=>i.edited);
    const value={...result.value,decisions:visible('decision') as typeof result.value.decisions,tasks:visible('task') as typeof result.value.tasks,events:visible('event') as typeof result.value.events,openQuestions:visible('question') as typeof result.value.openQuestions};
    const base=normalizePath(join(this.summaryDirectory(m),`${basename(m.note,'.md')} - 회의 정리 (검토).md`));let note=base,n=2;while(this.app.vault.getAbstractFileByPath(note))note=base.replace(/\.md$/,` ${n++}.md`);const stale=await this.summaryChanged();await this.app.vault.create(note,summaryMarkdown({...result,value},input,m.note,stale));m.aiSummary={...m.aiSummary,note,stale};await this.saveMeeting();await this.openSummary();}
  async openSummary(){const path=this.meeting?.aiSummary?.note,file=path?this.app.vault.getAbstractFileByPath(path):null;if(!(file instanceof TFile))throw new Error('생성된 정리 노트가 없습니다.');await this.app.workspace.getLeaf(false).openFile(file);}
  async openCalendarDraft(event:MeetingEvent){const adapter=this.app.vault.adapter as FileSystemAdapter;const raw=createHash('sha256').update(JSON.stringify([this.meeting?.id,this.meeting?.aiSummary?.sourceHash,event])).digest('hex').slice(0,32),uid=raw.slice(0,8)+'-'+raw.slice(8,12)+'-'+raw.slice(12,16)+'-'+raw.slice(16,20)+'-'+raw.slice(20);await openCalendarCandidate(this.app,join(adapter.getBasePath(),this.manifest.dir!,'native/calendar-bridge'),this.settings.calendarId,{...event,uid});}
  async openReviewedCalendar(item:ReviewItem,allowSimilar=false){
    if(item.kind!=='event')throw new Error('일정 후보가 아닙니다.');
    const current=(await this.reviewItems()).find(i=>i.id===item.id);if(!current)throw new Error('일정 후보를 찾을 수 없습니다.');
    if(current.calendar)throw new Error(current.calendar.state==='saved'?'이미 Mac 캘린더에 저장했습니다. 캘린더에서 확인하세요.':'이전 저장 결과를 확인하지 못했습니다. Mac 캘린더를 먼저 확인하세요.');
    if(current.similarSaved&&!allowSimilar)throw new Error('이름이 같은 저장된 일정이 있습니다. 다른 일정인지 확인해 주세요.');
    const store=this.reviews(),adapter=this.app.vault.adapter as FileSystemAdapter,event=current.edited as MeetingEvent;
    await openCalendarCandidate(this.app,join(adapter.getBasePath(),this.manifest.dir!,'native/calendar-bridge'),this.settings.calendarId,{...event,uid:item.id},{
      beforeSave:async calendarId=>{await store.update(item.id,i=>{if(i.calendar)throw new Error('저장 결과를 먼저 확인하세요.');i.calendar={state:'saving',uid:i.id,calendarId};});},
      onSaved:async (saved,values)=>{if(!saved.eventId||!saved.calendarId||saved.uid!==item.id)throw new Error('저장된 일정의 식별자를 확인하지 못했습니다.');await store.update(item.id,i=>{i.calendar={state:'saved',uid:i.id,eventId:saved.eventId,calendarId:saved.calendarId};i.edited={...(i.edited as MeetingEvent),title:values.title,start:values.start,end:values.end,date:meetingDay(values.start),endDate:meetingDay(values.allDay?new Date(Date.parse(values.end)-1).toISOString():values.end),allDay:values.allDay} as MeetingEvent;i.status='accepted';});},
      onFailure:async()=>{await store.update(item.id,i=>{if(i.calendar)i.calendar.state='unknown';});}
    });
  }
  async clearUncertainCalendar(item:ReviewItem){await this.reviews().update(item.id,i=>{if(!i.calendar||i.calendar.state==='saved')throw new Error('다시 시도할 일정이 아닙니다.');delete i.calendar;});}
  async clearUncertainTask(item:ReviewItem){await this.reviews().update(item.id,i=>{if(!i.noteWrite||i.noteWrite.state==='saved')throw new Error('다시 시도할 할 일이 아닙니다.');delete i.noteWrite;});}
  get isAIProcessing(){return this.summaryBusy;}
  async testAIConnection(){if(this.summaryBusy)throw new Error('AI 정리가 끝난 뒤 연결을 테스트해 주세요.');const models=await this.auth.models();if(!models.length)throw new Error('사용 가능한 모델이 없습니다.');const model=models.some(m=>m.id===this.settings.aiModel)?this.settings.aiModel:models[0]!.id;const result=await requestSummary({sourceHash:'connection-test-v2',started:'2026-10-27T00:00:00Z',document:'내일 검토회의, 모레 현장점검, 다음 주 월요일 결과 공유 회의를 합니다. 세 일정 모두 시각은 미정입니다.',sources:[]},model,await this.auth.access());const dates=result.value.events.map(e=>e.date);if(!['2026-10-28','2026-10-29','2026-11-02'].every(d=>dates.includes(d)))throw new Error('연결됐지만 상대 날짜 결과를 확인하지 못했습니다.');const path=join(this.root(),'.local-meeting-quality','openai-connection-test.json');await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify({tested:new Date().toISOString(),model,passed:true,dates},null,2));new Notice('OpenAI 연결·요약 형식·상대 날짜 변환을 확인했습니다.',10000);}

  async generateSummary(automatic=false){
    if(this.summaryBusy){if(automatic)return;throw new Error('AI 정리가 진행 중입니다.');}
    const m=this.meeting;if(!m||this.bridge||!m.speakerPassId||m.presentation&&m.presentation!=='document'){if(automatic)return;throw new Error('회의 종료 후 화자 구분이 완료된 뒤 정리할 수 있습니다.');}
    this.summaryBusy=true;this.error='';this.state='회의 정리 준비';this.refresh(true);
    try{await this.writes;if(!await this.editors.ready(m.note))throw new Error('편집기가 종료되어 정리를 보류했습니다.');
      await this.ledger().lock(async()=>{
        const file=this.app.vault.getAbstractFileByPath(m.note);if(!(file instanceof TFile))throw new Error('회의 노트가 없습니다.');
        const doc=this.editors.find(m.note)?.state.doc.toString()??await this.app.vault.read(file);if(m.noteSnapshot!==undefined)rebaseAnchors(m,m.noteSnapshot,doc);
        let reused=false;const input=summaryInput(m,doc);let model=this.settings.aiModel||m.aiSummary?.model||'',result:SummaryResult|undefined;
        const cached=async()=>{const target=this.summaryFile(m.directory,input.sourceHash,model);if(!existsSync(target))return;const value=JSON.parse(await readFile(target,'utf8'));if(value.sourceHash!==input.sourceHash||value.model!==model)throw new Error('저장된 AI 결과의 입력 버전이 다릅니다.');validateSummary(value.value,new Set(input.sources.map(s=>s.id)));return value as SummaryResult;};
        if(model){result=await cached();reused=!!result;}
        if(!result){const status=await this.auth.status();if(!status.planAllowed){await this.ledger().mark('ai',{inputKey:stageKey([input.sourceHash,model]),status:'waiting_input',message:'OpenAI 로그인 필요'});throw new Error('OpenAI 연결에서 로그인한 뒤 이어서 처리하세요.');}
          const models=await this.auth.models();if(!models.length)throw new Error('사용 가능한 ChatGPT 모델이 없습니다.');if(!models.some(x=>x.id===model)){model=models[0]!.id;this.settings.aiModel=model;await this.saveAISettings();result=await cached();reused=!!result;}
          if(!result)result=await this.ledger().track('ai',[input.sourceHash,model],async()=>{this.state='OpenAI 회의 정리 중';this.refresh();const value=await requestSummary(input,model,await this.auth.access()),target=this.summaryFile(m.directory,input.sourceHash,model);await writeFile(target+'.tmp',JSON.stringify(value,null,2),{mode:0o600});await rename(target+'.tmp',target);return value;});
        }
        await this.ledger().mark('ai',{inputKey:stageKey([input.sourceHash,model]),status:'succeeded',cached:reused,artifact:this.summaryFile(m.directory,input.sourceHash,model)});
        const current=this.editors.find(m.note)?.state.doc.toString()??await this.app.vault.read(file),stale=summaryInput(m,current).sourceHash!==input.sourceHash;
        const base=normalizePath(join(this.summaryDirectory(m),`${basename(m.note,'.md')} - 회의 정리.md`)),preferred=chooseSummaryPath(base,m.aiSummary,input.sourceHash,model,path=>!!this.app.vault.getAbstractFileByPath(path));
        await this.ledger().update(d=>{if(d.publish)d.publish.note=this.registry?.resolveNote(m.id,d.publish.note)??d.publish.note;});
        const key=stageKey([input.sourceHash,model]),owned=m.aiSummary?.sourceHash===input.sourceHash&&m.aiSummary.model===model;
        const note=await this.ledger().track('publish',[key,preferred],()=>publishSummary({exists:p=>!!this.app.vault.getAbstractFileByPath(p),read:async p=>{const f=this.app.vault.getAbstractFileByPath(p);if(!(f instanceof TFile))throw new Error('정리 노트가 없습니다.');return this.editors.find(p)?.state.doc.toString()??await this.app.vault.read(f);},create:(p,t)=>this.app.vault.create(p,t)},this.ledger(),key,preferred,summaryMarkdown(result!,input,m.note,stale),!!owned));
        m.aiSummary={sourceHash:input.sourceHash,note,model,created:result!.created,stale};await this.saveMeeting();this.state=stale?'AI 정리 완료 · 이후 원문 변경 있음':'AI 정리 완료';new Notice('회의 정리 노트를 저장했습니다. 이전 편집본은 유지됩니다.');
      });
    }catch(e){this.state='정리 중단 · 처리 단계에서 계속 가능';throw e;}finally{this.summaryBusy=false;this.refresh(true);}
  }

  stop(){if(this.bridge&&!this.closing){this.closing=true;this.state='녹음 종료 요청 / 남은 전사 처리';this.bridge.stop();this.refresh();}}
  onunload(){this.summaryAudio?.dispose();this.editors?.dispose();window.clearTimeout(this.persistTimer);clearTimeout(this.checkpointTimer);this.bridge?.dispose();this.auth?.cancel();this.overlay?.remove();}
}
function participantLabel(id:string,meeting:Meeting){return speakerName({id:'',speaker:id,text:'',start:0,end:0},meeting.speakers);}
class ParticipantModal extends Modal {
  constructor(app:App,private plugin:LocalMeeting,private onAdded?:(id:string)=>void){super(app);}
  onOpen(){this.setTitle('참여자 추가');this.modalEl.addClass('lm-editor-modal');const form=this.contentEl.createEl('form');const label=form.createEl('label',{cls:'lm-form-field'});label.createSpan({text:'참여자 이름'});const input=label.createEl('input',{type:'text',attr:{placeholder:'예: 김민수',maxlength:'60'}});form.createEl('p',{text:'참여자를 추가한 뒤 발언의 화자를 이 이름으로 변경할 수 있습니다.',cls:'lm-hint'});const error=form.createDiv({cls:'lm-form-error',attr:{role:'alert'}});const actions=form.createDiv({cls:'lm-form-actions'});actions.createEl('button',{type:'submit',text:'참여자 추가',cls:'mod-cta'});form.addEventListener('submit',event=>{event.preventDefault();if(!input.value.trim()){error.setText('이름을 입력해 주세요.');input.focus();return;}const id='manual_'+randomUUID();this.plugin.updateSpeaker(id,input.value);this.onAdded?.(id);this.close();});window.setTimeout(()=>{if(input.isConnected)input.focus();},0);}
}
class RemoveParticipantModal extends Modal {
 constructor(app:App,private plugin:LocalMeeting,private id:string,private connecting=false){super(app);}
 onOpen(){const m=this.plugin.meeting;if(!m)return;this.setTitle(this.connecting?'음성 그룹을 참여자에 연결':'참여자 삭제 또는 발언 합치기');const count=m.segments.filter(s=>s.speaker===this.id).length;this.contentEl.createEl('p',{text:`${participantLabel(this.id,m)} · 연결된 발언 ${count}개. 발언 내용과 녹음은 유지됩니다.`});const select=this.contentEl.createEl('select',{attr:{'aria-label':this.connecting?'연결할 참여자':'삭제 후 발언을 배정할 참여자'}});select.createEl('option',{value:'',text:'대상을 선택하세요'});if(!this.connecting)select.createEl('option',{value:'unknown',text:'발언을 화자 미확정으로 변경'});for(const id of participantIds(m).filter(x=>x!==this.id))select.createEl('option',{value:id,text:participantLabel(id,m)});const b=this.contentEl.createEl('button',{text:this.connecting?'선택한 참여자에 연결':'삭제하고 선택한 화자로 변경',cls:'mod-cta'});b.addEventListener('click',()=>{if(!select.value){new Notice('발언을 옮길 대상을 선택하세요.');return;}b.disabled=true;void this.plugin.deleteParticipant(this.id,select.value).then(()=>this.close()).catch(e=>new Notice(String(e),8000)).finally(()=>{b.disabled=false;});});}
}
class MeetingView extends ItemView {
  private fingerprint='';private stateEl?:HTMLElement;private queueEl?:HTMLElement;private lagEl?:HTMLElement;private editingHint?:HTMLElement;private diagnosticsEl?:HTMLElement;private recordEl?:HTMLButtonElement;private recordIcon?:HTMLElement;private recordLabel?:HTMLElement;
  constructor(leaf:WorkspaceLeaf,private plugin:LocalMeeting){super(leaf);}
  getViewType(){return VIEW;}
  getDisplayText(){return '로컬 회의록';}
  getIcon(){return 'mic';}
  async onOpen(){this.render();}
  render(force=false){
    const p=this.plugin,meeting=p.meeting,active=p.app.workspace.getActiveFile(),ready=active instanceof TFile&&active.extension==='md',viewingSummary=!!meeting?.aiSummary&&active?.path===meeting.aiSummary.note;
    if(this.recordEl){const key=p.isStopping?'stopping':p.bridge?'recording':'idle';if(this.recordEl.dataset.state!==key){this.recordEl.dataset.state=key;setIcon(this.recordIcon!,p.bridge?'square':'mic');this.recordLabel!.setText(p.isStopping?'남은 발언 처리 중…':p.bridge?'녹음 종료':viewingSummary?'원문에서 녹음 시작':'현재 노트에 녹음 시작');this.recordEl.toggleClass('mod-cta',!p.bridge);}this.recordEl.disabled=p.isStopping||p.isAIProcessing||(!p.bridge&&!ready);}
    this.editingHint?.setText(p.typingPaused?'한글 조합 중 · 입력이 끝나면 전사를 반영합니다.':'전사 중에도 필기할 수 있습니다. 커서와 직접 수정한 내용은 유지됩니다.');
    const displayState=p.bridge?p.state:compactStatus(p.state,false,false,p.isAIProcessing,p.error,!!meeting?.segments.length);this.stateEl?.setText(displayState);if(this.queueEl?.parentElement?.parentElement)this.queueEl.parentElement.parentElement.hidden=!p.bridge||p.pending===0&&p.lag===0;this.queueEl?.setText(`${p.pending}개`);this.lagEl?.setText(`${p.lag.toFixed(0)}초`);
    const diag=p.diagnostics;const liveInfo=diag.diarizationRealtime?`\n잠정 화자 분석 · 지연 ${diag.liveSpeakerLagSeconds??'—'}초${diag.liveSpeakerError?' · '+diag.liveSpeakerError:''}`:'';const diagnosticText=typeof diag.device==='string'?`${diag.device} · ${diag.sampleRate??16000}Hz · ${diag.channels??1}채널\n입력 ${diag.rmsDbfs??'—'}dBFS · 클리핑 ${diag.clippedSamples??0}샘플 · 입력 오류 ${diag.inputErrors??0}${liveInfo}`:'녹음을 시작하면 입력 장치와 레벨을 확인할 수 있습니다.';
    this.diagnosticsEl?.setText(diagnosticText);
    const fingerprint=JSON.stringify([!!p.bridge,p.isStopping,p.error,p.settings.showTime,p.settings.dictionaryEnabled,meeting?.segments.filter(needsReview).length,active?.path,meeting?.note,meeting?.segments.slice(-20),meeting?.speakers]);
    if(!force&&this.fingerprint===fingerprint)return;
    if(!force&&this.contentEl.contains(document.activeElement)&&['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName??''))return;
    this.fingerprint=fingerprint;const container=this.contentEl,scroll=container.scrollTop;
    const folds=new Map(Array.from(container.querySelectorAll<HTMLDetailsElement>('details')).map(d=>[d.dataset.section,d.open]));container.empty();container.addClass('lm-panel');
    const heading=container.createDiv({cls:'lm-panel-heading'});heading.createEl('h3',{text:'회의록'});const minimize=heading.createEl('button',{cls:'lm-icon-button',attr:{'aria-label':'상세 보기 최소화',title:'최소화 · ⌘⌥M'}});setIcon(minimize,'minimize-2');minimize.addEventListener('click',()=>{void p.toggleControls();});
    const status=container.createDiv({cls:'lm-session-state'+(p.bridge?' is-running':'')});status.createSpan({cls:'lm-connection-dot'});this.stateEl=status.createSpan({text:displayState,attr:{role:'status','aria-live':'polite'}});
    const record=container.createEl('button',{cls:'lm-primary-control'+(!p.bridge?' mod-cta':''),attr:{title:'⌘⇧M'}});this.recordEl=record;record.dataset.state=p.isStopping?'stopping':p.bridge?'recording':'idle';this.recordIcon=record.createSpan();setIcon(this.recordIcon,p.bridge?'square':'mic');this.recordLabel=record.createSpan({text:p.isStopping?'남은 발언 처리 중…':p.bridge?'녹음 종료':viewingSummary?'원문에서 녹음 시작':'현재 노트에 녹음 시작'});record.disabled=p.isStopping||p.isAIProcessing||(!p.bridge&&!ready);record.addEventListener('click',()=>p.toggleRecording());
    const target=container.createDiv({cls:'lm-recording-target'});if(p.bridge&&meeting){target.createSpan({text:'기록 중인 노트 · '});const note=target.createEl('button',{text:meeting.note.split('/').pop()?.replace(/\.md$/,'')??meeting.note});note.addEventListener('click',()=>{const f=p.app.vault.getAbstractFileByPath(meeting.note);if(f instanceof TFile)void p.app.workspace.getLeaf(false).openFile(f);});}else target.setText(ready?`시작하면 ‘${viewingSummary?meeting!.note.split('/').pop()!.replace(/\.md$/,''):active.basename}’에 기록합니다.`:'기록할 Markdown 노트를 먼저 열어 주세요.');
    this.editingHint=container.createDiv({cls:'lm-hint',attr:{role:'status','aria-live':'polite'}});this.editingHint.setText(p.typingPaused?'한글 조합 중 · 입력이 끝나면 전사를 반영합니다.':'전사 중에도 필기할 수 있습니다. 커서와 직접 수정한 내용은 유지됩니다.');
    const metrics=container.createDiv({cls:'lm-metrics'});metrics.hidden=!p.bridge||p.pending===0&&p.lag===0;const queue=metrics.createDiv({cls:'lm-metric'});this.queueEl=queue.createEl('strong',{text:`${p.pending}개`});queue.createSpan({text:'처리 대기'});const lag=metrics.createDiv({cls:'lm-metric'});this.lagEl=lag.createEl('strong',{text:`${p.lag.toFixed(0)}초`});lag.createSpan({text:'미처리 오디오 범위'});
    if(p.error){const error=container.createDiv({cls:'lm-error',attr:{role:'alert'}});error.setText(p.error);}
    new Setting(container).setName('발언 시간 표시').addToggle(t=>t.setValue(p.settings.showTime).onChange(()=>{void p.guard(()=>p.toggleTime());}));
    const quick=container.createDiv({cls:'lm-quick-actions'});quick.createEl('button',{text:'캘린더 열기',attr:{title:'⌘⌥C'}}).addEventListener('click',()=>p.openCalendar());quick.createEl('button',{text:'할 일 추가'}).addEventListener('click',()=>new TaskModal(this.app).open());
    quick.createEl('button',{text:'처리 단계'}).addEventListener('click',()=>{void p.openPostprocess().catch(e=>new Notice(String(e)));});
    quick.createEl('button',{text:'필기 시점 검토'}).addEventListener('click',()=>{void p.openTimedNotes().catch(e=>new Notice(String(e)));});
    quick.createEl('button',{text:'OpenAI 정리'}).addEventListener('click',()=>new AIControlsModal(this.app,p).open());
    quick.createEl('button',{text:`회의 사전 · ${p.settings.dictionaryEnabled?'켜짐':'꺼짐'}`}).addEventListener('click',()=>new DictionaryModal(this.app,p).open());
    quick.createEl('button',{text:'음성 프로필'}).addEventListener('click',()=>new VoiceProfilesModal(this.app,p).open());
    quick.createEl('button',{text:'기존 미확정 화자 번호 적용'}).addEventListener('click',()=>{void p.guard(()=>p.numberUnknownSpeakers());});
    quick.createEl('button',{text:'발언 검토'}).addEventListener('click',()=>new ReviewModal(this.app,p).open());
    const diagnostics=container.createEl('details');diagnostics.dataset.section='diagnostics';diagnostics.open=folds.get('diagnostics')??false;diagnostics.createEl('summary',{text:'입력 장치와 녹음 상태'});this.diagnosticsEl=diagnostics.createEl('p',{text:diagnosticText,cls:'lm-hint',attr:{style:'white-space:pre-line'}});
    if(meeting){
      const participants=container.createEl('details');participants.dataset.section='participants';participants.open=folds.get('participants')??false;const ids=participantIds(meeting),groups=ids.filter(id=>isUnconfirmedSpeaker(meeting,id));participants.createEl('summary',{text:`참여자 · 이름 ${ids.length-groups.length}명 · 미연결 음성 그룹 ${groups.length}개`});
      const title=participants.createDiv({cls:'lm-section-title'});title.createSpan({text:'참여자와 음성 그룹'});const add=title.createEl('button',{cls:'lm-icon-button',attr:{'aria-label':'참여자 추가',title:'참여자 추가'}});setIcon(add,'user-plus');add.addEventListener('click',()=>new ParticipantModal(this.app,p).open());
      if(active?.path!==meeting.note){participants.createEl('p',{text:'화자 변경은 연결된 원본 회의록에 적용됩니다. 현재 노트가 복사본이라면 자동으로 바뀌지 않습니다.',cls:'lm-hint'});const original=participants.createEl('button',{text:'연결된 원본 회의록 열기'});original.addEventListener('click',()=>{const file=this.app.vault.getAbstractFileByPath(meeting.note);if(file instanceof TFile)void this.app.workspace.getLeaf(false).openFile(file);});}
      participants.createEl('p',{text:'입력한 인원은 화자 모델의 제한입니다. 미연결 음성 그룹을 이름에 합치거나 이름을 직접 지정하세요. 녹음 중에는 아래 발언별 화자 수정에서 표시된 발언을 지정할 수 있습니다.',cls:'lm-hint'});if(meeting.speakerRefinement)participants.createEl('p',{text:`화자 모델: ${meeting.speakerCount?`${meeting.speakerCount}명 ${meeting.speakerCountMode==='exact'?'고정':'상한'}`:'자동 추정'} · ${meeting.speakerRefinement.detected}개 음성 그룹`,cls:'lm-hint'});
      if(!ids.length)participants.createEl('p',{text:'회의 종료 후 화자 구분이 끝나면 참여자가 표시됩니다.',cls:'lm-hint'});
      for(const [index,id] of ids.entries()){const row=participants.createDiv({cls:'lm-participant-row'});row.createSpan({text:isUnconfirmedSpeaker(meeting,id)?'미연결 그룹':meeting.segments.some(s=>s.speaker===id)?'참여자':'연결 전',cls:'lm-participant-label'});const input=row.createEl('input',{type:'text',value:participantLabel(id,meeting),attr:{'aria-label':`참여자 ${index+1} 이름`,maxlength:'60'}});const save=row.createEl('button',{cls:'lm-icon-button',attr:{'aria-label':`참여자 ${index+1} 이름 저장`,title:'이름 저장 · Enter'}});setIcon(save,'check');const apply=()=>{if(!input.value.trim()){new Notice('화자 이름을 입력해 주세요.');input.focus();return;}p.updateSpeaker(id,input.value);new Notice('화자 이름을 저장했습니다.');};save.addEventListener('click',apply);input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();apply();}});if(isUnconfirmedSpeaker(meeting,id)){const connect=row.createEl('button',{text:'연결',attr:{'aria-label':`${participantLabel(id,meeting)} 참여자에 연결`}});connect.disabled=!!p.bridge;connect.addEventListener('click',()=>new RemoveParticipantModal(this.app,p,id,true).open());}const remove=row.createEl('button',{cls:'lm-icon-button',attr:{'aria-label':`${participantLabel(id,meeting)} 삭제 또는 합치기`,title:'삭제 또는 합치기'}});setIcon(remove,'trash-2');remove.disabled=!!p.bridge;remove.addEventListener('click',()=>new RemoveParticipantModal(this.app,p,id).open());}
      const restore=participants.createEl('button',{text:'삭제된 음성 그룹 복구'});restore.disabled=!!p.bridge;restore.addEventListener('click',()=>{void p.guard(()=>p.restoreRemovedGroups());});
      const details=container.createEl('details');details.dataset.section='speakers';details.open=folds.get('speakers')??false;details.createEl('summary',{text:`발언별 화자 수정 · 최근 ${Math.min(20,meeting.segments.length)}개`});details.createEl('p',{text:'다르게 구분된 발언의 화자를 선택하면 노트에도 반영됩니다.',cls:'lm-hint'});
      for(const segment of meeting.segments.slice(-20).reverse()){const row=details.createDiv({cls:'lm-utterance'});row.createEl('p',{text:`${p.settings.showTime?timestamp(segment.start)+' · ':''}${participantLabel(segment.speaker,meeting)}: ${segment.text}`});const select=row.createEl('select',{attr:{'aria-label':`발언 화자 변경: ${segment.text.slice(0,35)}`}});for(const id of [...new Set(['unknown',...ids,'overlap',segment.speaker])])select.createEl('option',{value:id,text:participantLabel(id,meeting)});select.createEl('option',{value:'__new__',text:'+ 새 참여자 추가'});select.value=segment.speaker;select.addEventListener('change',()=>{if(select.value==='__new__'){select.value=segment.speaker;new ParticipantModal(this.app,p,id=>p.assignSpeaker(segment.id,id)).open();}else p.assignSpeaker(segment.id,select.value);});}
      if(meeting.note!==active?.path||!p.bridge)container.createEl('p',{text:`최근 세션: ${meeting.note}`,cls:'lm-recording-target'});
      const audio=container.createEl('button',{text:'녹음 파일 보기',cls:'lm-button-quiet',attr:{title:'회의 전체 recording.wav 파일 보기'}});audio.addEventListener('click',()=>{void p.guard(()=>p.openRecordingFolder());});
    }
    const advanced=container.createEl('details');advanced.dataset.section='advanced';advanced.open=folds.get('advanced')??false;advanced.createEl('summary',{text:'세션 복구 · 단축키'});advanced.createEl('p',{text:'중단된 세션의 저장된 오디오를 다시 처리합니다.',cls:'lm-hint'});const recover=advanced.createEl('button',{text:'마지막 세션 복구'});recover.disabled=!!p.bridge||!p.settings.lastSession;recover.addEventListener('click',()=>{void p.guard(()=>p.recover());});const refine=advanced.createEl('button',{text:'종료 후 화자 재분석'});refine.disabled=!!p.bridge||!meeting;refine.addEventListener('click',()=>{void p.guard(()=>p.reanalyseSpeakers());});if(meeting?.speakerRefinement)advanced.createEl('p',{text:meeting.speakerRefinement.warning||`종료 후 ${meeting.speakerRefinement.detected}개 화자 구분 · ${meeting.speakerRefinement.processingSeconds.toFixed(1)}초`,cls:'lm-hint'});advanced.createEl('p',{text:'⌘⇧M  녹음 시작·종료\n⌘⌥M  상세 보기·최소화\n⌘⌥T  발언 시간 표시\n⌘⌥C  캘린더 열기',cls:'lm-shortcuts',attr:{style:'white-space:pre-line'}});container.scrollTop=scroll;
  }
}
class MeetingSettings extends PluginSettingTab {
  constructor(app:App,private plugin:LocalMeeting){super(app,plugin);}
  display(){
    this.containerEl.empty();this.containerEl.createEl('h2',{text:'로컬 회의록 설정'});
    const fields:[Exclude<keyof Settings,'showTime'|'overlayPosition'|'paragraphPauseSeconds'|'dictionaryEnabled'|'expectedSpeakers'|'speakerCountMode'|'aiAutoSummary'|'voiceProfilesEnabled'|'summaryFolder'|'vaultId'|'meetingFolder'|'qualityStorage'|'pendingStartDirectory'>,string,string][]=[['communityPython','Community-1 Python','pyannote.audio와 MPS가 설치된 전용 venv/bin/python 경로'],['communityModel','Community-1 모델 폴더','공식 모델을 다운로드한 로컬 폴더'],['alignerModel','대사 정렬 모델','Qwen3 ForcedAligner MLX 로컬 모델 폴더'],['python','Python 실행 파일','전용 venv/bin/python 절대 경로'],['model','MLX 모델 폴더','한국어 미세조정 모델을 변환한 로컬 폴더'],['storage','회의 오디오 저장 폴더','Vault 외부의 절대 경로. 원본 녹음이 보관됩니다.'],['testAudio','테스트 WAV 파일','16kHz mono PCM16 WAV 파일 절대 경로'],['device','입력 장치 번호','비워두면 시스템 기본 마이크. 시스템 오디오와 함께 녹음하려면 비워 두세요.'],['voiceAutoThreshold','자동 배정 최소 유사도','실제 회의에서 검증한 -1~1 값. 비우면 자동 배정을 하지 않습니다.'],['voiceAutoMargin','자동 배정 후보 간 최소 차이','실제 회의에서 검증한 0~2 값. 비우면 자동 배정을 하지 않습니다.']];
    this.containerEl.createEl('p',{text:'녹음과 모델 처리는 이 Mac에서 실행합니다. 마이크 입력과 저장 위치를 확인하세요.',cls:'lm-hint'});
    const configured=existsSync(this.plugin.settings.model)&&existsSync(this.plugin.settings.communityPython)&&existsSync(this.plugin.settings.communityModel)&&existsSync(this.plugin.settings.alignerModel);
    this.containerEl.createEl('p',{text:configured?'STT · 화자 구분 모델 파일이 준비되어 있습니다.':'모델 경로를 확인해 주세요. 아래에서 로컬 파일을 연결할 수 있습니다.',cls:configured?'lm-hint':'lm-error'});
    const basic=this.containerEl.createDiv();new Setting(basic).setName('회의록 기본 폴더').setDesc('Vault 내부 상대 경로. 새 회의 시작 시 YYYY-MM-DD 폴더와 회의록을 만듭니다.').addText(t=>t.setValue(this.plugin.settings.meetingFolder).setPlaceholder('예: 회의록').onChange(async value=>{this.plugin.settings.meetingFolder=value.trim();await this.plugin.saveData(this.plugin.settings);}));new Setting(basic).setName('과거 회의 저장 위치').addButton(b=>b.setButtonText('위치 연결').onClick(()=>{void this.plugin.openSessionLocations().catch(e=>new Notice(String(e)));}));new Setting(basic).setName('회의 정리 노트 저장 폴더').setDesc('Vault 내부 상대 경로. 비우면 회의 원문과 같은 폴더에 저장합니다. 기존 노트는 이동하지 않습니다.').addText(t=>t.setPlaceholder('예: 00-사람/회의록').setValue(this.plugin.settings.summaryFolder).onChange(async value=>{this.plugin.settings.summaryFolder=value.trim();await this.plugin.saveData(this.plugin.settings);}));this.containerEl.createEl('p',{text:'회의 원문은 지정 폴더의 날짜별 새 노트에 기록합니다. 녹음 WAV와 처리 데이터는 아래 오디오 저장 폴더에 보관합니다.',cls:'lm-hint'});new Setting(basic).setName('같은 화자 문단 나누기').setDesc('말 사이의 빈 구간이 이 시간 이상이면 새 문단으로 기록합니다. 새 회의부터 적용합니다.').addDropdown(d=>d.addOptions({'2':'2초','2.5':'2.5초 (기본)','3':'3초'}).setValue(String(this.plugin.settings.paragraphPauseSeconds)).onChange(async v=>{this.plugin.settings.paragraphPauseSeconds=Number(v);await this.plugin.saveData(this.plugin.settings);}));const advanced=this.containerEl.createEl('details');advanced.open=!configured;advanced.createEl('summary',{text:'로컬 모델 · 실행 환경 설정'});
    new Setting(basic).setName('예상 발언 인원').setDesc('회의 시작 창의 기본값입니다. Community-1의 최대 화자 수 또는 고정 화자 수로 적용합니다.').addDropdown(d=>{d.addOption('0','지정 안 함');for(let i=1;i<=32;i++)d.addOption(String(i),`${i}명`);d.setValue(String(this.plugin.settings.expectedSpeakers)).onChange(async v=>{this.plugin.settings.expectedSpeakers=Number(v);await this.plugin.saveData(this.plugin.settings);});});
    new Setting(basic).setName('OpenAI 요약·할 일·일정').setDesc('브라우저에서 ChatGPT 계정을 연결합니다. 요약에는 회의 텍스트가 전송됩니다.').addButton(b=>b.setButtonText('OpenAI 연결 및 정리').onClick(()=>new AIControlsModal(this.app,this.plugin).open()));
    for(const [key,name,description] of fields)new Setting(['storage','device'].includes(key)?basic:advanced).setName(name).setDesc(description).addText(t=>t.setValue(this.plugin.settings[key]).onChange(async value=>{this.plugin.settings[key]=value;await this.plugin.saveData(this.plugin.settings);}));
  }
}
