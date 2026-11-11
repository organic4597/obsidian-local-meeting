import {AbstractInputSuggest,App,Setting,TextComponent} from 'obsidian';
import {meetingFolder} from './meeting-files';

const searchKey=(value:string)=>value.normalize('NFC').toLocaleLowerCase().replace(/\\/g,'/');
export function matchingFolders(paths:string[],query:string){
 const terms=searchKey(query.trim()).split(/\s+/).filter(Boolean);
 const prefix=searchKey(query.trim());
 return [...new Set(paths)].filter(path=>{
  try{meetingFolder(path);}catch{return false;}
  if(path.split('/').some(part=>part.startsWith('.')))return false;
  return terms.every(term=>searchKey(path).includes(term));
 }).sort((a,b)=>{
  const rank=(path:string)=>{const key=searchKey(path);return key===prefix?0:key.startsWith(prefix)?1:key.split('/').pop()!.startsWith(prefix)?2:3;};
  return rank(a)-rank(b)||a.localeCompare(b,'ko');
 });
}

/** Uses Obsidian's native popup for mouse, arrow keys, Enter and Escape. */
export class VaultFolderSuggest extends AbstractInputSuggest<string> {
 constructor(app:App,private text:TextComponent){super(app,text.inputEl);this.limit=100;}
 getSuggestions(query:string){return matchingFolders(this.app.vault.getAllFolders().map(folder=>folder.path),query);}
 renderSuggestion(path:string,el:HTMLElement){el.addClass('lm-folder-suggestion');el.setText(path);}
 selectSuggestion(path:string){this.text.setValue(path);this.text.onChanged();this.close();}
}

export function addFolderInput(setting:Setting,app:App,value:string,onChange:(value:string)=>unknown){
 let text!:TextComponent,suggest!:VaultFolderSuggest;
 setting.addText(t=>{text=t;t.setValue(value).setPlaceholder('폴더 검색 또는 새 경로 입력').onChange(onChange);t.inputEl.setAttribute('aria-label',setting.nameEl.textContent||'저장 폴더');t.inputEl.addClass('lm-folder-input');suggest=new VaultFolderSuggest(app,t);});
 setting.addExtraButton(button=>button.setIcon('chevron-down').setTooltip('폴더 목록 열기').onClick(()=>{
  text.inputEl.focus();
  // The native input listener refreshes the popup with the current query.
  text.inputEl.dispatchEvent(new Event('input',{bubbles:true}));
 }));
 return suggest;
}
