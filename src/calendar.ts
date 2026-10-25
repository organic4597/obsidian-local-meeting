import {App,Modal,Notice,Setting,TFile} from 'obsidian';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
export interface Calendar {id:string;title:string;source:string;writable:boolean;}
export function calendarCall(helper:string,request:Record<string,unknown>):Promise<any>{return new Promise((resolve,reject)=>{
 const child=spawn(helper,[],{shell:false,stdio:'pipe'});let out='',err='';
 const timer=setTimeout(()=>{child.kill();reject(new Error('캘린더 권한 또는 응답 대기 시간이 초과됐습니다.'));},90000);
 child.on('error',reject);child.stdout.on('data',chunk=>{out+=chunk.toString();});child.stderr.on('data',chunk=>{err=(err+chunk.toString()).slice(-1000);});
 child.on('close',()=>{clearTimeout(timer);try{const result=JSON.parse(out);if(result.error)reject(new Error(result.error));else resolve(result);}catch{reject(new Error(err||'캘린더 응답을 읽을 수 없습니다.'));}});child.stdin.end(JSON.stringify(request)+'\n');
});}
const localTime=(date:Date)=>{const copy=new Date(date.getTime()-date.getTimezoneOffset()*60000);return copy.toISOString().slice(0,16);};
interface CalendarOptions {helper:string;calendarId:string;saveCalendar:(id:string)=>Promise<void>;}
export class CalendarModal extends Modal {
 private calendarId:string;private title='';private start=localTime(new Date());private end=localTime(new Date(Date.now()+3600000));private notes='';private uid=randomUUID();private eventId?:string;private items!:HTMLElement;private calendars:Calendar[]=[];
 constructor(app:App,private options:CalendarOptions){super(app);this.calendarId=options.calendarId;}
 onOpen(){this.render();void this.load();}
 private render(){const c=this.contentEl;c.empty();c.createEl('h2',{text:'일정 · 할 일'});c.createEl('p',{text:'Mac에 연결된 캘린더를 사용합니다. iCloud 캘린더를 선택하면 macOS가 iCloud로 동기화합니다.'});
 new Setting(c).setName('캘린더 연결').setDesc('처음에는 macOS 캘린더 권한을 허용해야 합니다.').addButton(b=>b.setButtonText('캘린더 불러오기').onClick(()=>{void this.load();}));
 if(this.calendars.length)new Setting(c).setName('캘린더').addDropdown(d=>{for(const x of this.calendars)d.addOption(x.id,`${x.source} · ${x.title}${x.writable?'':' (읽기 전용)'}`);d.setValue(this.calendarId).onChange(async value=>{this.calendarId=value;await this.options.saveCalendar(value);});});
 new Setting(c).setName('제목 / 할 일').addText(t=>t.setValue(this.title).onChange(v=>this.title=v));
 new Setting(c).setName('시작').addText(t=>{t.inputEl.type='datetime-local';t.setValue(this.start).onChange(v=>this.start=v);});
 new Setting(c).setName('종료').addText(t=>{t.inputEl.type='datetime-local';t.setValue(this.end).onChange(v=>this.end=v);});
 new Setting(c).setName('메모').addTextArea(t=>t.setValue(this.notes).onChange(v=>this.notes=v));
 new Setting(c).addButton(b=>b.setButtonText('캘린더에 저장').setCta().onClick(()=>{void this.saveEvent();})).addButton(b=>b.setButtonText('노트에 할 일 추가').onClick(()=>{void this.addTask();}));
 new Setting(c).setName('선택한 캘린더의 향후 7일').addButton(b=>b.setButtonText('일정 보기').onClick(()=>{void this.upcoming();}));this.items=c.createDiv();}
 private async load(){try{const result=await calendarCall(this.options.helper,{op:'calendars'});this.calendars=result.calendars;if(!this.calendars.some(x=>x.id===this.calendarId)){this.calendarId=this.calendars.find(x=>x.writable&&/icloud/i.test(x.source))?.id??this.calendars.find(x=>x.writable)?.id??this.calendars[0]?.id??'';}await this.options.saveCalendar(this.calendarId);this.render();}catch(e){new Notice(String(e),10000);}}
 private async saveEvent(){try{if(!this.title.trim())throw new Error('제목을 입력하세요.');const start=new Date(this.start),end=new Date(this.end);if(!Number.isFinite(start.getTime())||end<=start)throw new Error('시작·종료 시간을 확인하세요.');const result=await calendarCall(this.options.helper,{op:'save',calendarId:this.calendarId,title:this.title,start:start.toISOString(),end:end.toISOString(),notes:this.notes,uid:this.uid,eventId:this.eventId});this.eventId=result.eventId;new Notice('캘린더에 저장했습니다. 같은 창에서 다시 저장하면 해당 일정을 갱신합니다.');await this.upcoming();}catch(e){new Notice(String(e),10000);}}
 private async addTask(){try{const file=this.app.workspace.getActiveFile();if(!(file instanceof TFile)||file.extension!=='md')throw new Error('할 일을 기록할 노트를 여세요.');if(!this.title.trim())throw new Error('할 일을 입력하세요.');const text=this.title.replace(/[\r\n]/g,' ');await this.app.vault.process(file,n=>n+`\n- [ ] ${text}${this.start?' 📅 '+this.start.slice(0,10):''}\n`);new Notice('현재 노트에 할 일을 추가했습니다.');}catch(e){new Notice(String(e));}}
 private async upcoming(){try{const now=new Date();const result=await calendarCall(this.options.helper,{op:'events',calendarId:this.calendarId,start:now.toISOString(),end:new Date(now.getTime()+7*86400000).toISOString()});this.items.empty();if(!result.events.length)this.items.createEl('p',{text:'향후 7일 일정이 없습니다.'});for(const e of result.events){const row=new Setting(this.items).setName(e.title).setDesc(new Date(e.start).toLocaleString());if(e.uid)row.addButton(b=>b.setButtonText('수정').onClick(()=>{this.uid=e.uid;this.eventId=e.id;this.title=e.title;this.start=localTime(new Date(e.start));this.end=localTime(new Date(e.end));this.notes=e.notes??'';this.render();}));}}catch(e){new Notice(String(e),10000);}}
}
