import {App,Setting,TextComponent} from 'obsidian';
import {meetingFolder} from './meeting-files';

const searchKey=(value:string)=>value.normalize('NFC').toLocaleLowerCase();
const queryPath=(value:string)=>value.trim().replace(/\\/g,'/').replace(/^\/+/, '');
export function matchingFolders(paths:string[],query:string){
 const typed=queryPath(query),slash=typed.lastIndexOf('/'),parent=typed.slice(0,slash+1),prefix=typed.slice(slash+1);
 if(typed.split('/').some(part=>part==='.'||part==='..'))return [];
 return [...new Set(paths)].filter(path=>{
  try{meetingFolder(path);}catch{return false;}
  if(path.split('/').some(part=>part.startsWith('.')))return false;
  const last=path.lastIndexOf('/');
  return searchKey(path.slice(0,last+1))===searchKey(parent)&&searchKey(path.slice(last+1)).startsWith(searchKey(prefix));
 }).sort((a,b)=>a.localeCompare(b,'ko'));
}
export function completeFolder(paths:string[],query:string){
 const matches=matchingFolders(paths,query);
 if(!matches.length)return undefined;
 let prefix=matches[0]!+'/';
 for(const path of matches.slice(1)){const a=Array.from(prefix),b=Array.from(path+'/');let count=0;while(count<a.length&&a[count]===b[count])count++;prefix=a.slice(0,count).join('');}
 return searchKey(prefix).length>searchKey(queryPath(query)).length?prefix:undefined;
}
let menuNumber=0;
/** A popup owned by the input's window, with explicit selection and one path level at a time. */
export class VaultFolderSuggest {
 private menu:HTMLElement;private wrapper:HTMLElement;private matches:string[]=[];private selected=0;private composing=false;
 constructor(private app:App,private text:TextComponent){
  const input=text.inputEl;
  this.wrapper=input.parentElement!.createDiv({cls:'lm-folder-control'});this.wrapper.appendChild(input);
  this.menu=this.wrapper.createDiv({cls:'lm-folder-menu',attr:{role:'listbox',id:'lm-folder-menu-'+(++menuNumber),'aria-label':'현재 경로의 하위 폴더'}});this.menu.hidden=true;
  input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-expanded','false');input.setAttribute('aria-controls',this.menu.id);
  input.addEventListener('focus',()=>this.show());input.addEventListener('click',()=>this.show());input.addEventListener('input',()=>this.show());
  input.addEventListener('compositionstart',()=>this.composing=true);input.addEventListener('compositionend',()=>{this.composing=false;this.show();});
  input.addEventListener('blur',()=>this.close());
  input.addEventListener('keydown',event=>{
   if(this.composing||event.isComposing)return;
   if(event.key==='Tab'&&!event.shiftKey){const completed=completeFolder(this.paths(),input.value);if(completed!==undefined){event.preventDefault();this.commit(completed,true);}else if(this.matches.length){event.preventDefault();this.show();}return;}
   if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();if(this.menu.hidden)this.show();else if(this.matches.length){this.selected=(this.selected+(event.key==='ArrowDown'?1:-1)+this.matches.length)%this.matches.length;this.highlight();}}
   else if(event.key==='Enter'&&!this.menu.hidden&&this.matches.length){event.preventDefault();event.stopPropagation();this.commit(this.matches[this.selected]!+'/',false);}
   else if(event.key==='Escape'&&!this.menu.hidden){event.preventDefault();event.stopPropagation();this.close();}
  });
 }
 private paths(){return this.app.vault.getAllFolders().map(folder=>folder.path);}
 private commit(value:string,browse:boolean){this.text.setValue(value);this.text.onChanged();if(browse)this.show();else this.close();}
 show(){
  this.matches=matchingFolders(this.paths(),this.text.getValue());this.selected=0;this.menu.empty();
  if(!this.matches.length)this.menu.createDiv({cls:'lm-folder-empty',text:'하위 폴더가 없습니다. 새 경로를 입력할 수 있습니다.'});
  for(const [i,path] of this.matches.entries()){
   const row=this.menu.createEl('button',{cls:'lm-folder-option',text:path.slice(path.lastIndexOf('/')+1)+'/',attr:{type:'button',role:'option',id:this.menu.id+'-'+i,title:path,tabindex:'-1'}});
   row.addEventListener('mousedown',event=>event.preventDefault());
   row.addEventListener('click',()=>{this.text.inputEl.focus();this.commit(path+'/',true);});
  }
  this.menu.hidden=false;const bounds=this.text.inputEl.getBoundingClientRect(),height=this.text.inputEl.ownerDocument.defaultView?.innerHeight??0;this.menu.toggleClass('is-above',height-bounds.bottom<180&&bounds.top>220);this.text.inputEl.setAttribute('aria-expanded','true');this.menu.scrollTop=0;this.highlight();
 }
 private highlight(){
  const rows=this.menu.querySelectorAll<HTMLElement>('[role="option"]');rows.forEach((row,i)=>{row.setAttribute('aria-selected',String(i===this.selected));row.toggleClass('is-selected',i===this.selected);});
  const active=rows[this.selected];if(active){this.text.inputEl.setAttribute('aria-activedescendant',active.id);if(active.offsetTop<this.menu.scrollTop)this.menu.scrollTop=active.offsetTop;else if(active.offsetTop+active.offsetHeight>this.menu.scrollTop+this.menu.clientHeight)this.menu.scrollTop=active.offsetTop+active.offsetHeight-this.menu.clientHeight;}else this.text.inputEl.removeAttribute('aria-activedescendant');
 }
 close(){this.menu.hidden=true;this.text.inputEl.setAttribute('aria-expanded','false');this.text.inputEl.removeAttribute('aria-activedescendant');}
}
export function addFolderInput(setting:Setting,app:App,value:string,onChange:(value:string)=>unknown){
 let text!:TextComponent,suggest!:VaultFolderSuggest;
 setting.addText(t=>{text=t;t.setValue(value).setPlaceholder('예: 06-기록/ · Tab으로 완성').onChange(onChange);t.inputEl.setAttribute('aria-label',setting.nameEl.textContent||'저장 폴더');t.inputEl.addClass('lm-folder-input');suggest=new VaultFolderSuggest(app,t);});
 setting.addExtraButton(button=>button.setIcon('chevron-down').setTooltip('현재 경로의 하위 폴더').onClick(()=>{text.inputEl.focus();suggest.show();}));return suggest;
}
