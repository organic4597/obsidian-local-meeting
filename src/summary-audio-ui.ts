import {App,Modal,Notice} from 'obsidian';
import {EditorView,ViewPlugin,Decoration,DecorationSet,WidgetType,ViewUpdate} from '@codemirror/view';
import {StateEffect} from '@codemirror/state';
import {SummaryAudioIndex,playbackRanges,PlaybackRange,recordingPath} from './summary-playback';
import {audioRange} from './audio-review';
import {timestamp} from './model';
const refreshLinks=StateEffect.define<null>();
interface PlaybackHost {root:()=>string;recording:()=>boolean;fileOf:(view:EditorView)=>string|undefined;}
/** One local player for all summary links; replacing or unloading it always stops audio. */
export class SummaryAudio {
 readonly extension;private views=new Set<EditorView>();private roots=new Map<HTMLElement,string>();private player?:RangePlayer;private disposed=false;
 constructor(private app:App,readonly index:SummaryAudioIndex,private host:PlaybackHost){
  const owner=this;
  this.extension=ViewPlugin.fromClass(class {
   decorations:DecorationSet;constructor(readonly view:EditorView){owner.views.add(view);this.decorations=this.build();}
   update(update:ViewUpdate){if(update.docChanged||update.viewportChanged||update.selectionSet||update.transactions.some(t=>t.effects.some(e=>e.is(refreshLinks))))this.decorations=this.build();}
   build(){const path=owner.host.fileOf(this.view),session=path?owner.index.session(path):undefined;if(!session)return Decoration.none;const ranges=[];
    for(const visible of this.view.visibleRanges){const text=this.view.state.doc.sliceString(visible.from,visible.to);for(const range of playbackRanges(text)){const from=visible.from+range.from,to=visible.from+range.to;if(this.view.state.selection.ranges.some(s=>s.from<to&&s.to>from||s.empty&&s.head>from&&s.head<to))continue;ranges.push(Decoration.replace({widget:new RangeLink(owner,session,range)}).range(from,to));}}
    return Decoration.set(ranges,true);
   }
   destroy(){owner.views.delete(this.view);}
  },{decorations:plugin=>plugin.decorations});
 }
 refresh(){if(this.disposed)return;for(const view of this.views)view.dispatch({effects:refreshLinks.of(null)});for(const [root,path] of this.roots){if(root.isConnected)this.decorate(root,path);else this.roots.delete(root);}}
 process(root:HTMLElement,path:string){this.roots.set(root,path);this.decorate(root,path);}
 private decorate(root:HTMLElement,path:string){const session=this.index.session(path);if(!session)return;const walk=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes:Text[]=[];let next:Node|null;
  while(next=walk.nextNode()){const text=next as Text;if(!text.parentElement?.closest('a,button,code,pre,script,style')&&playbackRanges(text.data).length)nodes.push(text);}
  for(const node of nodes){const fragment=document.createDocumentFragment();let at=0;for(const range of playbackRanges(node.data)){fragment.append(document.createTextNode(node.data.slice(at,range.from)),this.button(session,range));at=range.to;}fragment.append(document.createTextNode(node.data.slice(at)));node.replaceWith(fragment);}
 }
 button(session:string,range:PlaybackRange){const button=document.createElement('button');button.className='lm-audio-range';button.type='button';button.textContent=range.label;button.title='이 구간 녹음 재생';button.setAttribute('aria-label',range.label+' 녹음 재생');button.addEventListener('mousedown',e=>e.preventDefault());button.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();this.play(session,range);});return button;}
 play(session:string,range:PlaybackRange){if(this.disposed)return;this.player?.close();try{this.player=new RangePlayer(this.app,recordingPath(this.host.root(),session),range,this.host.recording);this.player.open();}catch(e){new Notice(String(e),8000);}}
 stop(){this.player?.close();this.player=undefined;}
 dispose(){this.disposed=true;this.stop();for(const root of this.roots.keys())for(const button of Array.from(root.querySelectorAll<HTMLButtonElement>('.lm-audio-range')))button.replaceWith(document.createTextNode(button.textContent??''));this.roots.clear();}
}
class RangeLink extends WidgetType {
 constructor(private owner:SummaryAudio,private session:string,private range:PlaybackRange){super();}
 eq(other:RangeLink){return this.session===other.session&&this.range.start===other.range.start&&this.range.end===other.range.end&&this.range.label===other.range.label;}
 toDOM(){return this.owner.button(this.session,this.range);}
 ignoreEvent(){return true;}
}
class RangePlayer extends Modal {
 private audio?:HTMLAudioElement;private url?:string;private status!:HTMLElement;private position!:HTMLElement;private closed=false;private request=0;private next=0;private chunkStart=0;private headphones=false;private playButton?:HTMLButtonElement;
 constructor(app:App,private path:string,private range:PlaybackRange,private recording:()=>boolean){super(app);this.next=range.start;}
 onOpen(){this.setTitle('구간 녹음');this.modalEl.addClass('lm-audio-modal');this.contentEl.createEl('p',{text:this.range.label,cls:'lm-audio-range-title'});this.status=this.contentEl.createEl('p',{text:'녹음 불러오는 중…',cls:'lm-hint',attr:{role:'status','aria-live':'polite'}});this.position=this.contentEl.createEl('p',{text:timestamp(this.range.start),cls:'lm-hint'});
  this.audio=this.contentEl.createEl('audio',{attr:{controls:'true',preload:'metadata','aria-label':'선택 구간 녹음'}});
  this.audio.addEventListener('playing',()=>{if(this.recording()&&!this.headphones){this.audio?.pause();this.status.setText('녹음 중입니다. 헤드폰을 확인한 뒤 재생하세요.');return;}this.status.setText('재생 중');});
  this.audio.addEventListener('pause',()=>{if(!this.closed&&!this.audio?.ended)this.status.setText('일시 정지');});
  this.audio.addEventListener('timeupdate',()=>{if(this.audio)this.position.setText(`${timestamp(this.chunkStart+this.audio.currentTime*1000)} / ${timestamp(this.range.end)}`);});
  this.audio.addEventListener('ended',()=>{if(this.next<this.range.end)void this.load();else this.status.setText('구간 재생 완료');});
  if(this.recording()){const label=this.contentEl.createEl('label',{cls:'lm-form-field'}),check=label.createEl('input',{type:'checkbox'});label.createSpan({text:'헤드폰으로 듣고 있습니다'});check.addEventListener('change',()=>{this.headphones=check.checked;if(this.playButton)this.playButton.disabled=!check.checked;});this.playButton=this.contentEl.createEl('button',{text:'구간 재생',cls:'mod-cta'});this.playButton.disabled=true;this.playButton.addEventListener('click',()=>{this.next=this.range.start;void this.load();});this.status.setText('스피커 소리가 다시 녹음되지 않도록 헤드폰을 확인해 주세요.');}
  else void this.load();
  const actions=this.contentEl.createDiv({cls:'lm-form-actions'});actions.createEl('button',{text:'처음부터 다시 듣기'}).addEventListener('click',()=>{this.next=this.range.start;void this.load();});actions.createEl('button',{text:'닫기'}).addEventListener('click',()=>this.close());
 }
 private async load(){if(this.closed||this.recording()&&!this.headphones)return;const request=++this.request,start=this.next,end=Math.min(this.range.end,start+600000);this.audio?.pause();this.status.setText('녹음 불러오는 중…');
  try{const pcm=await audioRange(this.path,start,end,{paddingMs:0,maxDurationMs:600000});if(this.closed||request!==this.request)return;if(pcm.byteLength<=44)throw new Error('선택한 시간에 저장된 녹음이 없습니다.');if(this.url)URL.revokeObjectURL(this.url);this.url=URL.createObjectURL(new Blob([pcm as BlobPart],{type:'audio/wav'}));this.chunkStart=start;this.next=end;this.audio!.src=this.url;try{await this.audio!.play();}catch{this.status.setText('재생 버튼을 눌러 들어보세요.');}}
  catch(e){if(!this.closed&&request===this.request)this.status.setText('녹음을 재생할 수 없습니다. '+String(e).replace(/^Error: /,''));}
 }
 onClose(){this.closed=true;this.request++;this.audio?.pause();this.audio?.removeAttribute('src');this.audio?.load();if(this.url)URL.revokeObjectURL(this.url);}
}
