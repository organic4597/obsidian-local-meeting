import {StateEffect,StateField} from '@codemirror/state';
import {Decoration,EditorView,WidgetType} from '@codemirror/view';
export interface PreviewFrame {key:string;text:string;final:boolean;typing:boolean;}
export const setPreview=StateEffect.define<PreviewFrame|null>();
class PreviewWidget extends WidgetType {
 constructor(private frame:PreviewFrame){super();}
 eq(other:PreviewWidget){return JSON.stringify(this.frame)===JSON.stringify(other.frame);}
 private update(root:HTMLElement){
  root.className='lm-transcript-preview'+(this.frame.final?' is-final':'')+(this.frame.typing?' is-typing':'');
  root.querySelector('.lm-preview-label')!.textContent=this.frame.final?'확정 기록 작성 중':'임시 전사 · 자동 저장됨';
  root.querySelector('.lm-preview-text')!.textContent=this.frame.text||'발언이 끝나면 전사가 여기에 나타납니다.';
 }
 toDOM(){const root=document.createElement('div');root.contentEditable='false';root.setAttribute('aria-label','회의 전사 미리보기');
  const label=root.appendChild(document.createElement('div'));label.className='lm-preview-label';
  const text=root.appendChild(document.createElement('div'));text.className='lm-preview-text';text.setAttribute('aria-live','off');
  this.update(root);return root;
 }
 updateDOM(root:HTMLElement){this.update(root);return true;}
 ignoreEvent(){return true;}
}
// A state field provides block decorations at the current end after any user edit.
export const previewExtension=StateField.define({
 create(state){return {frame:null as PreviewFrame|null,decorations:Decoration.none};},
 update(value,tr){let frame=value.frame;for(const e of tr.effects)if(e.is(setPreview))frame=e.value;
  return {frame,decorations:frame?Decoration.set([Decoration.widget({widget:new PreviewWidget(frame),block:true,side:1}).range(tr.newDoc.length)]):Decoration.none};},
 provide:field=>EditorView.decorations.from(field,v=>v.decorations)
});
