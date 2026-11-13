import {createElement as h,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Theme,defineTheme} from '@astryxdesign/core/theme';
import {themes,defaultThemeSlug} from './astryx-themes';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import {Tab,TabList} from '@astryxdesign/core/TabList';

// Obsidian owns the shell and palette. Astryx owns navigation state and keyboard behavior.
const theme=defineTheme({name:'local-meeting-obsidian',extends:themes[defaultThemeSlug],tokens:{'--color-accent':'var(--interactive-accent)','--color-text-primary':'var(--text-normal)','--color-text-secondary':'var(--text-muted)','--color-background-body':'var(--background-primary)','--color-background-surface':'var(--background-primary)','--font-family-body':'var(--font-interface)'}});
export interface NavigationPanel {id:string;label:string;element:HTMLElement;}
export function mountNavigation(parent:HTMLElement,panels:NavigationPanel[],initial:string,change?:(id:string)=>void){
 const mount=parent.createEl('nav',{cls:'lm-astryx-root lm-navigation',attr:{'aria-label':'회의록 화면'}}),root=createRoot(mount);
 const select=(id:string)=>{for(const panel of panels){panel.element.hidden=panel.id!==id;panel.element.setAttribute('role','tabpanel');panel.element.setAttribute('aria-label',panel.label);}change?.(id);};
 const initialId=panels.some(p=>p.id===initial)?initial:panels[0]!.id;select(initialId);
 function Navigation(){const [value,setValue]=useState(initialId),[mode,setMode]=useState<'dark'|'light'>(parent.ownerDocument.body.classList.contains('theme-dark')?'dark':'light');
  useEffect(()=>{const observer=new MutationObserver(()=>setMode(parent.ownerDocument.body.classList.contains('theme-dark')?'dark':'light'));observer.observe(parent.ownerDocument.body,{attributes:true,attributeFilter:['class']});return()=>observer.disconnect();},[]);
  return h(Theme,{theme,mode,children:h(TabList,{value,size:'sm',layout:'fill',role:'tablist','aria-label':'회의록 화면 전환',hasDivider:true,onChange:(id:string)=>{select(id);setValue(id);},children:panels.map(panel=>h(Tab,{key:panel.id,value:panel.id,label:panel.label,panelId:panel.element.id}))})});
 }
 const keyboard=(event:KeyboardEvent)=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;const tab=(event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');if(!tab)return;const tabs=Array.from(mount.querySelectorAll<HTMLElement>('[role="tab"]')),index=tabs.indexOf(tab);if(index<0)return;const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;event.preventDefault();event.stopPropagation();tabs[next]!.click();mount.ownerDocument.defaultView?.requestAnimationFrame(()=>mount.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus());};
 mount.addEventListener('keydown',keyboard,true);root.render(h(Navigation));return ()=>{mount.removeEventListener('keydown',keyboard,true);root.unmount();};
}
export function createNavigationPanel(parent:HTMLElement,id:string,label:string){const element=parent.createEl('section',{cls:'lm-navigation-panel',attr:{id}});return {id,label,element};}
