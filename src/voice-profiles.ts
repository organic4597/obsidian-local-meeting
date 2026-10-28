import {randomUUID} from 'node:crypto';
import {chmod,mkdir,readFile,readdir,rename,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const LIMIT=2_000_000;
export interface VoiceFeature {cluster:string;speechMs:number;vector:number[];}
export interface VoiceFeatures {schemaVersion:1;modelHash:string;passId:string;session:string;items:VoiceFeature[];}
export interface VoiceSample {key:string;session:string;passId:string;cluster:string;modelHash:string;speechMs:number;vector:number[];created:string;verified?:boolean;}
export interface VoiceProfile {schemaVersion:1;id:string;name:string;enabled:boolean;samples:VoiceSample[];created:string;updated:string;}
export interface VoiceMatch {profileId:string;name:string;score:number;speechMs:number;}
const validId=(s:string)=>/^[a-f0-9-]{36}$/.test(s);
const key=(name:string)=>name.trim().normalize('NFC').toLocaleLowerCase();
const vectorOK=(v:unknown):v is number[]=>Array.isArray(v)&&v.length===256&&v.every(x=>typeof x==='number'&&Number.isFinite(x))&&v.some(x=>Math.abs(x)>1e-8);
export function validateFeatures(value:unknown,session:string,passId:string):VoiceFeatures{
 const v=value as VoiceFeatures;
 if(!v||v.schemaVersion!==1||v.session!==session||v.passId!==passId||!/^[a-f0-9]{64}$/.test(v.modelHash)||!Array.isArray(v.items)||v.items.length>32||v.items.some(x=>!/^community_\d{1,2}$/.test(x.cluster)||!Number.isSafeInteger(x.speechMs)||x.speechMs<3000||!vectorOK(x.vector))||new Set(v.items.map(x=>x.cluster)).size!==v.items.length)throw new Error('화자 특징 데이터를 확인하지 못했습니다.');
 return v;
}
export function cosine(a:number[],b:number[]){if(!vectorOK(a)||!vectorOK(b))return NaN;let dot=0,x=0,y=0;for(let i=0;i<a.length;i++){dot+=a[i]!*b[i]!;x+=a[i]!**2;y+=b[i]!**2;}return dot/Math.sqrt(x*y);}
/** Explicitly supplied, user-evaluated thresholds only; close matches are withheld. */
export function autoMatch(candidates:VoiceMatch[],speechMs:number,thresholdText:string,marginText:string):VoiceMatch|null{
 if(!thresholdText.trim()||!marginText.trim())return null;const threshold=Number(thresholdText),margin=Number(marginText);
 if(!Number.isFinite(threshold)||threshold< -1||threshold>1||!Number.isFinite(margin)||margin<=0||margin>2||speechMs<10000)return null;
 const [best,second]=candidates;if(!best||!second||best.speechMs<60000||best.score<threshold||best.score-second.score<margin)return null;
 return best;
}
/** Each profile is private, atomic, and capped including metadata and history. */
export class VoiceProfiles {
 private pending:Promise<unknown>=Promise.resolve();readonly dir:string;
 constructor(private root:string){this.dir=join(root,'.local-meeting-quality','voice-profiles');}
 private serial<T>(fn:()=>Promise<T>):Promise<T>{const p=this.pending.then(fn);this.pending=p.catch(()=>{});return p;}
 private async ensure(){await mkdir(this.dir,{recursive:true,mode:0o700});await chmod(this.dir,0o700);}
 private async readAll():Promise<VoiceProfile[]>{await this.ensure();const out:VoiceProfile[]=[];for(const name of await readdir(this.dir)){if(!/^[a-f0-9-]{36}\.json$/.test(name))continue;const path=join(this.dir,name),data=await readFile(path,'utf8');if(Buffer.byteLength(data)>LIMIT)throw new Error('2MB를 초과한 화자 프로필을 발견했습니다.');const v=JSON.parse(data) as VoiceProfile;if(v.schemaVersion!==1||!validId(v.id)||name!==v.id+'.json'||typeof v.name!=='string'||!Array.isArray(v.samples)||v.samples.some(s=>!vectorOK(s.vector)||!/^[a-f0-9]{64}$/.test(s.modelHash)))throw new Error('화자 프로필 데이터를 확인하지 못했습니다.');out.push(v);}return out;}
 private async save(profile:VoiceProfile){await this.ensure();const data=JSON.stringify(profile);if(Buffer.byteLength(data)>LIMIT)throw new Error('화자 프로필이 2MB를 넘습니다. 기존 데이터를 보존했습니다.');const path=join(this.dir,profile.id+'.json'),tmp=path+'.tmp';await writeFile(tmp,data,{mode:0o600});await chmod(tmp,0o600);await rename(tmp,path);}
 private async purgeFeature(session:string,passId:string,cluster:string){
  if(!validId(session)||!/^[a-f0-9]{64}$/.test(passId)||!/^community_\d{1,2}$/.test(cluster))return;
  const path=join(this.root,session,'voice-features.json');let raw:string;try{raw=await readFile(path,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  const parsed=JSON.parse(raw) as VoiceFeatures;if(parsed.passId!==passId)return;const f=validateFeatures(parsed,session,passId),items=f.items.filter(i=>i.cluster!==cluster);if(items.length===f.items.length)return;
  const temp=path+'.tmp';await writeFile(temp,JSON.stringify({...f,items}),{mode:0o600});await rename(temp,path);
 }
 list():Promise<VoiceProfile[]>{return this.serial(()=>this.readAll());}
 /** User explicitly names a group; identical names must resolve uniquely. */
 enroll(name:string,features:VoiceFeatures,cluster:string,profileId?:string):Promise<VoiceProfile>{return this.serial(async()=>{
  validateFeatures(features,features.session,features.passId);const label=name.trim();if(!label||label.length>60||/[\r\n\x00-\x1f]/.test(label))throw new Error('화자 이름을 확인하세요.');const item=features.items.find(x=>x.cluster===cluster);if(!item)throw new Error('등록할 수 있는 단독 음성 특징이 부족합니다.');
  const profiles=await this.readAll(),same=profiles.filter(p=>key(p.name)===key(label));if(same.length>1)throw new Error('같은 이름의 프로필이 여러 개입니다.');if(profileId&&same[0]?.id!==profileId)throw new Error('선택한 이름과 프로필이 일치하지 않습니다.');const now=new Date().toISOString(),profile=same[0]??{schemaVersion:1 as const,id:randomUUID(),name:label,enabled:true,samples:[],created:now,updated:now};
  if(same.length&&!profileId&&!profile.samples.some(s=>s.session===features.session&&s.passId===features.passId&&s.cluster===cluster))throw new Error('같은 이름의 프로필이 있습니다. 음성 프로필 화면에서 직접 연결해 주세요.');
  const sampleKey=[features.session,features.passId,cluster].join(':'),existing=profile.samples.find(s=>s.key===sampleKey);if(!existing){profile.samples.push({key:sampleKey,session:features.session,passId:features.passId,cluster,modelHash:features.modelHash,speechMs:item.speechMs,vector:item.vector,created:now,verified:true});profile.updated=now;await this.save(profile);}else if(existing.verified===false){existing.verified=true;profile.updated=now;await this.save(profile);}return structuredClone(profile);
 });}
 /** Auto-collected samples are quarantined until a human confirms the identity. */
 observe(profileId:string,features:VoiceFeatures,cluster:string):Promise<void>{return this.serial(async()=>{validateFeatures(features,features.session,features.passId);const item=features.items.find(i=>i.cluster===cluster),p=(await this.readAll()).find(x=>x.id===profileId&&x.enabled);if(!item||!p)throw new Error('자동 수집할 프로필이나 특징이 없습니다.');if(!p.samples.some(s=>s.modelHash===features.modelHash&&s.verified!==false))throw new Error('모델이 다른 프로필입니다.');const sampleKey=[features.session,features.passId,cluster].join(':');if(p.samples.some(s=>s.key===sampleKey))return;const now=new Date().toISOString();p.samples.push({key:sampleKey,session:features.session,passId:features.passId,cluster,modelHash:features.modelHash,speechMs:item.speechMs,vector:item.vector,created:now,verified:false});p.updated=now;await this.save(p);});}
 /** A correction invalidates the entire group from every profile, not just the last assignment. */
 invalidate(session:string,passId:string,cluster:string,purge=true):Promise<number>{return this.serial(async()=>{if(purge)await this.purgeFeature(session,passId,cluster);let changed=0;for(const p of await this.readAll()){const kept=p.samples.filter(s=>!(s.session===session&&s.passId===passId&&s.cluster===cluster));if(kept.length===p.samples.length)continue;p.samples=kept;p.updated=new Date().toISOString();await this.save(p);changed++;}return changed;});}
 setEnabled(id:string,enabled:boolean):Promise<void>{return this.serial(async()=>{const p=(await this.readAll()).find(x=>x.id===id);if(!p)throw new Error('프로필을 찾을 수 없습니다.');p.enabled=enabled;p.updated=new Date().toISOString();await this.save(p);});}
 delete(id:string):Promise<void>{return this.serial(async()=>{if(!validId(id))throw new Error('잘못된 프로필 ID');const p=(await this.readAll()).find(x=>x.id===id);if(!p)throw new Error('프로필을 찾을 수 없습니다.');for(const sample of p.samples)await this.purgeFeature(sample.session,sample.passId,sample.cluster);await unlink(join(this.dir,id+'.json'));});}
 match(features:VoiceFeatures,cluster:string):Promise<VoiceMatch[]>{return this.serial(async()=>{const target=features.items.find(i=>i.cluster===cluster);if(!target)return [];const results:VoiceMatch[]=[];for(const p of await this.readAll()){if(!p.enabled)continue;const samples=p.samples.filter(s=>s.verified!==false&&s.modelHash===features.modelHash&&s.session!==features.session);if(!samples.length)continue;const scores=samples.map(s=>cosine(target.vector,s.vector)).filter(Number.isFinite);if(scores.length)results.push({profileId:p.id,name:p.name,score:Math.max(...scores),speechMs:samples.reduce((n,s)=>n+s.speechMs,0)});}return results.sort((a,b)=>b.score-a.score);});}
}
