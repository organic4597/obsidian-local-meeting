import {App,Modal,Notice,Setting} from 'obsidian';
import {AuthStatus,ModelChoice} from './openai-auth';
import {SummaryResult,MeetingEvent} from './ai-summary';
import {eventDateLabel} from './meeting-dates';
export interface AIHost {
 settings:{aiModel:string;aiAutoSummary:boolean};
 aiStatus():Promise<AuthStatus>;aiLogin(add?:boolean):Promise<void>;aiCancel():void;aiLogout():Promise<void>;aiSelect(id:string):Promise<void>;aiModels():Promise<ModelChoice[]>;saveAISettings():Promise<void>;
 testAIConnection():Promise<void>;generateSummary():Promise<void>;currentSummary():Promise<SummaryResult|null>;openSummary():Promise<void>;refreshSummaryLayout():Promise<void>;openCalendarDraft(event:MeetingEvent):Promise<void>;
}
export class AIControlsModal extends Modal {
 private closed=false;private busy=false;private generation=0;
 constructor(app:App,private host:AIHost){super(app);}
 onOpen(){this.setTitle('회의 정리');this.modalEl.addClass('lm-quality-modal');void this.render();}
 onClose(){this.closed=true;}
 private action(parent:HTMLElement,text:string,fn:()=>Promise<void>,primary=false){const b=parent.createEl('button',{text,cls:primary?'mod-cta':''});b.disabled=this.busy;b.addEventListener('click',()=>{this.busy=true;b.disabled=true;void fn().catch(e=>new Notice(String(e),10000)).finally(()=>{this.busy=false;if(!this.closed)void this.render();});});return b;}
 private async render(){
  const generation=++this.generation,status=await this.host.aiStatus();if(this.closed||generation!==this.generation)return;const root=this.contentEl,scroll=root.scrollTop,folds=new Map(Array.from(root.querySelectorAll<HTMLDetailsElement>('details[data-section]')).map(d=>[d.dataset.section,d.open]));root.empty();
  root.createEl('p',{text:status.planAllowed?'ChatGPT 연결됨 · 음성은 로컬에 보관하고 회의 텍스트만 정리합니다.':'ChatGPT로 연결해 요약·할 일·일정을 정리하세요.',cls:'lm-hint'});
  if(!status.planAllowed){this.action(root,'Continue with ChatGPT',()=>this.host.aiLogin(),true);root.createEl('button',{text:'로그인 취소'}).addEventListener('click',()=>this.host.aiCancel());}
  let models:ModelChoice[]=[];if(status.planAllowed)try{models=await this.host.aiModels();}catch(e){if(!this.closed)root.createEl('p',{text:String(e),cls:'lm-error'});}
  if(this.closed||generation!==this.generation)return;
  if(models.length&&!models.some(m=>m.id===this.host.settings.aiModel)){this.host.settings.aiModel=models[0]!.id;await this.host.saveAISettings();}
  const result=await this.host.currentSummary();if(this.closed||generation!==this.generation)return;
  const actions=root.createDiv({cls:'lm-form-actions'});
  if(result)this.action(actions,'정리 노트 열기',async()=>{await this.host.openSummary();this.close();},true);
  const generate=this.action(actions,result?'최신 내용으로 다시 정리':'회의 정리 만들기',()=>this.host.generateSummary(),!result);generate.disabled=this.busy||!status.planAllowed||!models.length;
  if(result){this.action(root,'간결한 형식으로 새 노트 만들기',async()=>{await this.host.refreshSummaryLayout();this.close();});root.createEl('h3',{text:`일정 후보 · ${result.value.events.length}개`});for(const e of result.value.events){const row=root.createDiv({cls:'lm-event-candidate'});const content=row.createDiv();content.createEl('strong',{text:e.title});content.createEl('p',{text:eventDateLabel(e),cls:'lm-event-date'});if(e.whenText)content.createEl('small',{text:'회의 표현: '+e.whenText,cls:'lm-hint'});this.action(row,'일정 확인',async()=>{await this.host.openCalendarDraft(e);this.close();});}if(!result.value.events.length)root.createEl('p',{text:'확인된 일정이 없습니다.',cls:'lm-hint'});}
  const settings=root.createEl('details',{cls:'lm-review-group'});settings.dataset.section='connection';settings.open=folds.get('connection')??false;settings.createEl('summary',{text:'연결 · 모델 설정'});
  if(status.accounts.length){const select=settings.createEl('select',{attr:{'aria-label':'ChatGPT 계정'}});for(const a of status.accounts)select.createEl('option',{value:a.id,text:a.label+(a.signedIn?'':' · 로그아웃됨')});select.value=status.active??'';select.disabled=this.busy;select.addEventListener('change',()=>{void this.host.aiSelect(select.value).then(()=>this.render()).catch(e=>new Notice(String(e)));});}
  if(models.length)new Setting(settings).setName('정리 모델').addDropdown(d=>{for(const m of models)d.addOption(m.id,m.name);d.setValue(this.host.settings.aiModel).onChange(async id=>{this.host.settings.aiModel=id;await this.host.saveAISettings();});});
  new Setting(settings).setName('회의 종료 후 자동 정리').addToggle(t=>t.setValue(this.host.settings.aiAutoSummary).onChange(async v=>{this.host.settings.aiAutoSummary=v;await this.host.saveAISettings();}));
  this.action(settings,'다른 계정 연결',()=>this.host.aiLogin(true));if(status.connected)this.action(settings,'로그아웃',()=>this.host.aiLogout());
  const test=this.action(settings,'연결 테스트',()=>this.host.testAIConnection());test.disabled=this.busy||!status.planAllowed||!models.length;
  settings.createEl('p',{text:'Using ChatGPT plan',cls:'lm-hint'});settings.createEl('a',{text:'사용량 관리',href:'https://chatgpt.com/settings/usage',attr:{target:'_blank',rel:'noopener'}});root.scrollTop=scroll;
 }
}
export class ChatGPTWelcomeModal extends Modal {
 onOpen(){this.setTitle('ChatGPT 요금제를 사용합니다');this.contentEl.createEl('p',{text:'이 플러그인의 AI 정리는 승인한 ChatGPT 요금제와 사용 한도를 사용합니다. ChatGPT 설정에서 앱 사용량과 접근 권한을 관리할 수 있습니다.'});this.contentEl.createEl('a',{text:'사용량 관리',href:'https://chatgpt.com/settings/usage',attr:{target:'_blank',rel:'noopener'}});this.contentEl.createEl('button',{text:'확인',cls:'mod-cta'}).addEventListener('click',()=>this.close());}
}
