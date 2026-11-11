import {Notice,Setting} from 'obsidian';
import {AI_SKILLS,AISkillId,AISkillSettings,normalizeAISkills} from './ai-skills';
export interface AISkillHost {settings:{aiSkills:AISkillSettings};setAISkill(id:AISkillId,enabled:boolean):Promise<void>;}
export function renderAISkillSettings(parent:HTMLElement,host:AISkillHost,disabled=false){
 const section=parent.createDiv({cls:'lm-ai-skills'});section.createEl('h3',{text:'AI 정리 스킬'});
 section.createEl('p',{text:'선택한 지침을 한 번의 AI 정리 요청에 함께 적용합니다. 모두 끄면 기본 정리만 사용합니다. 변경은 다음 정리부터 반영되며 기존 노트는 유지됩니다.',cls:'lm-hint'});
 for(const skill of AI_SKILLS)new Setting(section).setName(skill.name).setDesc(skill.description).addToggle(toggle=>{toggle.setValue(normalizeAISkills(host.settings.aiSkills)[skill.id]).setDisabled(disabled).onChange(async enabled=>{toggle.setDisabled(true);try{await host.setAISkill(skill.id,enabled);}catch(error){toggle.setValue(normalizeAISkills(host.settings.aiSkills)[skill.id]);new Notice(String(error),8000);}finally{toggle.setDisabled(disabled);}});});
 section.createEl('p',{text:'im-not-ai는 사실 보존과 보수적 윤문 지침을 적용합니다. 원본 프로젝트의 별도 진단 스크립트·변경률 검사·다단계 실행은 포함하지 않습니다.',cls:'lm-hint'});
 return section;
}
