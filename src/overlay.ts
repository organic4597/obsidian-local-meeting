export interface OverlayPosition {x:number;y:number;}
const inset=12;
export function clampOverlay(position:OverlayPosition,width:number,height:number,viewportWidth:number,viewportHeight:number):OverlayPosition {
  const maxX=Math.max(0,viewportWidth-width-inset),maxY=Math.max(0,viewportHeight-height-inset);
  const minX=Math.min(inset,maxX),minY=Math.min(48,maxY);
  return {x:Math.max(minX,Math.min(Number.isFinite(position.x)?position.x:minX,maxX)),y:Math.max(minY,Math.min(Number.isFinite(position.y)?position.y:minY,maxY))};
}
interface Options {overlay:HTMLElement;button:HTMLButtonElement;menu:HTMLElement;getPosition:()=>OverlayPosition|null;savePosition:(position:OverlayPosition)=>void;}
export function attachOverlayDrag(options:Options){
  const {overlay,button,menu}=options;const win=button.ownerDocument.defaultView!;
  const controller=new AbortController();const signal=controller.signal;
  let gesture:{id:number;x:number;y:number;left:number;top:number;dragged:boolean}|undefined;
  let suppressClickUntil=0;
  function apply(position:OverlayPosition){
    const rect=button.getBoundingClientRect();const p=clampOverlay(position,rect.width,rect.height,win.innerWidth,win.innerHeight);
    overlay.style.right='auto';overlay.style.left=`${p.x}px`;overlay.style.top=`${p.y}px`;return p;
  }
  function refreshPosition(){
    if(gesture||!button.isConnected)return;
    const rect=button.getBoundingClientRect();apply(options.getPosition()??{x:win.innerWidth-rect.width-20,y:144});
    if(!menu.hidden)layoutMenu();
  }
  function layoutMenu(){
    if(menu.hidden)return;
    const rect=button.getBoundingClientRect();const width=menu.offsetWidth,height=menu.offsetHeight;
    const left=Math.max(inset,Math.min(rect.right-width,win.innerWidth-width-inset));
    const below=rect.bottom+8,above=rect.top-height-8;
    const top=below+height<=win.innerHeight-inset?below:Math.max(inset,above);
    menu.style.right='auto';menu.style.left=`${left-rect.left}px`;menu.style.top=`${top-rect.top}px`;
  }
  function finish(event:PointerEvent){
    if(!gesture||event.pointerId!==gesture.id)return;
    const ended=gesture;gesture=undefined;overlay.classList.remove('is-dragging');
    if(button.hasPointerCapture(event.pointerId))button.releasePointerCapture(event.pointerId);
    if(ended.dragged){
      suppressClickUntil=win.performance.now()+300;
      const rect=button.getBoundingClientRect();options.savePosition(apply({x:rect.left,y:rect.top}));
    }
  }
  button.addEventListener('pointerdown',event=>{
    if(event.button!==0||!event.isPrimary)return;
    suppressClickUntil=0;const rect=button.getBoundingClientRect();
    gesture={id:event.pointerId,x:event.clientX,y:event.clientY,left:rect.left,top:rect.top,dragged:false};
    button.setPointerCapture(event.pointerId);
  },{signal});
  button.addEventListener('pointermove',event=>{
    if(!gesture||gesture.id!==event.pointerId)return;
    const dx=event.clientX-gesture.x,dy=event.clientY-gesture.y;
    if(!gesture.dragged&&Math.hypot(dx,dy)<5)return;
    gesture.dragged=true;event.preventDefault();overlay.classList.add('is-dragging');
    menu.hidden=true;button.setAttribute('aria-expanded','false');
    apply({x:gesture.left+dx,y:gesture.top+dy});
  },{signal});
  for(const type of ['pointerup','pointercancel','lostpointercapture'] as const)button.addEventListener(type,finish,{signal});
  button.addEventListener('click',event=>{
    if(event.detail>0&&win.performance.now()<suppressClickUntil){event.preventDefault();event.stopImmediatePropagation();}
  },{capture:true,signal});
  win.addEventListener('resize',refreshPosition,{signal});
  const observer=new ResizeObserver(refreshPosition);observer.observe(button);refreshPosition();
  return {refreshPosition,layoutMenu,dispose(){controller.abort();observer.disconnect();gesture=undefined;overlay.classList.remove('is-dragging');}};
}
