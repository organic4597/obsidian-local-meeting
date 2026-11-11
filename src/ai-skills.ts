import {createHash} from 'node:crypto';

export const AI_SKILL_IDS=['summarize-meeting','stop-slop-ko','im-not-ai','k-humanizer'] as const;
export type AISkillId=typeof AI_SKILL_IDS[number];
export type AISkillSettings=Record<AISkillId,boolean>;
export interface AISkillDefinition {id:AISkillId;name:string;description:string;repository:string;commit:string;sourcePath:string;instructions:string;}
export interface AISkillProfile {version:1;hash:string;enabled:AISkillId[];}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const DEFAULT_AI_SKILLS:Readonly<AISkillSettings>=Object.freeze({'summarize-meeting':true,'stop-slop-ko':true,'im-not-ai':true,'k-humanizer':true});
/** Fixed API adaptations, not executable upstream agent workflows. See SOURCE.json in each bundled skill directory. */
export const AI_SKILLS:readonly AISkillDefinition[]=[
  {
    "id": "summarize-meeting",
    "name": "summarize-meeting · 회의 요약",
    "description": "명시된 결정·담당자·기한·미결 사항을 정리합니다.",
    "repository": "https://github.com/tomzx/agents",
    "commit": "e9c4674dd39717e185bed40b7b964d3b794be89d",
    "sourcePath": "skills/summarize-meeting/SKILL.md",
    "instructions": "회의 주제를 필요한 범위에서 묶고 시간 순서가 이해에 필요하면 유지한다. summary에는 회의의 핵심 내용을 간결하게 정리한다. decisions에는 명시적으로 합의하거나 승인한 결정만 넣고 제안과 검토 사항은 구분한다. 실제로 맡기로 한 구체적 후속 조치만 tasks에 넣으며 담당자나 기한이 명시되지 않았으면 null로 둔다. 미해결 질문과 보류 사항은 openQuestions에 남긴다. 전달된 발언자의 의도와 뉘앙스를 보존하며 편집자의 의견을 더하지 않는다. 없는 항목을 형식상 채우지 말고 빈 배열로 둔다. 각 항목을 제공된 발언 또는 필기에 연결하고 지정 JSON 스키마를 따른다."
  },
  {
    "id": "stop-slop-ko",
    "name": "stop-slop-ko · 한국어 문장 정리",
    "description": "과장·군더더기·번역투를 줄이고 메모와 목록 형식을 유지합니다.",
    "repository": "https://github.com/limleesol/stop-slop-ko",
    "commit": "66b7a9b4065f9a89b454743ceb64e89b33fde96d",
    "sourcePath": "SKILL.md",
    "instructions": "생성한 한국어 설명 문장에만 보수적으로 적용한다. 회의록의 메모·요약 레지스터와 필요한 표·목록·압축 형식을 유지한다. 공허한 서론과 결론, 내용 없는 강조, 반복 설명, 과장된 형용사와 기계적인 대조·나열을 줄인다. 단순한 금칙어 치환이나 무조건 짧게 만들기는 하지 않는다. 정보가 있는 표현은 지우지 않는다. 수치의 단위·주기·조건·시제·확실성을 보존하고 예측·추정·검토 가능성을 확정이나 약속으로 바꾸지 않는다. 원문에 없는 근거·구체적 예시·사실을 발명하지 않는다. 문장 정리를 위해 원래 주장의 범위나 필요한 논점을 줄이지 않는다."
  },
  {
    "id": "im-not-ai",
    "name": "im-not-ai · 사실 보존 윤문",
    "description": "인명·수치·날짜·인용을 지키며 필요한 표현만 다듬습니다.",
    "repository": "https://github.com/epoko77-ai/im-not-ai",
    "commit": "b37e0206d31fffd9149bf57168d4d62eb2086bee",
    "sourcePath": "codex/skills/humanize-korean/SKILL.md",
    "instructions": "회의 요약 초안의 표현을 내부적으로 점검하고 문제가 있는 설명 문장만 보수적으로 다듬는다. 사실·주장·수치·날짜·고유명사·법조문·영어 약어와 직접 인용은 보존한다. 문장별 핵심 내용이 윤문 뒤 사라지거나 책임 주체·확실성이 달라지면 해당 변경을 되돌린다. 번역투·불필요한 피동·기계적 병렬·접속사 반복을 문맥에 맞게 고치되 원래 문체의 격을 올리거나 내리지 않는다. 이미 자연스러운 문장은 그대로 두며 문장을 고쳤다는 표시를 위한 동의어 교체는 하지 않는다. 이 적용은 API용 보존·윤문 지침이며 외부 진단·검증 스크립트, 실제 변경률 측정, 여러 모델 호출이나 에이전트 실행을 요구하지 않는다. 검증 점수·변경률·HTML 요약 주석을 출력하지 않는다."
  },
  {
    "id": "k-humanizer",
    "name": "K-Humanizer · 업무 한국어",
    "description": "업무 문체와 용어를 유지하고 요청·약속·조건의 차이를 보존합니다.",
    "repository": "https://github.com/evergreentree97/K-Humanizer",
    "commit": "61f0bb0632a75846b4cb37da19c55427bf8d6a8d",
    "sourcePath": "skills/k-humanizer/SKILL.md",
    "instructions": "한국어 내부 업무 회의록을 대상으로 자연스러운 업무 문장과 일관된 종결어미를 사용한다. 전문 용어·제품명·영어 약어는 독자가 쓰는 표기를 유지하며 문맥상 타당한 단어를 일괄 금지하거나 순화하지 않는다. 영어식 어순·긴 명사화·불필요한 주어를 줄이되 누가 무엇을 했는지 분명하게 유지한다. 발언자·이유·조건·결과의 연결을 보존하고 문장을 합쳐 새로운 인과관계를 만들지 않는다. 부정·예외·대략·최대 같은 한정과 요청·제안·약속의 차이를 지킨다. 인명·수치·단위·날짜·시간대·기한·직접 인용·식별자를 윤문 과정에서 바꾸지 않는다. 원문에 없는 이점·성과·사과·보장·긴급성·감정을 더하지 않는다. 이미 자연스러운 표현은 유지한다."
  }
];
export function normalizeAISkills(raw:unknown):AISkillSettings {const input=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};return Object.fromEntries(AI_SKILL_IDS.map(id=>[id,typeof input[id]==='boolean'?input[id]:DEFAULT_AI_SKILLS[id]])) as AISkillSettings;}
const CONTRACT='회의록 고정 스킬 적용 범위: 기존 회의 정리 규칙과 JSON 스키마가 우선한다. 스킬은 제공된 자료의 정리와 생성된 한국어 설명 문장에만 적용한다. 수동 교정한 원문을 재작성하지 않는다. 화자 ID·근거 ID·발언 시간·직접 인용·제품명·수치·단위·날짜·담당자·기한·부정·조건·확실성은 문체 개선을 이유로 바꾸지 않는다. 확정·제안·추정·미결을 구분하며 없는 사실이나 감정·의견을 추가하지 않는다. 목록·체크박스·표·문단은 회의록 형식에 필요하므로 일괄 제거하지 않는다. 숫자 등 원문에서 필요한 정보는 요약 목적상 선별하되, 윤문을 이유로 의미를 바꾸지 않는다. 기존 규칙에 따른 상대 날짜 변환은 허용한다. 원본 스킬의 파일 작성·셸·도구·네트워크·에이전트 실행 및 별도 출력 형식은 수행하지 않는다. 지정한 JSON만 반환한다.';
export function aiSkillProfile(raw:unknown=DEFAULT_AI_SKILLS):AISkillProfile {const settings=normalizeAISkills(raw),selected=AI_SKILLS.filter(s=>settings[s.id]);return {version:1,hash:hash({adapterVersion:1,contract:CONTRACT,skills:selected.map(s=>[s.id,s.commit,s.sourcePath,s.instructions])}),enabled:selected.map(s=>s.id)};}
export function aiSkillInstructions(profile?:AISkillProfile){if(!profile)return '';if(profile.version!==1||!Array.isArray(profile.enabled)||profile.enabled.some(id=>!AI_SKILL_IDS.includes(id)))throw new Error('AI 스킬 설정 형식이 다릅니다. 설정을 확인한 뒤 다시 정리하세요.');const settings=Object.fromEntries(AI_SKILL_IDS.map(id=>[id,profile.enabled.includes(id)])),verified=aiSkillProfile(settings);if(profile.hash!==verified.hash||JSON.stringify(profile.enabled)!==JSON.stringify(verified.enabled))throw new Error('AI 스킬 버전이 변경됐습니다. 최신 설정으로 다시 정리하세요.');if(!profile.enabled.length)return '';return '\n\n'+CONTRACT+'\n'+AI_SKILLS.filter(s=>settings[s.id]).map(s=>`<meeting-skill id="${s.id}">\n${s.instructions}\n</meeting-skill>`).join('\n');}
