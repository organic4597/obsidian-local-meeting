import {EditorView,ViewPlugin} from '@codemirror/view';
import {ChangeSet} from '@codemirror/state';
import {transcriptTransaction} from './editor-changes';

/** Tracks editor instances through the public Obsidian CM6 extension API. */
export class MeetingEditors {
 private views=new Set<EditorView>();private disposed=false;
 readonly extension;
 constructor(private fileOf:(view:EditorView)=>string|undefined,private paused:(value:boolean)=>void){
  const views=this.views;
  this.extension=ViewPlugin.fromClass(class {
   constructor(readonly view:EditorView){views.add(view);}
   destroy(){views.delete(this.view);}
  });
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
 dispose(){this.disposed=true;}
}
