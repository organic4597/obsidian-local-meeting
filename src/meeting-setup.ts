import {App,Modal,Setting} from 'obsidian';
export interface ParticipantLimit {count:number;mode:'maximum'|'exact';}
export class MeetingSetupModal extends Modal {
 private settled=false;
 constructor(app:App,private value:ParticipantLimit,private done:(value:ParticipantLimit|null)=>void){super(app);}
 onOpen(){this.setTitle('회의 시작');this.contentEl.createEl('p',{text:'회의 중에는 텍스트만 기록합니다. 종료 후 로컬 화자 구분과 OpenAI 정리를 진행합니다.',cls:'lm-hint'});
 new Setting(this.contentEl).setName('말할 수 있는 최대 인원').setDesc('전체 참석 인원보다 실제 발언할 수 있는 인원을 기준으로 입력하세요. 0은 자동 추정입니다.').addText(t=>{t.inputEl.type='number';t.inputEl.min='0';t.inputEl.max='32';t.inputEl.step='1';t.setValue(String(this.value.count)).onChange(v=>{this.value.count=Number(v);});});
 new Setting(this.contentEl).setName('화자 수 적용 방식').addDropdown(d=>d.addOptions({maximum:'입력한 인원 이하에서 추정',exact:'정확히 이 인원으로 구분'}).setValue(this.value.mode).onChange(v=>{this.value.mode=v as ParticipantLimit['mode'];}));
 this.contentEl.createEl('p',{text:'상한은 인원 수를 억지로 맞추지 않습니다. 고정값도 사람별 구분 정확도를 보장하지는 않습니다.',cls:'lm-hint'});
 const error=this.contentEl.createDiv({cls:'lm-form-error'}),footer=this.contentEl.createDiv({cls:'lm-form-actions'});footer.createEl('button',{text:'취소'}).addEventListener('click',()=>this.close());footer.createEl('button',{text:'녹음 시작',cls:'mod-cta'}).addEventListener('click',()=>{if(!Number.isInteger(this.value.count)||this.value.count<0||this.value.count>32||this.value.mode==='exact'&&this.value.count===0){error.setText('상한은 0~32명, 고정 인원은 1~32명을 입력해 주세요.');return;}this.settled=true;this.done({...this.value});this.close();});}
 onClose(){if(!this.settled)this.done(null);}
 static ask(app:App,value:ParticipantLimit){return new Promise<ParticipantLimit|null>(resolve=>new MeetingSetupModal(app,{...value},resolve).open());}
}
