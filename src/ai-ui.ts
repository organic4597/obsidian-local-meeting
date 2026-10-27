import {App,Modal,Notice,Setting} from 'obsidian';
import {AuthStatus,ModelChoice} from './openai-auth';
import {SummaryResult,MeetingEvent} from './ai-summary';
export interface AIHost {
 settings:{aiModel:string;aiAutoSummary:boolean};
 aiStatus():Promise<AuthStatus>;aiLogin(add?:boolean):Promise<void>;aiCancel():void;aiLogout():Promise<void>;aiSelect(id:string):Promise<void>;aiModels():Promise<ModelChoice[]>;saveAISettings():Promise<void>;
 testAIConnection():Promise<void>;generateSummary():Promise<void>;currentSummary():Promise<SummaryResult|null>;openSummary():Promise<void>;openCalendarDraft(event:MeetingEvent):Promise<void>;
}
export class AIControlsModal extends Modal {
 private closed=false;private busy=false;private generation=0;
 constructor(app:App,private host:AIHost){super(app);}
 onOpen(){this.setTitle('OpenAI 회의 정리');this.modalEl.addClass('lm-quality-modal');void this.render();}
 onClose(){this.closed=true;}
 private action(parent:HTMLElement,text:string,fn:()=>Promise<void>,primary=false){const b=parent.createEl('button',{text,cls:primary?'mod-cta':''});b.disabled=this.busy;b.addEventListener('click',()=>{this.busy=true;b.disabled=true;void fn().catch(e=>new Notice(String(e),10000)).finally(()=>{this.busy=false;if(!this.closed)void this.render();});});return b;}
 private async render(){
  const generation=++this.generation,status=await this.host.aiStatus();if(this.closed||generation!==this.generation)return;const root=this.contentEl;root.empty();root.createEl('p',{text:'음성 처리는 로컬에서 수행하고, AI 정리에는 최신 회의 텍스트와 화자 정보가 OpenAI로 전송됩니다. 원문과 수정한 정리 노트는 덮어쓰지 않습니다.',cls:'lm-hint'});
  const account=root.createDiv({cls:'lm-quality-toolbar'});
  if(status.accounts.length){const select=account.createEl('select',{attr:{'aria-label':'ChatGPT 계정'}});for(const a of status.accounts)select.createEl('option',{value:a.id,text:a.label+(a.signedIn?'':' · 로그아웃됨')});select.value=status.active??'';select.disabled=this.busy;select.addEventListener('change',()=>{void this.host.aiSelect(select.value).then(()=>this.render()).catch(e=>new Notice(String(e)));});}
  this.action(account,'Continue with ChatGPT',()=>this.host.aiLogin(),true);this.action(account,'다른 계정 추가',()=>this.host.aiLogin(true));
  account.createEl('button',{text:'로그인 취소'}).addEventListener('click',()=>this.host.aiCancel());
  if(status.connected)this.action(account,'로그아웃',()=>this.host.aiLogout());
  const usage=root.createDiv({cls:'lm-quality-toolbar'});usage.createSpan({text:status.planAllowed?'Using ChatGPT plan':'로그인 후 ChatGPT 사용 권한을 승인해 주세요.',cls:'lm-hint'});usage.createEl('a',{text:'사용량 관리',href:'https://chatgpt.com/settings/usage',attr:{target:'_blank',rel:'noopener'}});
  let models:ModelChoice[]=[];
  if(status.planAllowed)try{models=await this.host.aiModels();}catch(e){if(!this.closed)root.createEl('p',{text:String(e),cls:'lm-error'});}
  if(this.closed||generation!==this.generation)return;
  if(models.length){if(!models.some(m=>m.id===this.host.settings.aiModel)){this.host.settings.aiModel=models[0]!.id;await this.host.saveAISettings();}
   new Setting(root).setName('정리 모델').addDropdown(d=>{for(const m of models)d.addOption(m.id,m.name);d.setValue(this.host.settings.aiModel).onChange(async id=>{this.host.settings.aiModel=id;await this.host.saveAISettings();});});}
  new Setting(root).setName('회의 종료 후 자동 정리').setDesc('화자 구분이 끝나면 연결된 ChatGPT 계정으로 요약·할 일·일정 후보를 생성합니다.').addToggle(t=>t.setValue(this.host.settings.aiAutoSummary).onChange(async v=>{this.host.settings.aiAutoSummary=v;await this.host.saveAISettings();}));
  const test=this.action(root,'OpenAI 연결 테스트',()=>this.host.testAIConnection());test.disabled=this.busy||!status.planAllowed||!models.length;
  const actions=root.createDiv({cls:'lm-form-actions'});const generate=this.action(actions,'현재 회의 AI 정리',()=>this.host.generateSummary(),true);generate.disabled=this.busy||!status.planAllowed||!models.length;
  const result=await this.host.currentSummary();if(this.closed||generation!==this.generation||!result)return;
  this.action(actions,'정리 노트 열기',()=>this.host.openSummary());
  root.createEl('h3',{text:'일정 후보'});
  for(const e of result.value.events){const row=root.createDiv({cls:'lm-review-row'});row.createEl('strong',{text:e.title});row.createEl('p',{text:e.whenText||e.start||'시간 미정'});this.action(row,'캘린더에서 확인 후 저장',()=>this.host.openCalendarDraft(e));}
  if(!result.value.events.length)root.createEl('p',{text:'확인된 일정 후보가 없습니다.',cls:'lm-hint'});
 }
}
export class ChatGPTWelcomeModal extends Modal {
 onOpen(){this.setTitle('ChatGPT 요금제를 사용합니다');this.contentEl.createEl('p',{text:'이 플러그인의 AI 정리는 승인한 ChatGPT 요금제와 사용 한도를 사용합니다. ChatGPT 설정에서 앱 사용량과 접근 권한을 관리할 수 있습니다.'});this.contentEl.createEl('a',{text:'사용량 관리',href:'https://chatgpt.com/settings/usage',attr:{target:'_blank',rel:'noopener'}});this.contentEl.createEl('button',{text:'확인',cls:'mod-cta'}).addEventListener('click',()=>this.close());}
}
