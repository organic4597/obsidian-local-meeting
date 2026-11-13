import {StateEffect,StateField} from '@codemirror/state';
import {EditorView,Panel,showPanel,ViewUpdate} from '@codemirror/view';
export interface PreviewFrame {key:string;text:string;final:boolean;typing:boolean;}
export const setPreview=StateEffect.define<PreviewFrame|null>();
export const previewExtension=StateField.define<PreviewFrame|null>({
 create:()=>null,
 update(value,tr){for(const e of tr.effects)if(e.is(setPreview))value=e.value;return value;},
 provide:field=>showPanel.from(field,frame=>frame?previewPanel:null)
});
function previewPanel(view:EditorView):Panel{
 const doc=view.dom.ownerDocument,root=doc.createElement('section'),header=root.appendChild(doc.createElement('div')),body=root.appendChild(doc.createElement('div')),follow=header.appendChild(doc.createElement('button')),label=header.appendChild(doc.createElement('span'));
 root.setAttribute('aria-label','실시간 회의 전사');header.className='lm-preview-label';body.className='lm-preview-text';body.tabIndex=0;body.setAttribute('role','log');body.setAttribute('aria-live','off');body.setAttribute('aria-label','실시간 전사 내용 · 스크롤로 이전 발언 보기');follow.type='button';follow.className='lm-preview-follow';follow.textContent='최신 발언 따라가기';let following=true;
 const scroll=()=>{following=body.scrollHeight-body.scrollTop-body.clientHeight<36;follow.hidden=following;};body.addEventListener('scroll',scroll);
 follow.addEventListener('click',()=>{following=true;body.scrollTop=body.scrollHeight;follow.hidden=true;});
 function paint(){const frame=view.state.field(previewExtension);if(!frame)return;root.className='lm-transcript-preview'+(frame.final?' is-final':'')+(frame.typing?' is-typing':'');label.textContent=frame.final?'확정 기록 작성 중':'실시간 전사 · 자동 저장됨';const position=body.scrollTop;body.textContent=frame.text||'말씀하시면 전사가 여기에 나타납니다.';body.scrollTop=following?body.scrollHeight:position;follow.hidden=following;}
 paint();return {dom:root,top:false,mount:paint,update(update:ViewUpdate){if(update.startState.field(previewExtension)!==update.state.field(previewExtension))paint();},destroy(){body.removeEventListener('scroll',scroll);}};
}
