import {App,MarkdownView,FileSystemAdapter,ItemView,Notice,Plugin,PluginSettingTab,Setting,TFile,WorkspaceLeaf,Modal,normalizePath,setIcon,editorInfoField} from 'obsidian';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync} from 'node:fs';
import {join,isAbsolute,dirname,basename} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {release as osRelease} from 'node:os';
import {mkdir,writeFile,readFile,rename,copyFile,readdir} from 'node:fs/promises';
import {SummaryAudioIndex,playbackRanges} from './summary-playback';
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
import {reviewGroups,participantIds,candidateGroups,compactStatus} from './meeting-presentation';
import {dateContext,normalizeEvents,meetingDay} from './meeting-dates';
import {ChatGPTAuth} from './openai-auth';
import {MeetingSetupModal} from './meeting-setup';
import {AIControlsModal,ChatGPTWelcomeModal} from './ai-ui';
import {summaryInput,requestSummary,summaryMarkdown,validateSummary,chooseSummaryPath,evidenceRanges,SummaryResult,MeetingEvent} from './ai-summary';

interface Settings {python:string;model:string;storage:string;device:string;lastSession:string;testAudio:string;showTime:boolean;calendarId:string;overlayPosition:OverlayPosition|null;paragraphPauseSeconds:number;dictionaryEnabled:boolean;dictionaryProject:string;expectedSpeakers:number;communityPython:string;communityModel:string;alignerModel:string;speakerCountMode:'maximum'|'exact';aiModel:string;aiAutoSummary:boolean;voiceProfilesEnabled:boolean;voiceAutoThreshold:string;voiceAutoMargin:string;}
const DEFAULT:Settings={python:'python3',model:'',storage:'',device:'',lastSession:'',testAudio:'',showTime:false,calendarId:'',overlayPosition:null,paragraphPauseSeconds:2.5,dictionaryEnabled:true,dictionaryProject:'',expectedSpeakers:0,communityPython:'',communityModel:'',alignerModel:'',speakerCountMode:'maximum',aiModel:'',aiAutoSummary:true,voiceProfilesEnabled:false,voiceAutoThreshold:'',voiceAutoMargin:''};
const VIEW='local-meeting-controls';
export default class LocalMeeting extends Plugin {
  settings:Settings={...DEFAULT};
  meeting?:Meeting;
  bridge?:WorkerBridge;
  state='대기'; pending=0; lag=0; error='';typingPaused=false;
  diagnostics:Record<string,unknown>={};private protocol=0;private dictionaryUpdates:Promise<unknown>=Promise.resolve();private persistFailed=false;
  private summaryAudio?:SummaryAudio;private audioIndex?:SummaryAudioIndex;private reviewStore?:SummaryReviewStore;private reviewDirectory?:string;
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
  private persistTimer?:number;
  async onload(){
    const saved=await this.loadData();
    if(saved&&typeof saved==='object'){
      const stale=['diarModel','diarLibrary','finalizeSpeakers'];
      if(stale.some(key=>key in saved)){for(const key of stale)delete saved[key];await this.saveData(saved);}
    }
    this.settings=Object.assign({},DEFAULT,saved);
    if(!Number.isInteger(this.settings.expectedSpeakers)||this.settings.expectedSpeakers<0||this.settings.expectedSpeakers>32)this.settings.expectedSpeakers=0;
    if(![2,2.5,3].includes(this.settings.paragraphPauseSeconds))this.settings.paragraphPauseSeconds=2.5;
    if(!['maximum','exact'].includes(this.settings.speakerCountMode))this.settings.speakerCountMode='maximum';
    if(typeof this.settings.voiceAutoThreshold!=='string')this.settings.voiceAutoThreshold='';if(typeof this.settings.voiceAutoMargin!=='string')this.settings.voiceAutoMargin='';
    const adapter=this.app.vault.adapter as FileSystemAdapter;
    try{const runtime=JSON.parse(await readFile(join(adapter.getBasePath(),this.manifest.dir!,'local-runtime.json'),'utf8'));for(const key of ['communityPython','communityModel','alignerModel'] as const)if(!this.settings[key]&&typeof runtime[key]==='string'&&isAbsolute(runtime[key])&&existsSync(runtime[key]))this.settings[key]=runtime[key];}catch{}
    const secretId='local-meeting-chatgpt-'+createHash('sha256').update(adapter.getBasePath()).digest('hex').slice(0,16);
    this.auth=new ChatGPTAuth({read:async()=>{const value=this.app.secretStorage.getSecret(secretId);return value?JSON.parse(value):null;},write:async value=>this.app.secretStorage.setSecret(secretId,JSON.stringify(value))},url=>require('electron').shell.openExternal(url));
    this.editors=new MeetingEditors(view=>view.state.field(editorInfoField,false)?.file?.path,paused=>{this.typingPaused=paused;this.refresh();});
    this.registerEditorExtension(this.editors.extension);
    this.audioIndex=new SummaryAudioIndex(isAbsolute(this.settings.storage)?join(this.settings.storage,'.local-meeting-quality',`summary-audio-${createHash('sha256').update(adapter.getBasePath()).digest('hex').slice(0,16)}.json`):undefined,()=>this.summaryAudio?.refresh());await this.audioIndex.load();
    this.summaryAudio=new SummaryAudio(this.app,this.audioIndex,{root:()=>this.root(),recording:()=>!!this.bridge&&!this.closing,systemAudio:()=>!!this.sessionAudio,fileOf:view=>view.state.field(editorInfoField,false)?.file?.path});
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
    this.addRibbonIcon('mic','로컬 회의록',()=>{void this.openControls();});
    this.addCommand({id:'toggle',name:'녹음 시작 / 중지',hotkeys:[{modifiers:['Mod','Shift'],key:'M'}],callback:()=>this.toggleRecording()});
    this.addCommand({id:'confirm-preview',name:'임시 전사를 본문으로 확정',callback:()=>{void this.reviewWrite(async()=>{if(this.bridge)throw new Error('녹음과 후처리가 끝난 뒤 확정하세요.');if(this.meeting?.presentation&&this.meeting.presentation!=='document')await this.finishPreview();});}});
    this.addCommand({id:'timestamps',name:'시간 표시 켜기 / 끄기',hotkeys:[{modifiers:['Mod','Alt'],key:'T'}],callback:()=>{void this.guard(()=>this.toggleTime());}});
    this.addCommand({id:'calendar',name:'연결된 캘린더 열기',hotkeys:[{modifiers:['Mod','Alt'],key:'C'}],callback:()=>this.openCalendar()});
    this.addCommand({id:'task',name:'현재 노트에 할 일 추가',callback:()=>new TaskModal(this.app).open()});
    this.addCommand({id:'start',name:'현재 노트에서 회의 녹음 시작',callback:()=>{void this.guard(()=>this.start());}});
    this.addCommand({id:'stop',name:'녹음 중지 및 남은 전사 처리',callback:()=>this.stop()});
    this.addCommand({id:'recordings',name:'현재 회의 녹음 파일 보기',callback:()=>{void this.guard(()=>this.openRecordingFolder());}});
    this.addCommand({id:'recover',name:'마지막 세션 복구 및 전사 재시도',callback:()=>{void this.guard(()=>this.recover());}});
    this.addCommand({id:'test-audio',name:'테스트 WAV를 현재 노트에 전사',callback:()=>{void this.guard(()=>this.start(this.settings.testAudio));}});
    this.addCommand({id:'controls',name:'상세 보기 / 최소화',hotkeys:[{modifiers:['Mod','Alt'],key:'M'}],callback:()=>{void this.toggleControls();}});
    this.addCommand({id:'dictionary',name:'회의 사전 열기',callback:()=>new DictionaryModal(this.app,this).open()});
    this.addCommand({id:'voice-profiles',name:'화자 음성 프로필 관리',callback:()=>new VoiceProfilesModal(this.app,this).open()});
    this.addCommand({id:'dictionary-toggle',name:'회의 사전 켜기 / 끄기',callback:()=>{this.settings.dictionaryEnabled=!this.settings.dictionaryEnabled;void this.guard(()=>this.dictionaryChanged());}});
    this.addCommand({id:'dictionary-selection',name:'선택한 표현을 사전에 추가',callback:()=>{void this.guard(async()=>{const selection=this.app.workspace.getActiveViewOfType(MarkdownView)?.editor.getSelection()??'';const data=await this.dictionary().request({type:'list'});new TermModal(this.app,this,data,undefined,undefined,selection).open();});}});
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
    const path=this.meeting?.directory;if(!path||!path.startsWith(this.root()+'/'))throw new Error('저장된 회의 녹음이 없습니다.');
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
    if(!this.meeting&&this.settings.lastSession){try{this.meeting=JSON.parse(await readFile(join(this.settings.lastSession,'meeting.json'),'utf8'));}catch{}}
    const meeting=this.meeting;if(!meeting)return;
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
    const note=this.app.workspace.getActiveFile();
    if(!(note instanceof TFile)||note.extension!=='md') throw new Error('회의를 기록할 Markdown 노트를 먼저 여세요.');
    const adapter=this.app.vault.adapter as FileSystemAdapter;
    const audioHelper=join(adapter.getBasePath(),this.manifest.dir!,'native','Local Meeting Audio.app','Contents','MacOS','LocalMeetingAudio');
    const [darwinMajor=0,darwinMinor=0]=osRelease().split('.').map(Number);const audioAvailable=process.platform==='darwin'&&(darwinMajor>23||darwinMajor===23&&darwinMinor>=2)&&existsSync(audioHelper);let audioOptions:{pid:number;name:string}[]=[];
    if(!inputWav&&audioAvailable)try{const {stdout}=await promisify(execFile)(audioHelper,['--list'],{timeout:5000,maxBuffer:65536});const data:unknown=JSON.parse(stdout);if(Array.isArray(data))audioOptions=data.filter((v):v is {pid:number;name:string}=>!!v&&Number.isSafeInteger(v.pid)&&v.pid>0&&typeof v.name==='string').slice(0,100);}catch{}
    const participantLimit=inputWav?{count:this.settings.expectedSpeakers,mode:this.settings.speakerCountMode,audio:'microphone' as const,voiceProfiles:false}:await MeetingSetupModal.ask(this.app,{count:this.settings.expectedSpeakers,mode:this.settings.speakerCountMode,voiceProfiles:this.settings.voiceProfilesEnabled},audioOptions,audioAvailable);
    if(!participantLimit)return;
    if(participantLimit.audio!=='microphone'&&this.settings.device.trim())throw new Error('시스템 오디오는 현재 기본 마이크에서만 지원합니다. 설정의 입력 장치 번호를 비워 주세요.');
    if(participantLimit.audio==='app'&&(!Number.isSafeInteger(participantLimit.audioPid)||(participantLimit.audioPid??0)<=0))throw new Error('녹음할 앱을 다시 선택하세요.');
    this.sessionAudio=participantLimit.audio==='microphone'?undefined:{helper:audioHelper,...(participantLimit.audio==='app'?{pid:participantLimit.audioPid}:{})};
    const id=randomUUID(); const directory=join(this.root(),id);
    await mkdir(directory,{recursive:true});
    const dictionary=await this.dictionary().request({type:'snapshot',project:this.settings.dictionaryProject,meeting:id,enabled:this.settings.dictionaryEnabled});
    const modelConfig=await readFile(join(this.settings.model,'config.json'),'utf8');
    await writeFile(join(directory,'pipeline.json'),JSON.stringify({schemaVersion:3,workflow:'text-then-community',audioMode:participantLimit.audio,voiceProfiles:participantLimit.voiceProfiles,dictionary:dictionary.snapshot,speakerCount:participantLimit.count,speakerCountMode:participantLimit.mode,asrConfigHash:createHash('sha256').update(modelConfig).digest('hex'),pluginVersion:this.manifest.version},null,2));
    if(!inputWav)this.settings.voiceProfilesEnabled=participantLimit.voiceProfiles;
    this.meeting={id,note:note.path,directory,started:new Date().toISOString(),speakers:{},segments:[],rendered:{},paragraphPauseMs:this.settings.paragraphPauseSeconds*1000,pipelineVersion:3,transcriptMode:'text-only',presentation:'ghost',speakerCount:participantLimit.count,speakerCountMode:participantLimit.mode,dictionaryRevision:dictionary.snapshot.revision};
    await this.saveMeeting();
    this.settings.lastSession=directory; await this.saveData(this.settings);
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
    const directory=this.settings.lastSession;
    if(!directory.startsWith(this.root()+'/')) throw new Error('세션 저장 경로가 현재 설정과 다릅니다.');
    const data=JSON.parse(await readFile(join(directory,'meeting.json'),'utf8')) as Meeting;
    if(!data.id||!data.note||!Array.isArray(data.segments)||data.directory!==directory) throw new Error('잘못된 세션 파일');
    if(!(this.app.vault.getAbstractFileByPath(data.note) instanceof TFile)) throw new Error('원래 회의 노트를 찾을 수 없습니다.');
    this.meeting=data;await this.migrateCurrentNote();this.launch(true);
    } finally {this.transitioning=false;}
  }
  async reanalyseSpeakers(){
    if(this.bridge||this.transitioning||this.summaryBusy)throw new Error('진행 중인 녹음과 처리가 끝난 뒤 실행하세요.');
    if(!this.meeting)throw new Error('불러온 회의가 없습니다.');
    if(!existsSync(join(this.meeting.directory,'recording.wav')))throw new Error('회의 전체 WAV가 없습니다.');
    this.transitioning=true;
    try{await this.writes;await this.saveMeeting();this.launch(true,undefined,true);}finally{this.transitioning=false;}
  }
  private launch(resume:boolean,inputWav?:string,refineOnly=false){
    const meeting=this.meeting!;
    const adapter=this.app.vault.adapter as FileSystemAdapter;
    const script=join(adapter.getBasePath(),this.manifest.dir!,'worker','main.py');
    this.error='';this.state=resume?'복구 중':'녹음 시작 중';this.closing=refineOnly;
    this.protocol=0;this.diagnostics={};
    const bridge=new WorkerBridge(event=>this.receive(event,meeting.id),()=>{
      if(this.meeting?.id!==meeting.id)return;
      this.bridge=undefined;this.state='종료';this.refresh();this.writes=this.writes.then(()=>this.saveMeeting()).catch(error=>this.showError(String(error)));
      void this.writes.then(async()=>{if(this.meeting?.id===meeting.id&&meeting.pipelineVersion===3&&meeting.speakerPassId&&!this.error&&this.settings.aiAutoSummary)await this.generateSummary(true);}).catch(error=>this.showError(String(error)));
    });
    this.bridge=bridge;
    try {bridge.start(this.settings.python,script,this.settings.model,meeting.directory,resume,this.settings.device,inputWav,resume&&!refineOnly&&(meeting.pipelineVersion??0)<3,refineOnly,{python:this.settings.communityPython,model:this.settings.communityModel,aligner:this.settings.alignerModel,...(refineOnly?{count:meeting.speakerCount??this.settings.expectedSpeakers,mode:meeting.speakerCountMode??this.settings.speakerCountMode}:{})},resume||inputWav?undefined:this.sessionAudio);}
    catch(error){this.bridge=undefined;this.state='오류';throw error;}
    this.refresh();
  }
  receive(event:WorkerEvent,expectedSession=this.meeting?.id){
    if(!this.meeting||this.meeting.id!==expectedSession)return;
    if('session'in event&&event.session&&event.session!==expectedSession)return;
    if(event.type==='error'){this.showError(event.message);return;}
    if(event.type==='hello'){this.protocol=event.protocol;}
    if(event.type==='config_applied'){this.meeting.dictionaryRevision=event.revision;this.writes=this.writes.then(()=>this.saveMeeting()).catch(e=>this.showError(String(e)));}
    if(event.type==='status'){if(event.state.includes('종료 후 화자'))this.closing=true;this.state=event.state;this.pending=event.pending;this.lag=event.pendingAudioSeconds??event.lag;if(event.diagnostics)this.diagnostics=event.diagnostics;}
    if(event.type==='ready'){if((this.meeting.pipelineVersion??0)>=2&&this.protocol!==2){this.showError('워커 버전이 맞지 않습니다. 녹음을 중지합니다.');this.stop();return;}this.state='전사 준비 완료';}
    if(event.type==='speaker_refinement'){
      this.writes=this.writes.then(async()=>{
        const meeting=this.meeting;if(!meeting||meeting.id!==expectedSession)return;
        if(meeting.speakerPassId===event.passId){if(this.persistFailed)await this.saveMeeting();return;}
        if(!await this.editors.ready(meeting.note))throw new Error('편집기가 종료되어 화자 적용을 보류했습니다. 세션 복구로 재시도하세요.');
        const file=this.app.vault.getAbstractFileByPath(meeting.note);if(!(file instanceof TFile))throw new Error('회의 노트를 찾을 수 없습니다.');
        const doc=this.editors.find(meeting.note)?.state.doc.toString()??await this.app.vault.read(file);
        if(meeting.noteSnapshot!==undefined)rebaseAnchors(meeting,meeting.noteSnapshot,doc);
        const backup=structuredClone(meeting);
        const backupPath=join(meeting.directory,`meeting.pre-speaker-${event.passId.slice(0,8)}.json`);
        if(!existsSync(backupPath))await writeFile(backupPath,JSON.stringify(backup,null,2),{flag:'wx'});
        const expected=(meeting.speakerCount??this.settings.expectedSpeakers)||Object.keys(meeting.speakers).filter(id=>!['unknown','overlap'].includes(id)&&!id.startsWith('final_')).length;
        if(meeting.presentation&&meeting.presentation!=='document'){
          refinePreview(meeting,event,expected);await this.applyVoiceAutoMatches(meeting).catch(e=>{new Notice('프로필 비교를 보류했습니다. '+String(e),8000);return [];});await this.saveMeeting();await this.finishPreview();if((meeting.presentation as string)==='document'){await this.collectConfirmedVoice(meeting);await this.collectAutoVoice(meeting).catch(e=>new Notice('음성 특징 자동 수집을 보류했습니다. '+String(e),8000));}
          this.refresh(true);return;
        }
        splitAlignedSpeakers(meeting,event,doc);
        const ids=refineSpeakers(meeting,event,expected);ids.push(...await this.applyVoiceAutoMatches(meeting).catch(e=>{new Notice('프로필 비교를 보류했습니다. '+String(e),8000);return [];}));
        try{await this.renderSegments(ids,'speaker');}
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
          if(index>=0)meeting.segments[index]=accepted.segment;else meeting.segments.push(accepted.segment);
          try{await this.renderSegments([event.segment.id],accepted.mode);}catch(e){if(!(e as {noteCommitted?:boolean}).noteCommitted){if(previous)meeting.segments[index]=previous;else meeting.segments=meeting.segments.filter(s=>s.id!==event.segment.id);}throw e;}
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
    try{if(editorView instanceof MarkdownView)await editorView.save();const file=join(meeting.directory,'meeting.json');await writeFile(file+'.tmp',snapshot);await rename(file+'.tmp',file);this.audioIndex?.register(meeting.aiSummary?.note,meeting.id);await this.audioIndex?.flush();this.persistFailed=false;}catch(e){this.persistFailed=true;throw e;}
  }
  private async renderSegments(ids:string[],mode:'normal'|'time'|'speaker'='normal'){
    const meeting=this.meeting;if(!meeting)return;
    if(meeting.presentation&&meeting.presentation!=='document'){this.showPreview();await this.saveMeeting();this.refresh();return;}
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
  private async finishPreview(){
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
    this.writes=this.writes.then(async()=>{const m=this.meeting;if(!m)return;const previous=m.speakers[id];m.speakers[id]=name.trim()||id;m.voiceConfirmedSpeakers=[...new Set([...(m.voiceConfirmedSpeakers??[]),id])];await this.renderSegments(m.segments.filter(s=>s.speaker===id).map(s=>s.id),'speaker');if(previous&&previous!==name&&!/^화자 \d+$/.test(previous))await this.invalidateVoiceForSpeaker(m,id,false);await this.enrollVoiceSpeaker(m,id).catch(e=>new Notice('음성 프로필 수집을 보류했습니다. '+String(e),8000));this.refresh(true);}).catch(error=>this.showError(String(error)));
  }
  assignSpeaker(segmentId:string,speaker:string){
    this.writes=this.writes.then(async()=>{const m=this.meeting,s=m?.segments.find(s=>s.id===segmentId);if(!m||!s)return;const before=structuredClone(s),next=speaker.trim()||'unknown';if(before.speaker!==next)await this.invalidateVoiceForSegment(m,before);const userRevision=(s.userRevision??0)+1;s.history=[...(s.history??[]),{at:new Date().toISOString(),before:{text:s.text,speaker:s.speaker,textLocked:s.textLocked,speakerLocked:s.speakerLocked,speakerState:s.speakerState,suggestions:structuredClone(s.suggestions),reviewedRevision:s.reviewedRevision},afterText:s.text,afterSpeaker:next,userRevision}];s.userRevision=userRevision;s.speaker=next;s.speakerLocked=true;s.speakerState='manual';await this.renderSegments([s.id],'speaker');this.refresh(true);}).catch(error=>this.showError(String(error)));
  }
  async connectCandidate(candidate:string,target:string){await this.reviewWrite(async()=>{
    const m=this.meeting;if(!m||this.bridge)throw new Error('후처리가 끝난 뒤 연결하세요.');const group=candidateGroups(m).find(c=>c.id===candidate);if(!group)throw new Error('연결할 음성 그룹이 없습니다.');
    if(!target)throw new Error('참여자를 선택하거나 새 이름을 입력하세요.');if(!group.segments.some(s=>!s.speakerLocked&&!m.anchors?.[s.id]?.locked&&!m.anchors?.[s.id]?.deleted))throw new Error('직접 수정·지정한 발언만 남아 있습니다. 개별 발언에서 확인해 주세요.');const backup=structuredClone(m);let id=target;
    if(target.startsWith('name:')){const name=target.slice(5).trim();if(!name||name.length>60)throw new Error('이름은 1~60자로 입력하세요.');id='manual_'+randomUUID();m.speakers[id]=name;}
    else if(!participantIds(m).includes(id))throw new Error('기존 참여자를 선택하세요.');
    m.voiceConfirmedSpeakers=[...new Set([...(m.voiceConfirmedSpeakers??[]),id])];
    const ids:string[]=[];for(const segment of group.segments){const a=m.anchors?.[segment.id];if(segment.speakerLocked||a?.locked||a?.deleted)continue;segment.speaker=id;segment.speakerLocked=true;segment.speakerState='manual';segment.reviewReasons=segment.reviewReasons?.filter(r=>!r.includes('화자')&&!r.includes('음성 그룹'));ids.push(segment.id);}
    for(const [cluster,local] of Object.entries(m.speakerClusters??{}))if(local===candidate)m.speakerClusters![cluster]=id;
    try{await this.renderSegments(ids,'speaker');}catch(e){if(!(e as {noteCommitted?:boolean}).noteCommitted)this.meeting=backup;throw e;}await this.enrollVoiceSpeaker(m,id).catch(e=>new Notice('음성 프로필 수집을 보류했습니다. '+String(e),8000));this.refresh(true);
  });}
  voiceProfiles(){const root=this.root();if(this.voiceRoot!==root){this.voiceRoot=root;this.voiceStore=new VoiceProfiles(root);}return this.voiceStore!;}
  async voiceFeatures(m=this.meeting):Promise<VoiceFeatures|null>{if(!m||!m.speakerPassId)return null;try{const config=JSON.parse(await readFile(join(m.directory,'pipeline.json'),'utf8'));if(config.voiceProfiles!==true)return null;return validateFeatures(JSON.parse(await readFile(join(m.directory,'voice-features.json'),'utf8')),m.id,m.speakerPassId);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
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
  dictionary(){const adapter=this.app.vault.adapter as FileSystemAdapter;return new LocalDictionary(this.settings.python,join(adapter.getBasePath(),this.manifest.dir!,'worker/dictionary.py'),this.root(),createHash('sha256').update(adapter.getBasePath()).digest('hex').slice(0,20));}
  async dictionaryChanged(){
    this.dictionaryUpdates=this.dictionaryUpdates.catch(()=>undefined).then(async()=>{await this.saveData(this.settings);const data=await this.dictionary().request({type:'snapshot',project:this.settings.dictionaryProject,meeting:this.meeting?.id??'',enabled:this.settings.dictionaryEnabled});
      if(this.bridge&&this.protocol===2)this.bridge.command({type:'dictionary',snapshot:data.snapshot});
      else new Notice(this.settings.dictionaryEnabled?'사전 설정을 저장했습니다. 새 회의부터 적용됩니다.':'사전 사용을 껐습니다.');this.refresh(true);
    });await this.dictionaryUpdates;
  }
  async exportDictionary(format:'json'|'csv'){const data=await this.dictionary().request({type:'export'});const folder=join(this.root(),'.local-meeting-quality','exports');await mkdir(folder,{recursive:true});const target=join(folder,`dictionary-${Date.now()}.${format}`);await writeFile(target,format==='json'?JSON.stringify({schemaVersion:1,terms:data.terms},null,2):dictionaryCsv(data.terms));require('electron').shell.showItemInFolder(target);}
  private async reviewWrite(action:()=>Promise<void>){const next=this.writes.then(action);this.writes=next.catch(e=>this.showError(String(e)));await next;}
  async reviewApply(id:string,revision:number,before:string,text:string,speaker:string){await this.reviewWrite(async()=>{
    const m=this.meeting,s=m?.segments.find(x=>x.id===id);if(!m||!s)throw new Error('현재 회의에 없는 발언입니다.');
    await this.editors.ready(m.note);const file=this.app.vault.getAbstractFileByPath(m.note);if(!(file instanceof TFile))throw new Error('회의 노트가 없습니다.');
    const doc=this.editors.find(m.note)?.state.doc.toString()??await this.app.vault.read(file);if(m.noteSnapshot!==undefined)rebaseAnchors(m,m.noteSnapshot,doc);
    if(m.anchors?.[id]?.locked||m.anchors?.[id]?.deleted)throw new Error('본문에서 직접 수정하거나 삭제한 발언입니다. 노트에서 확인해 주세요.');
    if(!['unknown','overlap',...m.segments.map(x=>x.speaker),...Object.keys(m.speakers)].includes(speaker))throw new Error('현재 회의의 참여자를 선택해 주세요.');
    const backup=structuredClone(s);reviewEdit(structuredClone(s),revision,before,text,speaker);if(backup.speaker!==speaker)await this.invalidateVoiceForSegment(m,backup);try{reviewEdit(s,revision,before,text,speaker);await this.renderSegments([id]);}catch(e){if(!(e as {noteCommitted?:boolean}).noteCommitted)m.segments[m.segments.indexOf(s)]=backup;throw e;}this.refresh(true);
  });}
  async reviewKeep(id:string,revision:number){await this.reviewWrite(async()=>{const s=this.meeting?.segments.find(x=>x.id===id);if(!s||(s.revision??0)!==revision)throw new Error('발언이 변경되었습니다. 새로고침해 주세요.');s.reviewedRevision=revision;await this.saveMeeting();this.refresh(true);});}
  async reviewUndo(id:string){await this.reviewWrite(async()=>{const m=this.meeting,s=m?.segments.find(x=>x.id===id);if(!m||!s)throw new Error('발언이 없습니다.');await this.editors.ready(m.note);const file=this.app.vault.getAbstractFileByPath(m.note);if(!(file instanceof TFile))throw new Error('회의 노트가 없습니다.');const doc=this.editors.find(m.note)?.state.doc.toString()??await this.app.vault.read(file);if(m.noteSnapshot!==undefined)rebaseAnchors(m,m.noteSnapshot,doc);if(m.anchors?.[id]?.locked||m.anchors?.[id]?.deleted)throw new Error('본문 수정이 있어 자동으로 되돌릴 수 없습니다.');const backup=structuredClone(s);try{undoReview(s);await this.renderSegments([id]);}catch(e){if(!(e as {noteCommitted?:boolean}).noteCommitted)m.segments[m.segments.indexOf(s)]=backup;throw e;}this.refresh(true);});}
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
  private async currentInput(){const m=this.meeting;if(!m)throw new Error('회의가 없습니다.');const file=this.app.vault.getAbstractFileByPath(m.note);if(!(file instanceof TFile))throw new Error('회의 노트가 없습니다.');const doc=this.editors.find(m.note)?.state.doc.toString()??await this.app.vault.read(file);return summaryInput(m,doc);}
  async summaryChanged(){const m=this.meeting;if(!m?.aiSummary)return false;const input=await this.currentInput();const legacy=createHash('sha256').update(JSON.stringify({started:input.started,document:input.document,sources:input.sources})).digest('hex');return !!m.aiSummary.stale||![input.sourceHash,legacy].includes(m.aiSummary.sourceHash);}
  async reviewRanges(item:ReviewItem){const input=await this.currentInput();return playbackRanges(evidenceRanges(item.edited.evidence,input)).map(r=>r.label);}
  async playReviewRange(item:ReviewItem,index:number){const m=this.meeting;if(!m||!this.summaryAudio)throw new Error('회의 녹음을 찾을 수 없습니다.');const input=await this.currentInput(),range=playbackRanges(evidenceRanges(item.edited.evidence,input))[index];if(!range)throw new Error('녹음 구간을 찾을 수 없습니다.');this.summaryAudio.play(m.id,range);}
  async refreshSummaryLayout(){const m=this.meeting,result=await this.currentSummary();if(!m||!result)throw new Error('저장된 정리 결과가 없습니다.');const file=this.app.vault.getAbstractFileByPath(m.note);if(!(file instanceof TFile))throw new Error('회의 원문을 찾을 수 없습니다.');const doc=this.editors.find(m.note)?.state.doc.toString()??await this.app.vault.read(file),input=summaryInput(m,doc);const base=normalizePath(join(dirname(m.note),`${basename(m.note,'.md')} - 회의 정리 (간결한 보기).md`));let note=base,n=2;while(this.app.vault.getAbstractFileByPath(note))note=base.replace(/\.md$/,` ${n++}.md`);const legacyHash=createHash('sha256').update(JSON.stringify({started:input.started,document:input.document,sources:input.sources})).digest('hex'),stale=!!m.aiSummary?.stale||result.sourceHash!==input.sourceHash&&result.sourceHash!==legacyHash;await this.app.vault.create(note,summaryMarkdown(result,input,m.note,stale));m.aiSummary={...m.aiSummary!,note};await this.saveMeeting();await this.openSummary();}
  async createReviewedSummary(){const m=this.meeting,result=await this.currentSummary();if(!m||!result||!m.aiSummary)throw new Error('저장된 정리 결과가 없습니다.');const input=await this.currentInput(),items=await this.reviewItems();const visible=(kind:ReviewItem['kind'])=>items.filter(i=>i.kind===kind&&i.status!=='excluded').map(i=>i.edited);
    const value={...result.value,decisions:visible('decision') as typeof result.value.decisions,tasks:visible('task') as typeof result.value.tasks,events:visible('event') as typeof result.value.events,openQuestions:visible('question') as typeof result.value.openQuestions};
    const base=normalizePath(join(dirname(m.note),`${basename(m.note,'.md')} - 회의 정리 (검토).md`));let note=base,n=2;while(this.app.vault.getAbstractFileByPath(note))note=base.replace(/\.md$/,` ${n++}.md`);const stale=await this.summaryChanged();await this.app.vault.create(note,summaryMarkdown({...result,value},input,m.note,stale));m.aiSummary={...m.aiSummary,note,stale};await this.saveMeeting();await this.openSummary();}
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
    const status=await this.auth.status();if(!status.planAllowed){if(automatic){this.state='전사 완료 · OpenAI 로그인 필요';this.refresh(true);return;}throw new Error('OpenAI 연결에서 Continue with ChatGPT로 로그인해 주세요.');}
    this.summaryBusy=true;this.error='';this.state='OpenAI 회의 정리 중';this.refresh(true);
    try{
      await this.writes;if(!await this.editors.ready(m.note))throw new Error('편집기가 종료되어 정리를 보류했습니다.');
      const file=this.app.vault.getAbstractFileByPath(m.note);if(!(file instanceof TFile))throw new Error('회의 노트가 없습니다.');
      const doc=this.editors.find(m.note)?.state.doc.toString()??await this.app.vault.read(file);if(m.noteSnapshot!==undefined)rebaseAnchors(m,m.noteSnapshot,doc);
      const input=summaryInput(m,doc),models=await this.auth.models();if(!models.length)throw new Error('사용 가능한 ChatGPT 모델이 없습니다.');
      if(!models.some(x=>x.id===this.settings.aiModel)){this.settings.aiModel=models[0]!.id;await this.saveAISettings();}
      const model=this.settings.aiModel,target=this.summaryFile(m.directory,input.sourceHash,model);let result:SummaryResult|undefined;
      if(existsSync(target)){const cached=JSON.parse(await readFile(target,'utf8'));if(cached.sourceHash===input.sourceHash&&cached.model===model)result=cached;}
      if(!result){result=await requestSummary(input,model,await this.auth.access());await writeFile(target+'.tmp',JSON.stringify(result,null,2),{mode:0o600});await rename(target+'.tmp',target);}
      const current=this.editors.find(m.note)?.state.doc.toString()??await this.app.vault.read(file),stale=summaryInput(m,current).sourceHash!==input.sourceHash;
      const base=normalizePath(join(dirname(m.note),`${basename(m.note,'.md')} - 회의 정리.md`)),note=chooseSummaryPath(base,m.aiSummary,input.sourceHash,model,path=>!!this.app.vault.getAbstractFileByPath(path));
      if(!this.app.vault.getAbstractFileByPath(note))await this.app.vault.create(note,summaryMarkdown(result,input,m.note,stale));
      m.aiSummary={sourceHash:input.sourceHash,note,model,created:result.created,stale};await this.saveMeeting();
      this.state=stale?'AI 정리 완료 · 이후 원문 변경 있음':'AI 정리 완료';new Notice(stale?'AI 정리 노트를 만들었습니다. 처리 중 바뀐 내용은 다음 정리에 반영할 수 있습니다.':'요약·할 일·일정 후보를 별도 노트에 정리했습니다.');
    }catch(e){this.state='AI 정리 실패 · 다시 시도 가능';throw e;}finally{this.summaryBusy=false;this.refresh(true);}
  }
  stop(){if(this.bridge&&!this.closing){this.closing=true;this.state='녹음 종료 요청 / 남은 전사 처리';this.bridge.stop();this.refresh();}}
  onunload(){this.summaryAudio?.dispose();this.editors?.dispose();window.clearTimeout(this.persistTimer);this.bridge?.dispose();this.auth?.cancel();this.overlay?.remove();}
}
function participantLabel(id:string,meeting:Meeting){return speakerName({id:'',speaker:id,text:'',start:0,end:0},meeting.speakers);}
class ParticipantModal extends Modal {
  constructor(app:App,private plugin:LocalMeeting,private onAdded?:(id:string)=>void){super(app);}
  onOpen(){this.setTitle('참여자 추가');this.modalEl.addClass('lm-editor-modal');const form=this.contentEl.createEl('form');const label=form.createEl('label',{cls:'lm-form-field'});label.createSpan({text:'참여자 이름'});const input=label.createEl('input',{type:'text',attr:{placeholder:'예: 김민수',maxlength:'60'}});form.createEl('p',{text:'참여자를 추가한 뒤 발언의 화자를 이 이름으로 변경할 수 있습니다.',cls:'lm-hint'});const error=form.createDiv({cls:'lm-form-error',attr:{role:'alert'}});const actions=form.createDiv({cls:'lm-form-actions'});actions.createEl('button',{type:'submit',text:'참여자 추가',cls:'mod-cta'});form.addEventListener('submit',event=>{event.preventDefault();if(!input.value.trim()){error.setText('이름을 입력해 주세요.');input.focus();return;}const id='manual_'+randomUUID();this.plugin.updateSpeaker(id,input.value);this.onAdded?.(id);this.close();});window.setTimeout(()=>{if(input.isConnected)input.focus();},0);}
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
    const diag=p.diagnostics;const diagnosticText=typeof diag.device==='string'?`${diag.device} · ${diag.sampleRate??16000}Hz · ${diag.channels??1}채널\n입력 ${diag.rmsDbfs??'—'}dBFS · 클리핑 ${diag.clippedSamples??0}샘플 · 입력 오류 ${diag.inputErrors??0}`:'녹음을 시작하면 입력 장치와 레벨을 확인할 수 있습니다.';
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
    quick.createEl('button',{text:'OpenAI 정리'}).addEventListener('click',()=>new AIControlsModal(this.app,p).open());
    quick.createEl('button',{text:`회의 사전 · ${p.settings.dictionaryEnabled?'켜짐':'꺼짐'}`}).addEventListener('click',()=>new DictionaryModal(this.app,p).open());
    quick.createEl('button',{text:'음성 프로필'}).addEventListener('click',()=>new VoiceProfilesModal(this.app,p).open());
    quick.createEl('button',{text:'발언 검토'}).addEventListener('click',()=>new ReviewModal(this.app,p).open());
    const diagnostics=container.createEl('details');diagnostics.dataset.section='diagnostics';diagnostics.open=folds.get('diagnostics')??false;diagnostics.createEl('summary',{text:'입력 장치와 녹음 상태'});this.diagnosticsEl=diagnostics.createEl('p',{text:diagnosticText,cls:'lm-hint',attr:{style:'white-space:pre-line'}});
    if(meeting){
      const participants=container.createEl('details');participants.dataset.section='participants';participants.open=folds.get('participants')??false;participants.createEl('summary',{text:`참여자 · ${participantIds(meeting).length}명`});
      const title=participants.createDiv({cls:'lm-section-title'});title.createSpan({text:'참여자'});const add=title.createEl('button',{cls:'lm-icon-button',attr:{'aria-label':'참여자 추가',title:'참여자 추가'}});setIcon(add,'user-plus');add.addEventListener('click',()=>new ParticipantModal(this.app,p).open());
      participants.createEl('p',{text:'이름을 지정하면 대화 기록에 반영합니다. 미확정 음성은 발언 검토에서 연결합니다.',cls:'lm-hint'});
      const ids=participantIds(meeting);
      if(!ids.length)participants.createEl('p',{text:'회의 종료 후 화자 구분이 끝나면 참여자가 표시됩니다.',cls:'lm-hint'});
      for(const [index,id] of ids.entries()){const row=participants.createDiv({cls:'lm-participant-row'});row.createSpan({text:`이름 ${index+1}`,cls:'lm-participant-label'});const input=row.createEl('input',{type:'text',value:participantLabel(id,meeting),attr:{'aria-label':`참여자 ${index+1} 이름`,maxlength:'60'}});const save=row.createEl('button',{cls:'lm-icon-button',attr:{'aria-label':`참여자 ${index+1} 이름 저장`,title:'이름 저장 · Enter'}});setIcon(save,'check');const apply=()=>{if(!input.value.trim()){new Notice('화자 이름을 입력해 주세요.');input.focus();return;}p.updateSpeaker(id,input.value);new Notice('화자 이름을 저장했습니다.');};save.addEventListener('click',apply);input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();apply();}});}
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
    const fields:[Exclude<keyof Settings,'showTime'|'overlayPosition'|'paragraphPauseSeconds'|'dictionaryEnabled'|'expectedSpeakers'|'speakerCountMode'|'aiAutoSummary'|'voiceProfilesEnabled'>,string,string][]=[['communityPython','Community-1 Python','pyannote.audio와 MPS가 설치된 전용 venv/bin/python 경로'],['communityModel','Community-1 모델 폴더','공식 모델을 다운로드한 로컬 폴더'],['alignerModel','대사 정렬 모델','Qwen3 ForcedAligner MLX 로컬 모델 폴더'],['python','Python 실행 파일','전용 venv/bin/python 절대 경로'],['model','MLX 모델 폴더','한국어 미세조정 모델을 변환한 로컬 폴더'],['storage','회의 오디오 저장 폴더','Vault 외부의 절대 경로. 원본 녹음이 보관됩니다.'],['testAudio','테스트 WAV 파일','16kHz mono PCM16 WAV 파일 절대 경로'],['device','입력 장치 번호','비워두면 시스템 기본 마이크. 시스템 오디오와 함께 녹음하려면 비워 두세요.'],['voiceAutoThreshold','자동 배정 최소 유사도','실제 회의에서 검증한 -1~1 값. 비우면 자동 배정을 하지 않습니다.'],['voiceAutoMargin','자동 배정 후보 간 최소 차이','실제 회의에서 검증한 0~2 값. 비우면 자동 배정을 하지 않습니다.']];
    this.containerEl.createEl('p',{text:'녹음과 모델 처리는 이 Mac에서 실행합니다. 마이크 입력과 저장 위치를 확인하세요.',cls:'lm-hint'});
    const configured=existsSync(this.plugin.settings.model)&&existsSync(this.plugin.settings.communityPython)&&existsSync(this.plugin.settings.communityModel)&&existsSync(this.plugin.settings.alignerModel);
    this.containerEl.createEl('p',{text:configured?'STT · 화자 구분 모델 파일이 준비되어 있습니다.':'모델 경로를 확인해 주세요. 아래에서 로컬 파일을 연결할 수 있습니다.',cls:configured?'lm-hint':'lm-error'});
    const basic=this.containerEl.createDiv();new Setting(basic).setName('같은 화자 문단 나누기').setDesc('말 사이의 빈 구간이 이 시간 이상이면 새 문단으로 기록합니다. 새 회의부터 적용합니다.').addDropdown(d=>d.addOptions({'2':'2초','2.5':'2.5초 (기본)','3':'3초'}).setValue(String(this.plugin.settings.paragraphPauseSeconds)).onChange(async v=>{this.plugin.settings.paragraphPauseSeconds=Number(v);await this.plugin.saveData(this.plugin.settings);}));const advanced=this.containerEl.createEl('details');advanced.open=!configured;advanced.createEl('summary',{text:'로컬 모델 · 실행 환경 설정'});
    new Setting(basic).setName('예상 발언 인원').setDesc('회의 시작 창의 기본값입니다. Community-1의 최대 화자 수 또는 고정 화자 수로 적용합니다.').addDropdown(d=>{d.addOption('0','지정 안 함');for(let i=1;i<=32;i++)d.addOption(String(i),`${i}명`);d.setValue(String(this.plugin.settings.expectedSpeakers)).onChange(async v=>{this.plugin.settings.expectedSpeakers=Number(v);await this.plugin.saveData(this.plugin.settings);});});
    new Setting(basic).setName('OpenAI 요약·할 일·일정').setDesc('브라우저에서 ChatGPT 계정을 연결합니다. 요약에는 회의 텍스트가 전송됩니다.').addButton(b=>b.setButtonText('OpenAI 연결 및 정리').onClick(()=>new AIControlsModal(this.app,this.plugin).open()));
    for(const [key,name,description] of fields)new Setting(['storage','device'].includes(key)?basic:advanced).setName(name).setDesc(description).addText(t=>t.setValue(this.plugin.settings[key]).onChange(async value=>{this.plugin.settings[key]=value;await this.plugin.saveData(this.plugin.settings);}));
  }
}
