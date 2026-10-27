import {EditorView,ViewPlugin} from '@codemirror/view';
import {ChangeSet} from '@codemirror/state';
import {transcriptTransaction} from './editor-changes';
import {previewExtension,setPreview,PreviewFrame} from './editor-preview';
import {TextReveal} from './live-preview';

/** Tracks editor instances through the public Obsidian CM6 extension API. */
export class MeetingEditors {
 private views=new Set<EditorView>();private disposed=false;
 private previews=new Map<string,{key:string;reveal:TextReveal;final:boolean;frame:PreviewFrame;timer?:ReturnType<typeof setTimeout>;last:number;resolve?: (ok:boolean)=>void}>();
 readonly extension;
 constructor(private fileOf:(view:EditorView)=>string|undefined,private paused:(value:boolean)=>void){
  const views=this.views,host=this;
  this.extension=[previewExtension,ViewPlugin.fromClass(class {
   path:string|undefined;
   constructor(readonly view:EditorView){views.add(view);this.path=host.fileOf(view);queueMicrotask(()=>{if(views.has(view))host.paint(view);});}
   update(){const path=host.fileOf(this.view);if(path!==this.path){this.path=path;queueMicrotask(()=>{if(views.has(this.view))host.paint(this.view);});}}
   destroy(){views.delete(this.view);}
  })];
 }
 find(path:string){const views=[...this.views].filter(view=>this.fileOf(view)===path);return views.find(view=>view.hasFocus)??views.find(view=>view.inView)??views[0];}
 async ready(path:string){
  let waiting=false;
  try {
   while(!this.disposed&&[...this.views].some(view=>this.fileOf(view)===path&&(view.compositionStarted||view.composing))){
    if(!waiting){waiting=true;this.paused(true);}
    await new Promise(resolve=>setTimeout(resolve,40));
   }
   return !this.disposed;
  }finally{if(waiting)this.paused(false);}
 }
 apply(view:EditorView,changes:ChangeSet){
  if(changes.empty)return;
  const snapshot=typeof view.scrollSnapshot==='function'?view.scrollSnapshot().map(changes):undefined;
  view.dispatch({...transcriptTransaction(view.state,changes),effects:snapshot?[snapshot]:[]});
 }
 private paint(view:EditorView){const path=this.fileOf(view),frame=path?this.previews.get(path)?.frame:undefined;
  view.dispatch({effects:setPreview.of(frame??null)});
 }
 private paintPath(path:string){for(const view of this.views)if(this.fileOf(view)===path)this.paint(view);}
 preview(path:string,key:string,text:string,final=false){
  let entry=this.previews.get(path);
  if(entry?.key!==key){this.clearPreview(path);const reveal=new TextReveal(final);entry={key,reveal,final,frame:{key,text:'',final,typing:true},last:Date.now()};this.previews.set(path,entry);}
  entry.reveal.set(text,final);entry.final=final;
  const reduced=typeof window!=='undefined'&&window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if(reduced||!this.find(path))entry.reveal.finish();
  entry.frame={key,text:entry.reveal.value,final,typing:!entry.reveal.done};this.paintPath(path);
  if(entry.reveal.done){entry.resolve?.(true);entry.resolve=undefined;return;}
  if(entry.timer)return;
  entry.last=Date.now();
  const tick=()=>{if(this.disposed||this.previews.get(path)!==entry)return;
   const now=Date.now();entry.reveal.step(now-entry.last);entry.last=now;
   if(!this.find(path))entry.reveal.finish();
   entry.frame={key,text:entry.reveal.value,final:entry.final,typing:!entry.reveal.done};this.paintPath(path);
   if(entry.reveal.done){entry.timer=undefined;entry.resolve?.(true);entry.resolve=undefined;}else entry.timer=setTimeout(tick,32);
  };
  entry.timer=setTimeout(tick,32);
 }
 async finalPreview(path:string,key:string,text:string){
  this.preview(path,key,text,true);const entry=this.previews.get(path);if(!entry||this.disposed)return false;if(entry.reveal.done)return true;
  return new Promise<boolean>(resolve=>{entry.resolve=resolve;});
 }
 clearPreview(path:string){const entry=this.previews.get(path);if(entry){clearTimeout(entry.timer);entry.resolve?.(false);this.previews.delete(path);this.paintPath(path);}}
 dispose(){this.disposed=true;for(const entry of this.previews.values()){clearTimeout(entry.timer);entry.resolve?.(false);}this.previews.clear();}
}
