import {App,FileSystemAdapter,ItemView,Notice,Plugin,PluginSettingTab,Setting,TFile,WorkspaceLeaf,Modal,normalizePath,setIcon} from 'obsidian';
import {existsSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,rename} from 'node:fs/promises';
import {Meeting,patchSegment,WorkerEvent,rebaseAnchors,migrateMeeting,speakerName,timestamp} from './model';
import {WorkerBridge} from './bridge';
import {CalendarModal,TaskModal} from './calendar';
import {attachOverlayDrag,OverlayPosition} from './overlay';

interface Settings {python:string;model:string;storage:string;device:string;lastSession:string;testAudio:string;showTime:boolean;calendarId:string;diarModel:string;diarLibrary:string;overlayPosition:OverlayPosition|null;}
const DEFAULT:Settings={python:'python3',model:'',storage:'',device:'',lastSession:'',testAudio:'',showTime:false,calendarId:'',diarModel:'',diarLibrary:'',overlayPosition:null};
const VIEW='local-meeting-controls';
export default class LocalMeeting extends Plugin {
  settings:Settings={...DEFAULT};
  meeting?:Meeting;
  bridge?:WorkerBridge;
  state='대기'; pending=0; lag=0; error='';
  private writes:Promise<unknown>=Promise.resolve();
  private status!:HTMLElement;
  private closing=false;
  private transitioning=false;
  private overlay!:HTMLElement;
  private overlayButton!:HTMLButtonElement;
  private overlayState!:HTMLElement;
  private overlayDrag?:ReturnType<typeof attachOverlayDrag>;
  private popup!:HTMLElement;
  private persistTimer?:number;
  async onload(){
    this.settings=Object.assign({},DEFAULT,await this.loadData());
    this.registerView(VIEW,leaf=>new MeetingView(leaf,this));
    this.registerObsidianProtocolHandler('local-meeting',params=>{
      void this.guard(async()=>{
        if(params.op==='time'){await this.toggleTime();return;}
        if(params.op==='minimize'){for(const leaf of this.app.workspace.getLeavesOfType(VIEW))leaf.detach();return;}
        if(params.op==='calendar'){this.openCalendar();return;}
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
    this.app.workspace.onLayoutReady(()=>{void this.guard(()=>this.migrateCurrentNote());});
    this.status=this.addStatusBarItem();this.createOverlay();this.refresh();
    this.registerEvent(this.app.workspace.on('editor-change',(editor,info)=>{
      const meeting=this.meeting;if(!meeting||info.file?.path!==meeting.note)return;
      const value=editor.getValue();if(meeting.noteSnapshot!==undefined)rebaseAnchors(meeting,meeting.noteSnapshot,value);
      window.clearTimeout(this.persistTimer);this.persistTimer=window.setTimeout(()=>{this.writes=this.writes.then(()=>this.saveMeeting()).catch(error=>this.showError(String(error)));},400);
    }));
    this.addRibbonIcon('mic','로컬 회의록',()=>{void this.openControls();});
    this.addCommand({id:'toggle',name:'녹음 시작 / 중지',hotkeys:[{modifiers:['Mod','Shift'],key:'M'}],callback:()=>this.toggleRecording()});
    this.addCommand({id:'timestamps',name:'시간 표시 켜기 / 끄기',hotkeys:[{modifiers:['Mod','Alt'],key:'T'}],callback:()=>{void this.guard(()=>this.toggleTime());}});
    this.addCommand({id:'calendar',name:'연결된 캘린더 열기',hotkeys:[{modifiers:['Mod','Alt'],key:'C'}],callback:()=>this.openCalendar()});
    this.addCommand({id:'task',name:'현재 노트에 할 일 추가',callback:()=>new TaskModal(this.app).open()});
    this.addCommand({id:'start',name:'현재 노트에서 회의 녹음 시작',callback:()=>{void this.guard(()=>this.start());}});
    this.addCommand({id:'stop',name:'녹음 중지 및 남은 전사 처리',callback:()=>this.stop()});
    this.addCommand({id:'recover',name:'마지막 세션 복구 및 전사 재시도',callback:()=>{void this.guard(()=>this.recover());}});
    this.addCommand({id:'test-audio',name:'테스트 WAV를 현재 노트에 전사',callback:()=>{void this.guard(()=>this.start(this.settings.testAudio));}});
    this.addCommand({id:'controls',name:'상세 보기 / 최소화',hotkeys:[{modifiers:['Mod','Alt'],key:'M'}],callback:()=>{void this.toggleControls();}});
  }
  async guard(action:()=>Promise<void>){try{await action();}catch(error){this.showError(String(error));}}
  showError(error:string){this.error=error;new Notice(error,8000);this.refresh();}
  refresh(force=false){
    this.status?.setText(`회의: ${this.state} · 대기 ${this.pending} · ${this.lag.toFixed(0)}초`);
    this.overlay?.toggleClass('is-running',!!this.bridge&&!this.closing);this.overlay?.toggleClass('is-processing',!!this.bridge&&this.closing);this.overlay?.toggleClass('has-error',!!this.error);
    this.overlayButton?.setAttribute('aria-label',`로컬 회의록: ${this.state}. 대기 ${this.pending}개. 클릭하면 제어 메뉴를 엽니다.`);
    this.overlayButton?.setAttribute('title',`${this.state} · 대기 ${this.pending}개\n드래그하여 이동 · 클릭하여 메뉴 · ⌘⇧M 시작/중지`);
    this.overlayState?.setText(this.bridge?(this.closing?'처리 중':this.state.includes('녹음')?'녹음 중':'작동 중'):(this.error?'확인 필요':'대기'));
    for(const leaf of this.app.workspace.getLeavesOfType(VIEW)) if(leaf.view instanceof MeetingView) leaf.view.render(force);
  }
  async openControls(){let leaf=this.app.workspace.getLeavesOfType(VIEW)[0];if(!leaf){leaf=this.app.workspace.getRightLeaf(false)??undefined;await leaf?.setViewState({type:VIEW,active:true});}if(leaf)await this.app.workspace.revealLeaf(leaf);}
  private createOverlay(){
    this.overlay=document.body.createDiv({cls:'lm-overlay'});this.overlayButton=this.overlay.createEl('button',{cls:'lm-overlay-icon',attr:{'aria-label':'로컬 회의록 제어','aria-expanded':'false'}});setIcon(this.overlayButton,'mic');
    this.overlayButton.createSpan({cls:'lm-overlay-label',text:'회의록'});
    this.overlayState=this.overlayButton.createSpan({cls:'lm-overlay-state',text:'대기'});
    this.popup=this.overlay.createDiv({cls:'lm-overlay-menu'});this.popup.hidden=true;
    const action=(label:string,fn:()=>void)=>{this.popup.createEl('button',{text:label}).addEventListener('click',()=>{fn();this.popup.hidden=true;this.overlayButton.setAttribute('aria-expanded','false');});};
    this.overlayDrag=attachOverlayDrag({overlay:this.overlay,button:this.overlayButton,menu:this.popup,getPosition:()=>this.settings.overlayPosition,savePosition:position=>{this.settings.overlayPosition=position;void this.guard(()=>this.saveData(this.settings));}});
    this.register(()=>this.overlayDrag?.dispose());
    action('녹음 시작 / 중지  ⌘⇧M',()=>this.toggleRecording());action('상세 보기  ⌘⌥M',()=>{void this.openControls();});action('시간 표시 켜기 / 끄기  ⌘⌥T',()=>{void this.guard(()=>this.toggleTime());});action('캘린더  ⌘⌥C',()=>this.openCalendar());action('노트에 할 일 추가',()=>new TaskModal(this.app).open());
    action('버튼 위치 초기화',()=>{this.settings.overlayPosition=null;this.overlayDrag?.refreshPosition();void this.guard(()=>this.saveData(this.settings));});
    this.overlayButton.addEventListener('click',()=>{this.popup.hidden=!this.popup.hidden;this.overlayButton.setAttribute('aria-expanded',String(!this.popup.hidden));this.overlayDrag?.layoutMenu();});
    this.registerDomEvent(document,'keydown',event=>{if(event.key==='Escape'&&!this.popup.hidden){this.popup.hidden=true;this.overlayButton.setAttribute('aria-expanded','false');this.overlayButton.focus();}});
    this.registerDomEvent(document,'click',event=>{if(!this.overlay.contains(event.target as Node)){this.popup.hidden=true;this.overlayButton.setAttribute('aria-expanded','false');}});
  }
  get isStopping(){return this.closing&&!!this.bridge;}
  toggleRecording(){if(this.bridge)this.stop();else void this.guard(()=>this.start());}
  async toggleControls(){const leaves=this.app.workspace.getLeavesOfType(VIEW);if(leaves.length)for(const leaf of leaves)leaf.detach();else await this.openControls();}
  openCalendar(){const adapter=this.app.vault.adapter as FileSystemAdapter;new CalendarModal(this.app,{helper:join(adapter.getBasePath(),this.manifest.dir!,'native/calendar-bridge'),calendarId:this.settings.calendarId,saveCalendar:async id=>{this.settings.calendarId=id;await this.saveData(this.settings);}}).open();}
  async toggleTime(){this.settings.showTime=!this.settings.showTime;await this.saveData(this.settings);this.writes=this.writes.then(async()=>{if(this.meeting)await this.renderSegments(this.meeting.segments.map(s=>s.id),'time');this.refresh(true);});await this.writes;new Notice(this.settings.showTime?'시간 표시 켬':'시간 표시 끔');}
  async migrateCurrentNote(){
    if(!this.meeting&&this.settings.lastSession){try{this.meeting=JSON.parse(await readFile(join(this.settings.lastSession,'meeting.json'),'utf8'));}catch{}}
    const meeting=this.meeting;if(!meeting)return;const file=this.app.vault.getAbstractFileByPath(meeting.note);if(!(file instanceof TFile))return;
    await this.app.vault.process(file,text=>migrateMeeting(text,meeting));await this.saveMeeting();this.refresh();
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
    if(this.bridge) throw new Error('기존 전사가 종료될 때까지 기다리세요.');
    if(!isAbsolute(this.settings.model)) throw new Error('로컬 MLX 모델 폴더의 절대 경로가 필요합니다.');
    this.root();
    if(!this.settings.diarModel||!this.settings.diarLibrary)throw new Error('설정에서 자동 화자 구분 모델과 네이티브 라이브러리를 연결하세요.');
  }
  async start(inputWav?:string){
    if(this.transitioning)return;
    this.validate();this.transitioning=true;
    try {
    await this.writes;
    if(inputWav!==undefined && !isAbsolute(inputWav))throw new Error('설정에서 테스트 WAV 절대 경로를 지정하세요.');
    const note=this.app.workspace.getActiveFile();
    if(!(note instanceof TFile)||note.extension!=='md') throw new Error('회의를 기록할 Markdown 노트를 먼저 여세요.');
    const id=randomUUID(); const directory=join(this.root(),id);
    await mkdir(directory,{recursive:true});
    this.meeting={id,note:note.path,directory,started:new Date().toISOString(),speakers:{},segments:[],rendered:{}};
    await this.saveMeeting();
    this.settings.lastSession=directory; await this.saveData(this.settings);
    this.meeting.noteSnapshot=await this.app.vault.read(note);
    this.launch(false,inputWav);
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
  private launch(resume:boolean,inputWav?:string){
    const meeting=this.meeting!;
    const adapter=this.app.vault.adapter as FileSystemAdapter;
    const script=join(adapter.getBasePath(),this.manifest.dir!,'worker','main.py');
    this.error='';this.state=resume?'복구 중':'녹음 시작 중';this.closing=false;
    const bridge=new WorkerBridge(event=>this.receive(event),()=>{
      this.bridge=undefined;this.state='종료';this.refresh();this.writes=this.writes.then(()=>this.saveMeeting()).catch(error=>this.showError(String(error)));
    });
    this.bridge=bridge;
    try {bridge.start(this.settings.python,script,this.settings.model,meeting.directory,resume,this.settings.device,inputWav,this.settings.diarModel,this.settings.diarLibrary);}
    catch(error){this.bridge=undefined;this.state='오류';throw error;}
    this.refresh();
  }
  receive(event:WorkerEvent){
    if(event.type==='error'){this.showError(event.message);return;}
    if(event.type==='status'){this.state=event.state;this.pending=event.pending;this.lag=event.lag;}
    if(event.type==='ready'){this.state='전사 준비 완료';}
    if(event.type==='segment'){
      this.writes=this.writes.then(async()=>{
        const meeting=this.meeting;if(!meeting)return;
        const index=meeting.segments.findIndex(s=>s.id===event.segment.id);
        // Manual speaker corrections survive worker replay after a crash.
        if(index>=0 && (meeting.segments[index]!.speakerLocked||(event.segment.speaker==='unknown'&&meeting.segments[index]!.speaker!=='unknown'))){event.segment.speaker=meeting.segments[index]!.speaker;event.segment.speakerLocked=true;}
        if(index>=0)meeting.segments[index]=event.segment;else meeting.segments.push(event.segment);
        await this.renderSegments([event.segment.id]);
      }).catch(error=>this.showError(String(error)));
    }
    this.refresh();
  }
  private async saveMeeting(){if(this.meeting){const file=join(this.meeting.directory,'meeting.json');await writeFile(file+'.tmp',JSON.stringify(this.meeting,null,2));await rename(file+'.tmp',file);}}
  private async renderSegments(ids:string[],mode:'normal'|'time'|'speaker'='normal'){
    const meeting=this.meeting;if(!meeting)return;
    const file=this.app.vault.getAbstractFileByPath(normalizePath(meeting.note));
    if(!(file instanceof TFile))throw new Error('회의 대상 노트를 찾을 수 없습니다. 원본 오디오는 저장됩니다.');
    const old={...meeting.rendered};const oldAnchors=structuredClone(meeting.anchors);const oldSnapshot=meeting.noteSnapshot;
    try {
      await this.app.vault.process(file,text=>{for(const id of ids){const segment=meeting.segments.find(s=>s.id===id);if(segment)text=patchSegment(text,meeting,segment,this.settings.showTime,mode);}return text;});
      await this.saveMeeting();
    }catch(error){meeting.rendered=old;meeting.anchors=oldAnchors;meeting.noteSnapshot=oldSnapshot;throw error;}
    this.refresh();
  }
  updateSpeaker(id:string,name:string){
    this.writes=this.writes.then(async()=>{if(!this.meeting)return;this.meeting.speakers[id]=name.trim()||id;await this.renderSegments(this.meeting.segments.filter(s=>s.speaker===id).map(s=>s.id),'speaker');this.refresh(true);}).catch(error=>this.showError(String(error)));
  }
  assignSpeaker(segmentId:string,speaker:string){
    this.writes=this.writes.then(async()=>{const s=this.meeting?.segments.find(s=>s.id===segmentId);if(!s)return;s.speaker=speaker.trim()||'unknown';s.speakerLocked=true;await this.renderSegments([s.id],'speaker');this.refresh(true);}).catch(error=>this.showError(String(error)));
  }
  stop(){if(this.bridge&&!this.closing){this.closing=true;this.state='녹음 종료 요청 / 남은 전사 처리';this.bridge.stop();this.refresh();}}
  onunload(){window.clearTimeout(this.persistTimer);this.bridge?.dispose();this.overlay?.remove();}
}
function participantLabel(id:string,meeting:Meeting){return speakerName({id:'',speaker:id,text:'',start:0,end:0},meeting.speakers);}
class ParticipantModal extends Modal {
  constructor(app:App,private plugin:LocalMeeting,private onAdded?:(id:string)=>void){super(app);}
  onOpen(){this.setTitle('참여자 추가');this.modalEl.addClass('lm-editor-modal');const form=this.contentEl.createEl('form');const label=form.createEl('label',{cls:'lm-form-field'});label.createSpan({text:'참여자 이름'});const input=label.createEl('input',{type:'text',attr:{placeholder:'예: 김민수',maxlength:'60'}});form.createEl('p',{text:'참여자를 추가한 뒤 발언의 화자를 이 이름으로 변경할 수 있습니다.',cls:'lm-hint'});const error=form.createDiv({cls:'lm-form-error',attr:{role:'alert'}});const actions=form.createDiv({cls:'lm-form-actions'});actions.createEl('button',{type:'submit',text:'참여자 추가',cls:'mod-cta'});form.addEventListener('submit',event=>{event.preventDefault();if(!input.value.trim()){error.setText('이름을 입력해 주세요.');input.focus();return;}const id='manual_'+randomUUID();this.plugin.updateSpeaker(id,input.value);this.onAdded?.(id);this.close();});window.setTimeout(()=>{if(input.isConnected)input.focus();},0);}
}
class MeetingView extends ItemView {
  private fingerprint='';private stateEl?:HTMLElement;private queueEl?:HTMLElement;private lagEl?:HTMLElement;private recordEl?:HTMLButtonElement;private recordIcon?:HTMLElement;private recordLabel?:HTMLElement;
  constructor(leaf:WorkspaceLeaf,private plugin:LocalMeeting){super(leaf);}
  getViewType(){return VIEW;}
  getDisplayText(){return '로컬 회의록';}
  getIcon(){return 'mic';}
  async onOpen(){this.render();}
  render(force=false){
    const p=this.plugin,meeting=p.meeting,active=p.app.workspace.getActiveFile(),ready=active instanceof TFile&&active.extension==='md';
    if(this.recordEl){const key=p.isStopping?'stopping':p.bridge?'recording':'idle';if(this.recordEl.dataset.state!==key){this.recordEl.dataset.state=key;setIcon(this.recordIcon!,p.bridge?'square':'mic');this.recordLabel!.setText(p.isStopping?'남은 발언 처리 중…':p.bridge?'녹음 종료':'현재 노트에 녹음 시작');this.recordEl.toggleClass('mod-cta',!p.bridge);}this.recordEl.disabled=p.isStopping||(!p.bridge&&!ready);}
    this.stateEl?.setText(p.state);this.queueEl?.setText(`${p.pending}개`);this.lagEl?.setText(`${p.lag.toFixed(0)}초`);
    const fingerprint=JSON.stringify([!!p.bridge,p.isStopping,p.error,p.settings.showTime,p.settings.diarModel,p.settings.diarLibrary,active?.path,meeting?.note,meeting?.segments.slice(-20),meeting?.speakers]);
    if(!force&&this.fingerprint===fingerprint)return;
    if(!force&&this.contentEl.contains(document.activeElement)&&['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName??''))return;
    this.fingerprint=fingerprint;const container=this.contentEl,scroll=container.scrollTop;
    const folds=new Map(Array.from(container.querySelectorAll<HTMLDetailsElement>('details')).map(d=>[d.dataset.section,d.open]));container.empty();container.addClass('lm-panel');
    const heading=container.createDiv({cls:'lm-panel-heading'});heading.createEl('h3',{text:'회의록'});const minimize=heading.createEl('button',{cls:'lm-icon-button',attr:{'aria-label':'상세 보기 최소화',title:'최소화 · ⌘⌥M'}});setIcon(minimize,'minimize-2');minimize.addEventListener('click',()=>{void p.toggleControls();});
    const status=container.createDiv({cls:'lm-session-state'+(p.bridge?' is-running':'')});status.createSpan({cls:'lm-connection-dot'});this.stateEl=status.createSpan({text:p.state,attr:{role:'status','aria-live':'polite'}});
    const record=container.createEl('button',{cls:'lm-primary-control'+(!p.bridge?' mod-cta':''),attr:{title:'⌘⇧M'}});this.recordEl=record;record.dataset.state=p.isStopping?'stopping':p.bridge?'recording':'idle';this.recordIcon=record.createSpan();setIcon(this.recordIcon,p.bridge?'square':'mic');this.recordLabel=record.createSpan({text:p.isStopping?'남은 발언 처리 중…':p.bridge?'녹음 종료':'현재 노트에 녹음 시작'});record.disabled=p.isStopping||(!p.bridge&&!ready);record.addEventListener('click',()=>p.toggleRecording());
    const target=container.createDiv({cls:'lm-recording-target'});if(p.bridge&&meeting){target.createSpan({text:'기록 중인 노트 · '});const note=target.createEl('button',{text:meeting.note.split('/').pop()?.replace(/\.md$/,'')??meeting.note});note.addEventListener('click',()=>{const f=p.app.vault.getAbstractFileByPath(meeting.note);if(f instanceof TFile)void p.app.workspace.getLeaf(false).openFile(f);});}else target.setText(ready?`시작하면 ‘${active.basename}’에 기록합니다.`:'기록할 Markdown 노트를 먼저 열어 주세요.');
    const metrics=container.createDiv({cls:'lm-metrics'});const queue=metrics.createDiv({cls:'lm-metric'});this.queueEl=queue.createEl('strong',{text:`${p.pending}개`});queue.createSpan({text:'처리 대기'});const lag=metrics.createDiv({cls:'lm-metric'});this.lagEl=lag.createEl('strong',{text:`${p.lag.toFixed(0)}초`});lag.createSpan({text:'미처리 오디오 범위'});
    if(p.error){const error=container.createDiv({cls:'lm-error',attr:{role:'alert'}});error.setText(p.error);}
    new Setting(container).setName('발언 시간 표시').addToggle(t=>t.setValue(p.settings.showTime).onChange(()=>{void p.guard(()=>p.toggleTime());}));
    const quick=container.createDiv({cls:'lm-quick-actions'});quick.createEl('button',{text:'캘린더 열기',attr:{title:'⌘⌥C'}}).addEventListener('click',()=>p.openCalendar());quick.createEl('button',{text:'할 일 추가'}).addEventListener('click',()=>new TaskModal(this.app).open());
    if(meeting){
      const title=container.createDiv({cls:'lm-section-title'});title.createSpan({text:'참여자'});const add=title.createEl('button',{cls:'lm-icon-button',attr:{'aria-label':'참여자 추가',title:'참여자 추가'}});setIcon(add,'user-plus');add.addEventListener('click',()=>new ParticipantModal(this.app,p).open());
      container.createEl('p',{text:p.settings.diarModel&&p.settings.diarLibrary?'목소리별로 구분합니다. 이름을 입력하고 저장하세요.':'자동 화자 구분 모델을 설정에서 연결해 주세요.',cls:'lm-hint'});
      const ids=[...new Set([...meeting.segments.map(s=>s.speaker),...Object.keys(meeting.speakers)])].filter(id=>id!=='unknown'&&id!=='overlap');
      if(!ids.length)container.createEl('p',{text:'첫 발언이 처리되면 참여자가 표시됩니다.',cls:'lm-hint'});
      for(const [index,id] of ids.entries()){const row=container.createDiv({cls:'lm-participant-row'});row.createSpan({text:`참여자 ${index+1}`,cls:'lm-participant-label'});const input=row.createEl('input',{type:'text',value:participantLabel(id,meeting),attr:{'aria-label':`참여자 ${index+1} 이름`,maxlength:'60'}});const save=row.createEl('button',{cls:'lm-icon-button',attr:{'aria-label':`참여자 ${index+1} 이름 저장`,title:'이름 저장 · Enter'}});setIcon(save,'check');const apply=()=>{if(!input.value.trim()){new Notice('화자 이름을 입력해 주세요.');input.focus();return;}p.updateSpeaker(id,input.value);new Notice('화자 이름을 저장했습니다.');};save.addEventListener('click',apply);input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();apply();}});}
      const details=container.createEl('details');details.dataset.section='speakers';details.open=folds.get('speakers')??false;details.createEl('summary',{text:`발언별 화자 수정 · 최근 ${Math.min(20,meeting.segments.length)}개`});details.createEl('p',{text:'다르게 구분된 발언의 화자를 선택하면 노트에도 반영됩니다.',cls:'lm-hint'});
      for(const segment of meeting.segments.slice(-20).reverse()){const row=details.createDiv({cls:'lm-utterance'});row.createEl('p',{text:`${p.settings.showTime?timestamp(segment.start)+' · ':''}${participantLabel(segment.speaker,meeting)}: ${segment.text}`});const select=row.createEl('select',{attr:{'aria-label':`발언 화자 변경: ${segment.text.slice(0,35)}`}});for(const id of ['unknown',...ids,'overlap'])select.createEl('option',{value:id,text:participantLabel(id,meeting)});select.createEl('option',{value:'__new__',text:'+ 새 참여자 추가'});select.value=segment.speaker;select.addEventListener('change',()=>{if(select.value==='__new__'){select.value=segment.speaker;new ParticipantModal(this.app,p,id=>p.assignSpeaker(segment.id,id)).open();}else p.assignSpeaker(segment.id,select.value);});}
      if(meeting.note!==active?.path||!p.bridge)container.createEl('p',{text:`최근 세션: ${meeting.note}`,cls:'lm-recording-target'});
    }
    const advanced=container.createEl('details');advanced.dataset.section='advanced';advanced.open=folds.get('advanced')??false;advanced.createEl('summary',{text:'세션 복구 · 단축키'});advanced.createEl('p',{text:'중단된 세션의 저장된 오디오를 다시 처리합니다.',cls:'lm-hint'});const recover=advanced.createEl('button',{text:'마지막 세션 복구'});recover.disabled=!!p.bridge||!p.settings.lastSession;recover.addEventListener('click',()=>{void p.guard(()=>p.recover());});advanced.createEl('p',{text:'⌘⇧M  녹음 시작·종료\n⌘⌥M  상세 보기·최소화\n⌘⌥T  발언 시간 표시\n⌘⌥C  캘린더 열기',cls:'lm-shortcuts',attr:{style:'white-space:pre-line'}});container.scrollTop=scroll;
  }
}
class MeetingSettings extends PluginSettingTab {
  constructor(app:App,private plugin:LocalMeeting){super(app,plugin);}
  display(){
    this.containerEl.empty();this.containerEl.createEl('h2',{text:'로컬 회의록 설정'});
    const fields:[Exclude<keyof Settings,'showTime'|'overlayPosition'>,string,string][]=[['python','Python 실행 파일','전용 venv/bin/python 절대 경로'],['model','MLX 모델 폴더','한국어 미세조정 모델을 변환한 로컬 폴더'],['storage','회의 오디오 저장 폴더','Vault 외부의 절대 경로. 원본 녹음이 보관됩니다.'],['testAudio','테스트 WAV 파일','16kHz mono PCM16 WAV 파일 절대 경로'],['diarModel','화자 구분 모델','Nemotron 3 Diarization GGUF 로컬 경로'],['diarLibrary','화자 실행 라이브러리','NeMo-Speech libnemo_speech_asr_c.dylib 경로'],['device','입력 장치 번호','비워두면 시스템 기본 마이크. 시스템 오디오 캡처는 미지원.']];
    this.containerEl.createEl('p',{text:'녹음과 모델 처리는 이 Mac에서 실행합니다. 마이크 입력과 저장 위치를 확인하세요.',cls:'lm-hint'});
    const configured=existsSync(this.plugin.settings.model)&&existsSync(this.plugin.settings.diarModel)&&existsSync(this.plugin.settings.diarLibrary);
    this.containerEl.createEl('p',{text:configured?'STT · 화자 구분 모델 파일이 준비되어 있습니다.':'모델 경로를 확인해 주세요. 아래에서 로컬 파일을 연결할 수 있습니다.',cls:configured?'lm-hint':'lm-error'});
    const basic=this.containerEl.createDiv();const advanced=this.containerEl.createEl('details');advanced.open=!configured;advanced.createEl('summary',{text:'로컬 모델 · 실행 환경 설정'});
    for(const [key,name,description] of fields)new Setting(['storage','device'].includes(key)?basic:advanced).setName(name).setDesc(description).addText(t=>t.setValue(this.plugin.settings[key]).onChange(async value=>{this.plugin.settings[key]=value;await this.plugin.saveData(this.plugin.settings);}));
  }
}
