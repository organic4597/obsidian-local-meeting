import {App,FileSystemAdapter,ItemView,Notice,Plugin,PluginSettingTab,Setting,TFile,WorkspaceLeaf,normalizePath} from 'obsidian';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {Meeting,patchSegment,WorkerEvent} from './model';
import {WorkerBridge} from './bridge';

interface Settings {python:string;model:string;storage:string;device:string;lastSession:string;}
const DEFAULT:Settings={python:'python3',model:'',storage:'',device:'',lastSession:''};
const VIEW='local-meeting-controls';
export default class LocalMeeting extends Plugin {
  settings:Settings={...DEFAULT};
  meeting?:Meeting;
  bridge?:WorkerBridge;
  state='대기'; pending=0; lag=0; error='';
  private writes:Promise<unknown>=Promise.resolve();
  private status!:HTMLElement;
  private closing=false;
  async onload(){
    this.settings=Object.assign({},DEFAULT,await this.loadData());
    this.registerView(VIEW,leaf=>new MeetingView(leaf,this));
    this.addSettingTab(new MeetingSettings(this.app,this));
    this.status=this.addStatusBarItem(); this.refresh();
    this.addRibbonIcon('mic','로컬 회의록',()=>{void this.openControls();});
    this.addCommand({id:'start',name:'현재 노트에서 회의 녹음 시작',callback:()=>{void this.guard(()=>this.start());}});
    this.addCommand({id:'stop',name:'녹음 중지 및 남은 전사 처리',callback:()=>this.stop()});
    this.addCommand({id:'recover',name:'마지막 세션 복구 및 전사 재시도',callback:()=>{void this.guard(()=>this.recover());}});
    this.addCommand({id:'controls',name:'회의 제어 및 화자 이름 관리',callback:()=>{void this.openControls();}});
  }
  async guard(action:()=>Promise<void>){try{await action();}catch(error){this.showError(String(error));}}
  showError(error:string){this.error=error;new Notice(error,8000);this.refresh();}
  refresh(){
    this.status?.setText(`회의: ${this.state} · 대기 ${this.pending} · ${this.lag.toFixed(0)}초`);
    for(const leaf of this.app.workspace.getLeavesOfType(VIEW)) if(leaf.view instanceof MeetingView && !leaf.view.contentEl.contains(document.activeElement)) leaf.view.render();
  }
  async openControls(){let leaf=this.app.workspace.getLeavesOfType(VIEW)[0];if(!leaf){leaf=this.app.workspace.getRightLeaf(false)??undefined;await leaf?.setViewState({type:VIEW,active:true});}if(leaf)await this.app.workspace.revealLeaf(leaf);}
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
  }
  async start(){
    this.validate();
    const note=this.app.workspace.getActiveFile();
    if(!(note instanceof TFile)||note.extension!=='md') throw new Error('회의를 기록할 Markdown 노트를 먼저 여세요.');
    const id=randomUUID(); const directory=join(this.root(),id);
    await mkdir(directory,{recursive:true});
    this.meeting={id,note:note.path,directory,started:new Date().toISOString(),speakers:{},segments:[],rendered:{}};
    await this.saveMeeting();
    this.settings.lastSession=directory; await this.saveData(this.settings);
    await this.app.vault.process(note,text=>text+`\n\n## 회의 기록 (${new Date().toLocaleString()})\n\n> 로컬 전사 · 화자 구분 미연결 · 시간은 오디오 구간 기준\n`);
    this.launch(false); await this.openControls();
  }
  async recover(){
    this.validate();
    if(!this.settings.lastSession) throw new Error('복구할 세션이 없습니다.');
    const directory=this.settings.lastSession;
    if(!directory.startsWith(this.root()+'/')) throw new Error('세션 저장 경로가 현재 설정과 다릅니다.');
    const data=JSON.parse(await readFile(join(directory,'meeting.json'),'utf8')) as Meeting;
    if(!data.id||!data.note||!Array.isArray(data.segments)||data.directory!==directory) throw new Error('잘못된 세션 파일');
    if(!(this.app.vault.getAbstractFileByPath(data.note) instanceof TFile)) throw new Error('원래 회의 노트를 찾을 수 없습니다.');
    this.meeting=data; this.launch(true); await this.openControls();
  }
  private launch(resume:boolean){
    const meeting=this.meeting!;
    const adapter=this.app.vault.adapter as FileSystemAdapter;
    const script=join(adapter.getBasePath(),this.manifest.dir!,'worker','main.py');
    this.error='';this.state=resume?'복구 중':'녹음 시작 중';this.closing=false;
    const bridge=new WorkerBridge(event=>this.receive(event),()=>{
      this.bridge=undefined;this.state='종료';this.refresh();this.writes=this.writes.then(()=>this.saveMeeting()).catch(error=>this.showError(String(error)));
    });
    this.bridge=bridge;
    try {bridge.start(this.settings.python,script,this.settings.model,meeting.directory,resume,this.settings.device);}
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
        if(index>=0) event.segment.speaker=meeting.segments[index]!.speaker;
        if(index>=0)meeting.segments[index]=event.segment;else meeting.segments.push(event.segment);
        await this.renderSegments([event.segment.id]);
      }).catch(error=>this.showError(String(error)));
    }
    this.refresh();
  }
  private async saveMeeting(){if(this.meeting){const file=join(this.meeting.directory,'meeting.json');await writeFile(file+'.tmp',JSON.stringify(this.meeting,null,2));const {rename}=await import('node:fs/promises');await rename(file+'.tmp',file);}}
  private async renderSegments(ids:string[]){
    const meeting=this.meeting;if(!meeting)return;
    const file=this.app.vault.getAbstractFileByPath(normalizePath(meeting.note));
    if(!(file instanceof TFile))throw new Error('회의 대상 노트를 찾을 수 없습니다. 원본 오디오는 저장됩니다.');
    const old={...meeting.rendered};
    try {
      await this.app.vault.process(file,text=>{for(const id of ids){const segment=meeting.segments.find(s=>s.id===id);if(segment)text=patchSegment(text,meeting,segment);}return text;});
      await this.saveMeeting();
    }catch(error){meeting.rendered=old;throw error;}
    this.refresh();
  }
  updateSpeaker(id:string,name:string){
    this.writes=this.writes.then(async()=>{if(!this.meeting)return;this.meeting.speakers[id]=name.trim()||id;await this.renderSegments(this.meeting.segments.filter(s=>s.speaker===id).map(s=>s.id));}).catch(error=>this.showError(String(error)));
  }
  assignSpeaker(segmentId:string,speaker:string){
    this.writes=this.writes.then(async()=>{const s=this.meeting?.segments.find(s=>s.id===segmentId);if(!s)return;s.speaker=speaker.trim()||'unknown';await this.renderSegments([s.id]);}).catch(error=>this.showError(String(error)));
  }
  stop(){if(this.bridge&&!this.closing){this.closing=true;this.state='녹음 종료 요청 / 남은 전사 처리';this.bridge.stop();this.refresh();}}
  onunload(){this.bridge?.dispose();}
}
class MeetingView extends ItemView {
  constructor(leaf:WorkspaceLeaf,private plugin:LocalMeeting){super(leaf);}
  getViewType(){return VIEW;}
  getDisplayText(){return '로컬 회의록';}
  async onOpen(){this.render();}
  render(){
    const container=this.contentEl;container.empty();
    container.createEl('h3',{text:'로컬 회의록'});
    container.createEl('p',{text:`${this.plugin.state} · 대기 ${this.plugin.pending}개 · 미처리 오디오 범위 ${this.plugin.lag.toFixed(0)}초`});
    new Setting(container).addButton(b=>b.setButtonText('녹음 시작').setDisabled(!!this.plugin.bridge).onClick(()=>{void this.plugin.guard(()=>this.plugin.start());})).addButton(b=>b.setButtonText('녹음 중지').setDisabled(!this.plugin.bridge).onClick(()=>this.plugin.stop()));
    new Setting(container).addButton(b=>b.setButtonText('마지막 세션 복구').setDisabled(!!this.plugin.bridge).onClick(()=>{void this.plugin.guard(()=>this.plugin.recover());}));
    if(this.plugin.error)container.createEl('p',{text:this.plugin.error,cls:'lm-error'});
    const meeting=this.plugin.meeting;if(!meeting)return;
    container.createEl('p',{text:`기록 노트: ${meeting.note}`});
    container.createEl('p',{text:'현재 버전: 화자는 직접 지정합니다. 자동 화자 구분과 요약은 아직 연결되지 않았습니다.',cls:'lm-hint'});
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
    const fields:[keyof Settings,string,string][]=[['python','Python 실행 파일','전용 venv/bin/python 절대 경로'],['model','MLX 모델 폴더','한국어 미세조정 모델을 변환한 로컬 폴더'],['storage','회의 오디오 저장 폴더','Vault 외부의 절대 경로. 원본 녹음이 보관됩니다.'],['device','입력 장치 번호','비워두면 시스템 기본 마이크. 시스템 오디오 캡처는 미지원.']];
    for(const [key,name,description] of fields)new Setting(this.containerEl).setName(name).setDesc(description).addText(t=>t.setValue(this.plugin.settings[key]).onChange(async value=>{this.plugin.settings[key]=value;await this.plugin.saveData(this.plugin.settings);}));
  }
}
