import {App,FileSystemAdapter,ItemView,Notice,Plugin,PluginSettingTab,Setting,TFile,WorkspaceLeaf,normalizePath,setIcon} from 'obsidian';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,rename} from 'node:fs/promises';
import {Meeting,patchSegment,WorkerEvent,rebaseAnchors,migrateMeeting} from './model';
import {WorkerBridge} from './bridge';
import {CalendarModal} from './calendar';

interface Settings {python:string;model:string;storage:string;device:string;lastSession:string;testAudio:string;showTime:boolean;calendarId:string;diarModel:string;diarLibrary:string;}
const DEFAULT:Settings={python:'python3',model:'',storage:'',device:'',lastSession:'',testAudio:'',showTime:false,calendarId:'',diarModel:'',diarLibrary:''};
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
    this.addCommand({id:'calendar',name:'iCloud 캘린더 · 일정 · 할 일',callback:()=>this.openCalendar()});
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
    this.overlayButton?.setAttribute('title',`${this.state} · 대기 ${this.pending}개 · ⌘⇧M 시작/중지`);
    for(const leaf of this.app.workspace.getLeavesOfType(VIEW)) if(leaf.view instanceof MeetingView && (force || !leaf.view.contentEl.contains(document.activeElement))) leaf.view.render();
  }
  async openControls(){let leaf=this.app.workspace.getLeavesOfType(VIEW)[0];if(!leaf){leaf=this.app.workspace.getRightLeaf(false)??undefined;await leaf?.setViewState({type:VIEW,active:true});}if(leaf)await this.app.workspace.revealLeaf(leaf);}
  private createOverlay(){
    this.overlay=document.body.createDiv({cls:'lm-overlay'});this.overlayButton=this.overlay.createEl('button',{cls:'lm-overlay-icon',attr:{'aria-label':'로컬 회의록 제어','aria-expanded':'false'}});setIcon(this.overlayButton,'mic');
    this.popup=this.overlay.createDiv({cls:'lm-overlay-menu'});this.popup.hidden=true;
    const action=(label:string,fn:()=>void)=>{this.popup.createEl('button',{text:label}).addEventListener('click',()=>{fn();this.popup.hidden=true;this.overlayButton.setAttribute('aria-expanded','false');});};
    action('녹음 시작 / 중지  ⌘⇧M',()=>this.toggleRecording());action('상세 보기  ⌘⌥M',()=>{void this.openControls();});action('시간 표시 켜기 / 끄기  ⌘⌥T',()=>{void this.guard(()=>this.toggleTime());});action('캘린더 · 할 일',()=>this.openCalendar());
    this.overlayButton.addEventListener('click',()=>{this.popup.hidden=!this.popup.hidden;this.overlayButton.setAttribute('aria-expanded',String(!this.popup.hidden));});
    this.registerDomEvent(document,'click',event=>{if(!this.overlay.contains(event.target as Node)){this.popup.hidden=true;this.overlayButton.setAttribute('aria-expanded','false');}});
  }
  toggleRecording(){if(this.bridge)this.stop();else void this.guard(()=>this.start());}
  async toggleControls(){const leaves=this.app.workspace.getLeavesOfType(VIEW);if(leaves.length)for(const leaf of leaves)leaf.detach();else await this.openControls();}
  openCalendar(){const adapter=this.app.vault.adapter as FileSystemAdapter;new CalendarModal(this.app,{helper:join(adapter.getBasePath(),this.manifest.dir!,'native/calendar-bridge'),calendarId:this.settings.calendarId,saveCalendar:async id=>{this.settings.calendarId=id;await this.saveData(this.settings);}}).open();}
  async toggleTime(){this.settings.showTime=!this.settings.showTime;await this.saveData(this.settings);this.writes=this.writes.then(async()=>{if(this.meeting)await this.renderSegments(this.meeting.segments.map(s=>s.id),'time');this.refresh(true);});await this.writes;new Notice(this.settings.showTime?'시간 표시 켬':'시간 표시 끔');}
  async migrateCurrentNote(){
    if(!this.meeting&&this.settings.lastSession){try{this.meeting=JSON.parse(await readFile(join(this.settings.lastSession,'meeting.json'),'utf8'));}catch{}}
    const meeting=this.meeting;if(!meeting)return;const file=this.app.vault.getAbstractFileByPath(meeting.note);if(!(file instanceof TFile))return;
    await this.app.vault.process(file,text=>migrateMeeting(text,meeting));await this.saveMeeting();
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
class MeetingView extends ItemView {
  constructor(leaf:WorkspaceLeaf,private plugin:LocalMeeting){super(leaf);}
  getViewType(){return VIEW;}
  getDisplayText(){return '로컬 회의록';}
  async onOpen(){this.render();}
  render(){
    const container=this.contentEl;container.empty();
    new Setting(container).setName('로컬 회의록 · 상세 보기').addButton(b=>b.setButtonText('최소화').onClick(()=>{void this.plugin.toggleControls();}));
    container.createEl('p',{text:`${this.plugin.state} · 대기 ${this.plugin.pending}개 · 미처리 오디오 범위 ${this.plugin.lag.toFixed(0)}초`});
    new Setting(container).addButton(b=>b.setButtonText('녹음 시작').setDisabled(!!this.plugin.bridge).onClick(()=>{void this.plugin.guard(()=>this.plugin.start());})).addButton(b=>b.setButtonText('녹음 중지').setDisabled(!this.plugin.bridge).onClick(()=>this.plugin.stop()));
    new Setting(container).addButton(b=>b.setButtonText('마지막 세션 복구').setDisabled(!!this.plugin.bridge).onClick(()=>{void this.plugin.guard(()=>this.plugin.recover());}));
    new Setting(container).addToggle(t=>t.setValue(this.plugin.settings.showTime).onChange(()=>{void this.plugin.guard(()=>this.plugin.toggleTime());})).setName('시간 표시').addButton(b=>b.setButtonText('캘린더 · 할 일').onClick(()=>this.plugin.openCalendar()));
    if(this.plugin.error)container.createEl('p',{text:this.plugin.error,cls:'lm-error'});
    const meeting=this.plugin.meeting;if(!meeting)return;
    container.createEl('p',{text:`기록 노트: ${meeting.note}`});
    container.createEl('p',{text:this.plugin.settings.diarModel&&this.plugin.settings.diarLibrary?'로컬 화자 구분 모델 연결됨 · 이름을 지정하거나 오귀속을 수정할 수 있습니다.':'화자 모델이 설정되지 않았습니다. 설정에서 연결하세요.',cls:'lm-hint'});
    for(const id of [...new Set(meeting.segments.map(s=>s.speaker))].filter(s=>s!=='unknown')){
      let name=meeting.speakers[id]??id;
      new Setting(container).setName(id).addText(t=>t.setValue(name).onChange(v=>{name=v;})).addButton(b=>b.setButtonText('이름 저장').onClick(()=>this.plugin.updateSpeaker(id,name)));
    }
    container.createEl('h4',{text:'최근 발언 · 화자 직접 지정'});
    for(const segment of meeting.segments.slice(-20)){
      let speaker=segment.speaker==='unknown'?'':segment.speaker;
      new Setting(container).setName(segment.text.slice(0,90)).setDesc(`구간 ${segment.id} · ${segment.speaker}`).addText(t=>t.setPlaceholder('예: 화자 1').setValue(speaker).onChange(v=>{speaker=v;})).addButton(b=>b.setButtonText('적용').onClick(()=>this.plugin.assignSpeaker(segment.id,speaker)));
    }
  }
}
class MeetingSettings extends PluginSettingTab {
  constructor(app:App,private plugin:LocalMeeting){super(app,plugin);}
  display(){
    this.containerEl.empty();this.containerEl.createEl('h2',{text:'로컬 회의록 설정'});
    const fields:[Exclude<keyof Settings,'showTime'>,string,string][]=[['python','Python 실행 파일','전용 venv/bin/python 절대 경로'],['model','MLX 모델 폴더','한국어 미세조정 모델을 변환한 로컬 폴더'],['storage','회의 오디오 저장 폴더','Vault 외부의 절대 경로. 원본 녹음이 보관됩니다.'],['testAudio','테스트 WAV 파일','16kHz mono PCM16 WAV 파일 절대 경로'],['diarModel','화자 구분 모델','Nemotron 3 Diarization GGUF 로컬 경로'],['diarLibrary','화자 실행 라이브러리','NeMo-Speech libnemo_speech_asr_c.dylib 경로'],['device','입력 장치 번호','비워두면 시스템 기본 마이크. 시스템 오디오 캡처는 미지원.']];
    for(const [key,name,description] of fields)new Setting(this.containerEl).setName(name).setDesc(description).addText(t=>t.setValue(this.plugin.settings[key]).onChange(async value=>{this.plugin.settings[key]=value;await this.plugin.saveData(this.plugin.settings);}));
  }
}
