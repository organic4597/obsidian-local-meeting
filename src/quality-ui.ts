import {App,Modal,Notice} from 'obsidian';
import {join} from 'node:path';
import {DictionaryData,LocalDictionary,Term} from './dictionary';
import {Meeting,Segment,speakerName,timestamp} from './model';
import {needsReview} from './quality-model';
import {reviewGroups,candidateGroups,participantIds} from './meeting-presentation';
import {audioRange} from './audio-review';

export interface QualityHost {
 meeting?:Meeting;bridge?:unknown;diagnostics:Record<string,unknown>;
 settings:{dictionaryEnabled:boolean;dictionaryProject:string};
 dictionary():LocalDictionary;
 dictionaryChanged():Promise<void>;
 exportDictionary(format:'json'|'csv'):Promise<void>;
 reviewApply(id:string,revision:number,before:string,text:string,speaker:string):Promise<void>;
 reviewKeep(id:string,revision:number):Promise<void>;
 reviewUndo(id:string):Promise<void>;
 connectCandidate(id:string,speaker:string):Promise<void>;
 exportDiagnostics():Promise<void>;
 exportEvaluation():Promise<void>;
}
function field(container:HTMLElement,name:string){const label=container.createEl('label',{cls:'lm-form-field'});label.createSpan({text:name});return label;}
function button(parent:HTMLElement,text:string,fn:()=>Promise<void>|void,cls=''){const b=parent.createEl('button',{text,cls,attr:{type:'button'}});b.addEventListener('click',()=>{if(b.disabled)return;b.disabled=true;Promise.resolve().then(fn).catch(e=>new Notice(String(e))).finally(()=>{b.disabled=false;});});return b;}
const scopes={meeting:'불러온 회의',project:'선택한 프로젝트',vault:'현재 Vault',personal:'개인 기기'};
const policies={hint:'인식 힌트만',normalize:'허용한 별칭 표기 통일',suggest:'교정 제안'};

export class DictionaryModal extends Modal {
 private generation=0;private query='';
 constructor(app:App,private host:QualityHost){super(app);}
 onOpen(){this.setTitle('회의 사전');this.modalEl.addClass('lm-quality-modal');void this.load();}
 onClose(){this.generation++;}
 private async load(){
  const generation=++this.generation;
  try{
   const data=await this.host.dictionary().request({type:'list',project:this.host.settings.dictionaryProject,meeting:this.host.meeting?.id??'',enabled:this.host.settings.dictionaryEnabled});
   if(generation!==this.generation)return;this.render(data);
  }catch(e){if(generation===this.generation){this.contentEl.empty();this.contentEl.createEl('p',{text:String(e),cls:'lm-form-error'});button(this.contentEl,'다시 시도',()=>this.load());}}
 }
 private render(data:DictionaryData){
  const root=this.contentEl;root.empty();const toolbar=root.createDiv({cls:'lm-quality-toolbar'});
  const enabled=field(toolbar,'인식에 사전 사용').createEl('input',{type:'checkbox'});enabled.checked=this.host.settings.dictionaryEnabled;
  enabled.addEventListener('change',()=>{this.host.settings.dictionaryEnabled=enabled.checked;void this.host.dictionaryChanged().then(()=>this.load()).catch(e=>new Notice(String(e)));});
  const project=field(toolbar,'프로젝트').createEl('select');project.createEl('option',{text:'프로젝트 선택 안 함',value:''});
  for(const p of data.projects)project.createEl('option',{text:p.name,value:p.id});project.value=this.host.settings.dictionaryProject;
  project.addEventListener('change',()=>{this.host.settings.dictionaryProject=project.value;void this.host.dictionaryChanged().then(()=>this.load()).catch(e=>new Notice(String(e)));});
  const actions=root.createDiv({cls:'lm-quality-toolbar'});
  button(actions,'용어 추가',()=>new TermModal(this.app,this.host,data,undefined,()=>this.load()).open(),'mod-cta');
  const name=actions.createEl('input',{type:'text',attr:{placeholder:'새 프로젝트 이름','aria-label':'새 프로젝트 이름',maxlength:'80'}});
  button(actions,'프로젝트 추가',async()=>{await this.host.dictionary().request({type:'project',name:name.value});await this.load();});
  const info=root.createEl('p',{cls:'lm-hint',text:`활성 용어 ${data.snapshot.terms.length}개 · 인식 힌트는 최대 40항목·256토큰입니다. 변경은 이후 발언부터 적용됩니다. 이름 사전은 목소리를 등록하지 않습니다.`});
  if(data.snapshot.conflicts.length)info.setText(info.textContent+` 별칭 충돌 ${data.snapshot.conflicts.length}개는 자동 교정하지 않습니다.`);
  const search=field(root,'용어 검색').createEl('input',{type:'search',value:this.query});
  const list=root.createDiv({cls:'lm-quality-list'});
  const draw=()=>{
   list.empty();const q=this.query.normalize('NFC').toLowerCase();
   const visible=data.terms.filter(t=>[t.canonical,...t.pronunciations,...t.observedErrors].join(' ').toLowerCase().includes(q));
   if(!visible.length)list.createEl('p',{text:'등록된 용어가 없습니다. 필요한 업무 용어부터 추가하세요.',cls:'lm-hint'});
   for(const t of visible.slice(0,200)){
    const row=list.createDiv({cls:'lm-term-row'});const text=row.createDiv();text.createEl('strong',{text:t.canonical});
    text.createEl('p',{text:`${scopes[t.scope.kind]} · ${policies[t.postprocess]} · ${t.enabled?'사용':'사용 안 함'}${t.pronunciations.length?' · '+t.pronunciations.join(', '):''}`,cls:'lm-hint'});
    button(row,'수정',()=>new TermModal(this.app,this.host,data,t,()=>this.load()).open());
    button(row,t.enabled?'끄기':'켜기',async()=>{await this.host.dictionary().request({type:'save',term:{...t,enabled:!t.enabled}});await this.host.dictionaryChanged();await this.load();});
   }
   if(visible.length>200)list.createEl('p',{text:'200개까지 표시합니다. 검색어를 입력해 범위를 줄여 주세요.',cls:'lm-hint'});
  };search.addEventListener('input',()=>{this.query=search.value;draw();});draw();
  const transfer=root.createDiv({cls:'lm-quality-toolbar'});
  button(transfer,'전체 사전 JSON 내보내기',()=>this.host.exportDictionary('json'));button(transfer,'CSV 내보내기',()=>this.host.exportDictionary('csv'));
  const file=transfer.createEl('input',{type:'file',attr:{accept:'.json,application/json','aria-label':'사전 JSON 가져오기'}});
  file.addEventListener('change',()=>{void (async()=>{
   const selected=file.files?.[0];if(!selected)return;if(selected.size>2_000_000)throw new Error('2MB 이하의 JSON만 가져올 수 있습니다.');
   const value:unknown=JSON.parse(await selected.text());
   const preview=await this.host.dictionary().request<{accepted:number;skipped:string[];preview:Term[]}>({type:'import_preview',data:value});
   new ImportModal(this.app,preview,async()=>{await this.host.dictionary().request({type:'import_commit',data:value});await this.host.dictionaryChanged();await this.load();}).open();
  })().catch(e=>new Notice(String(e)));});
 }
}
class ImportModal extends Modal {
 constructor(app:App,private preview:{accepted:number;skipped:string[];preview:Term[]},private apply:()=>Promise<void>){super(app);}
 onOpen(){this.setTitle('사전 가져오기 확인');this.contentEl.createEl('p',{text:`현재 Vault에 ${this.preview.accepted}개를 추가합니다. 기존 용어 ${this.preview.skipped.length}개는 유지합니다.`});this.contentEl.createEl('p',{text:this.preview.preview.slice(0,30).map(t=>t.canonical).join(', '),cls:'lm-hint'});button(this.contentEl,'추가',async()=>{await this.apply();this.close();},'mod-cta');button(this.contentEl,'취소',()=>this.close());}
}
export class TermModal extends Modal {
 constructor(app:App,private host:QualityHost,private data:DictionaryData,private term?:Term,private changed?:()=>Promise<void>,private selection=''){super(app);}
 onOpen(){
  this.setTitle(this.term?'용어 수정':'용어 추가');this.modalEl.addClass('lm-editor-modal');const root=this.contentEl,t=this.term;
  const canonical=field(root,'표준 표기').createEl('input',{type:'text',value:t?.canonical??'',attr:{maxlength:'80',placeholder:'예: OpenSearch'}});
  const aliases=field(root,'발음과 별칭 · 쉼표로 구분').createEl('input',{type:'text',value:t?.pronunciations.join(', ')??''});
  const errors=field(root,'확인한 오인식 · 쉼표로 구분').createEl('input',{type:'text',value:t?.observedErrors.join(', ')??this.selection});
  const category=field(root,'종류').createEl('select');for(const [value,text] of Object.entries({technical:'기술 용어',organization:'기관',product:'제품',person:'인명',abbreviation:'약어',other:'기타'}))category.createEl('option',{value,text});category.value=t?.category??'technical';
  const scope=field(root,'적용 범위').createEl('select');for(const [value,text] of Object.entries(scopes)){const o=scope.createEl('option',{value,text});o.disabled=(value==='meeting'&&!this.host.meeting)||(value==='project'&&!this.host.settings.dictionaryProject);}scope.value=t?.scope.kind??'vault';
  const policy=field(root,'적용 방법').createEl('select');for(const [value,text] of Object.entries(policies))policy.createEl('option',{value,text});policy.value=t?.postprocess??'hint';
  const hint=field(root,'인식 전에 용어 힌트로 사용').createEl('input',{type:'checkbox'});hint.checked=t?.recognitionHint??true;
  root.createEl('p',{text:'오인식은 기본적으로 교정 후보입니다. 숫자·담당자·기한은 자동으로 추측하지 않습니다.',cls:'lm-hint'});
  const error=root.createDiv({cls:'lm-form-error',attr:{role:'alert'}}),actions=root.createDiv({cls:'lm-form-actions'});
  button(actions,'저장',async()=>{
   try{
    const kind=scope.value as Term['scope']['kind'];const id=kind==='meeting'?this.host.meeting?.id:kind==='project'?this.host.settings.dictionaryProject:kind==='vault'?this.host.dictionary().vaultId:'shared';if(!id)throw new Error('적용할 회의 또는 프로젝트를 선택해 주세요.');
    const split=(s:string)=>s.split(/[,\n]/).map(x=>x.trim()).filter(Boolean);
    await this.host.dictionary().request({type:'save',term:{...t,canonical:canonical.value,pronunciations:split(aliases.value),observedErrors:split(errors.value),contextTags:t?.contextTags??[],category:category.value,scope:{kind,id},postprocess:policy.value,recognitionHint:hint.checked,confirmedByUser:true,enabled:t?.enabled??true}});
    await this.host.dictionaryChanged();await this.changed?.();this.close();
   }catch(e){error.setText(String(e));}
  },'mod-cta');
  if(t)button(actions,'삭제',async()=>new DeleteTermModal(this.app,t.canonical,async()=>{await this.host.dictionary().request({type:'delete',id:t.id});await this.host.dictionaryChanged();await this.changed?.();this.close();}).open());
  button(actions,'취소',()=>this.close());window.setTimeout(()=>canonical.focus(),0);
 }
}
class DeleteTermModal extends Modal {
 constructor(app:App,private name:string,private apply:()=>Promise<void>){super(app);}
 onOpen(){this.setTitle('사전 용어 삭제');this.contentEl.createEl('p',{text:`“${this.name}” 항목을 삭제합니다. 기존 회의의 사전 스냅샷과 원문은 남습니다.`});button(this.contentEl,'삭제',async()=>{await this.apply();this.close();});button(this.contentEl,'취소',()=>this.close());}
}
export class ReviewModal extends Modal {
 private limit=30;private filter='grouped';
 constructor(app:App,private host:QualityHost){super(app);}
 onOpen(){this.setTitle('발언 검토');this.modalEl.addClass('lm-quality-modal');this.render();}
 private render(){
  const root=this.contentEl;root.empty();const m=this.host.meeting;if(!m){root.createEl('p',{text:'불러온 회의가 없습니다.'});return;}
  const tools=root.createDiv({cls:'lm-quality-toolbar'});const filter=field(tools,'표시 범위').createEl('select');
  for(const [value,text] of Object.entries({grouped:'종류별 모아보기',pending:'미확인 발언 펼쳐보기',speaker:'화자 미확정과 동시 발언',terms:'용어 교정 후보',all:'모든 발언'}))filter.createEl('option',{value,text});filter.value=this.filter;
  filter.addEventListener('change',()=>{this.filter=filter.value;this.limit=30;this.render();});button(tools,'새로고침',()=>this.render());
  const advanced=root.createEl('details');advanced.createEl('summary',{text:'진단 · 평가 도구'});button(advanced,'진단 내보내기',()=>this.host.exportDiagnostics());button(advanced,'평가용 정답 양식',()=>this.host.exportEvaluation());
  if(this.filter==='grouped'){
   root.createEl('p',{text:'검토는 선택 사항입니다. 반복된 항목은 묶어 두었으며 녹음이나 정리를 막지 않습니다.',cls:'lm-hint'});
   for(const c of candidateGroups(m)){const box=root.createEl('details',{cls:'lm-review-group'});box.createEl('summary',{text:`참여자 연결 · ${c.segments.length}개 발언`});box.createEl('p',{text:'같은 사람으로 보이는 음성 그룹입니다. 기존 참여자와 연결하거나 이름을 입력해 추가하세요.',cls:'lm-hint'});const select=box.createEl('select',{attr:{'aria-label':'연결할 참여자'}});select.createEl('option',{value:'',text:'참여자 선택'});for(const id of participantIds(m))select.createEl('option',{value:id,text:speakerName({...c.segments[0]!,speaker:id},m.speakers)});const input=field(box,'새 참여자 이름 (선택)').createEl('input',{type:'text',attr:{maxlength:'60'}});button(box,'참여자 연결',async()=>{await this.host.connectCandidate(c.id,input.value.trim()?'name:'+input.value.trim():select.value);this.render();});}
   const groups=reviewGroups(m);if(!groups.length)root.createEl('p',{text:'추가로 확인할 항목이 없습니다.',cls:'lm-empty'});
   for(const g of groups){if(g.key.startsWith('candidate:'))continue;const box=root.createEl('details',{cls:'lm-review-group'});box.createEl('summary',{text:`${g.label} · ${g.segments.length}개 발언`});for(const s of g.segments.slice(0,this.limit)){const row=box.createDiv({cls:'lm-review-row'});row.createEl('p',{text:`${timestamp(s.start)} · ${s.text.slice(0,160)}`});button(row,'듣고 수정',()=>new ReviewDetail(this.app,this.host,structuredClone(s),()=>this.render()).open());}if(g.segments.length>this.limit)button(box,'더 보기',()=>{this.limit+=30;this.render();});}
   return;
  }
  const segments=m.segments.filter(s=>this.filter==='all'||this.filter==='speaker'&&['unknown','overlap'].includes(s.speaker)||this.filter==='terms'&&s.suggestions?.some(c=>c.state==='suggested')||this.filter==='pending'&&needsReview(s));
  root.createEl('p',{text:`${segments.length}개 발언 · 원음과 비교해 확인하세요. 직접 수정한 본문은 자동 교정하지 않습니다.`,cls:'lm-hint'});
  const list=root.createDiv({cls:'lm-quality-list'});
  for(const s of segments.slice(0,this.limit)){
   const row=list.createDiv({cls:'lm-review-row'});row.createEl('strong',{text:`${timestamp(s.start)} · ${speakerName(s,m.speakers)}${s.textState==='provisional'?' · 잠정':''}`});row.createEl('p',{text:s.text});
   row.createEl('p',{text:s.reviewReasons?.join(' · ')||'전사와 화자를 확인할 수 있습니다.',cls:'lm-hint'});
   button(row,'원음과 교정 보기',()=>new ReviewDetail(this.app,this.host,structuredClone(s),()=>this.render()).open());
  }
  if(segments.length>this.limit)button(root,'30개 더 보기',()=>{this.limit+=30;this.render();});
 }
}
class ReviewDetail extends Modal {
 private audio?:HTMLAudioElement;private url?:string;
 constructor(app:App,private host:QualityHost,private segment:Segment,private changed:()=>void){super(app);}
 onOpen(){
  const s=this.segment,m=this.host.meeting!;this.setTitle(`${timestamp(s.start)} 발언 검토`);this.modalEl.addClass('lm-editor-modal');const root=this.contentEl;
  root.createEl('p',{text:`${timestamp(s.start)}–${timestamp(s.end)} · ${s.textState==='provisional'?'잠정 전사':'전사 결과'}`,cls:'lm-hint'});
  const player=root.createDiv({cls:'lm-quality-player'});
  const headphones=field(player,'녹음 중에는 헤드폰으로 재생합니다').createEl('input',{type:'checkbox'});
  button(player,'이 구간 원음 재생',async()=>{
   if(this.host.bridge&&!headphones.checked)throw new Error('스피커 소리가 다시 녹음될 수 있습니다. 녹음을 마치거나 헤드폰을 확인해 주세요.');
   this.audio?.pause();if(this.url)URL.revokeObjectURL(this.url);
   const pcm=await audioRange(join(m.directory,'recording.wav'),s.start,s.end);this.url=URL.createObjectURL(new Blob([pcm as BlobPart],{type:'audio/wav'}));
   this.audio??=player.createEl('audio',{attr:{controls:'true','aria-label':'발언 원음'}});this.audio.src=this.url;await this.audio.play();
  });
  if(s.rawText)root.createEl('p',{text:'인식 원문: '+s.rawText,cls:'lm-raw-transcript'});
  const text=field(root,'노트에 적용할 대사').createEl('textarea',{text:s.text,attr:{rows:'5',maxlength:'10000'}});
  if(s.rawText&&s.rawText!==s.text)button(root,'인식 원문으로 바꾸기',()=>{text.value=s.rawText!;});
  const speaker=field(root,'화자').createEl('select');const ids=[...new Set(['unknown','overlap',...m.segments.map(x=>x.speaker),...Object.keys(m.speakers)])];
  for(const id of ids)speaker.createEl('option',{value:id,text:speakerName({...s,speaker:id},m.speakers)});speaker.value=s.speaker;
  if(s.candidates?.length)root.createEl('p',{text:'활동 근거: '+s.candidates.map(c=>`${speakerName({...s,speaker:c.speaker},m.speakers)} ${(c.activity*100).toFixed(0)}% / ${c.activeSeconds.toFixed(1)}초`).join(' · ')+' · 신원 정확도 수치가 아닙니다.',cls:'lm-hint'});
  for(const c of s.suggestions??[]){
   if(c.state==='suggested')button(root,`${c.before} → ${c.after} 제안 넣기`,()=>{if(text.value!==s.text||text.value.slice(c.start,c.end)!==c.before)throw new Error('수정된 대사를 확인한 뒤 직접 교정해 주세요.');text.value=text.value.slice(0,c.start)+c.after+text.value.slice(c.end);});
   else if(c.state==='applied')root.createEl('p',{text:`표기 통일: ${c.before} → ${c.after} · 원문은 위에 보존됩니다.`,cls:'lm-hint'});
  }
  const error=root.createDiv({cls:'lm-form-error',attr:{role:'alert'}}),actions=root.createDiv({cls:'lm-form-actions'});
  button(actions,'교정 적용',async()=>{try{await this.host.reviewApply(s.id,s.revision??0,s.text,text.value,speaker.value);this.changed();this.close();}catch(e){error.setText(String(e));}},'mod-cta');
  button(actions,'현재 내용 유지하고 확인 완료',async()=>{try{await this.host.reviewKeep(s.id,s.revision??0);this.changed();this.close();}catch(e){error.setText(String(e));}});
  if(s.history?.length)button(actions,'직전 교정 되돌리기',async()=>{try{await this.host.reviewUndo(s.id);this.changed();this.close();}catch(e){error.setText(String(e));}});
 }
 onClose(){this.audio?.pause();if(this.url)URL.revokeObjectURL(this.url);}
}
