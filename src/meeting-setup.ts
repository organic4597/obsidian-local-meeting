import {App,Modal,Setting} from 'obsidian';
export interface ParticipantLimit {count:number;mode:'maximum'|'exact';}
export interface AudioOption {pid:number;name:string;}
export interface MeetingSetup extends ParticipantLimit {audio:'microphone'|'system'|'app';audioPid?:number;voiceProfiles:boolean;}
export class MeetingSetupModal extends Modal {
 private settled=false;
 constructor(app:App,private value:MeetingSetup,private options:AudioOption[],private audioAvailable:boolean,private done:(value:MeetingSetup|null)=>void){super(app);}
 onOpen(){this.setTitle('회의 시작');this.contentEl.createEl('p',{text:'회의 중 전사는 흐린 임시 텍스트로 보이며 자동 저장됩니다. 본문에는 자유롭게 필기하세요. 종료 후 화자별 대화를 확정하고 OpenAI 정리를 진행합니다.',cls:'lm-hint'});
 new Setting(this.contentEl).setName('말할 수 있는 최대 인원').setDesc('전체 참석 인원보다 실제 발언할 수 있는 인원을 기준으로 입력하세요. 0은 자동 추정입니다.').addText(t=>{t.inputEl.type='number';t.inputEl.min='0';t.inputEl.max='32';t.inputEl.step='1';t.setValue(String(this.value.count)).onChange(v=>{this.value.count=Number(v);});});
 new Setting(this.contentEl).setName('화자 수 적용 방식').addDropdown(d=>d.addOptions({maximum:'입력한 인원 이하에서 추정',exact:'정확히 이 인원으로 구분'}).setValue(this.value.mode).onChange(v=>{this.value.mode=v as ParticipantLimit['mode'];}));
 new Setting(this.contentEl).setName('회의 음성으로 프로필 자동 수집').setDesc('참여자에게 음성 특징 저장을 알리고 동의를 받은 경우에만 켜세요. 이름을 확인한 후 로컬에 보관하며, 종료 후 처리합니다.').addToggle(t=>t.setValue(this.value.voiceProfiles).onChange(v=>this.value.voiceProfiles=v));
 if(this.audioAvailable){const audio=new Setting(this.contentEl).setName('녹음할 소리').setDesc('시스템 오디오를 선택하면 Mac 기본 마이크와 함께 하나의 녹음 파일에 저장합니다. 앱은 소리를 재생 중일 때 목록에 나타납니다.').addDropdown(d=>{d.addOption('microphone','마이크만');d.addOption('system','마이크 + 전체 시스템 오디오');for(const o of this.options)d.addOption('app:'+o.pid,'마이크 + '+o.name+' ('+o.pid+')');d.setValue('microphone').onChange(v=>{this.value.audio=v.startsWith('app:')?'app':v as 'microphone'|'system';this.value.audioPid=v.startsWith('app:')?Number(v.slice(4)):undefined;});});void audio;this.contentEl.createEl('p',{text:'스피커 재생음이 마이크에 다시 들어가지 않도록 헤드폰 사용을 권장합니다. 시스템 오디오에는 macOS 권한이 필요합니다.',cls:'lm-hint'});}
 this.contentEl.createEl('p',{text:'상한은 인원 수를 억지로 맞추지 않습니다. 고정값도 사람별 구분 정확도를 보장하지는 않습니다.',cls:'lm-hint'});
 const error=this.contentEl.createDiv({cls:'lm-form-error'}),footer=this.contentEl.createDiv({cls:'lm-form-actions'});footer.createEl('button',{text:'취소'}).addEventListener('click',()=>this.close());footer.createEl('button',{text:'녹음 시작',cls:'mod-cta'}).addEventListener('click',()=>{if(!Number.isInteger(this.value.count)||this.value.count<0||this.value.count>32||this.value.mode==='exact'&&this.value.count===0){error.setText('상한은 0~32명, 고정 인원은 1~32명을 입력해 주세요.');return;}this.settled=true;this.done({...this.value});this.close();});}
 onClose(){if(!this.settled)this.done(null);}
 static ask(app:App,value:ParticipantLimit & {voiceProfiles?:boolean},options:AudioOption[]=[],audioAvailable=false){return new Promise<MeetingSetup|null>(resolve=>new MeetingSetupModal(app,{...value,audio:'microphone',voiceProfiles:!!value.voiceProfiles},options,audioAvailable,resolve).open());}
}
