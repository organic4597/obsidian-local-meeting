import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {createServer,Server} from 'node:http';
import {createLocalJWKSet,jwtVerify} from 'jose';
import {OpenAITransport,openAIRequest,requireSuccess} from './openai-http';
const ISSUER='https://auth.openai.com',RESOURCE='https://api.openai.com/v1';
const AUTHORIZE=ISSUER+'/api/accounts/authorize',TOKEN=ISSUER+'/api/accounts/oauth/token';
const SCOPES='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export interface ChatGPTAccount {id:string;clientId:string;subject:string;email:string;accessToken?:string;refreshToken?:string;idToken?:string;scopes:string[];expiresAt:number;earliestRefreshAt?:number;welcomed?:boolean;}
export interface AuthData {hostId:string;active?:string;accounts:ChatGPTAccount[];draftClientId?:string;}
export interface CredentialStore {read():Promise<AuthData|null>;write(value:AuthData):Promise<void>;}
export interface AuthStatus {connected:boolean;planAllowed:boolean;active?:string;accounts:{id:string;label:string;signedIn:boolean}[];}
export interface ModelChoice {id:string;name:string;}
type Pending={state:string;nonce:string;verifier:string;redirect:string;clientId:string;selected?:ChatGPTAccount;server:Server;timer:ReturnType<typeof setTimeout>;resolve:()=>void;reject:(e:Error)=>void;};
const random=()=>randomBytes(32).toString('base64url');
export class ChatGPTAuth {
 private data?:AuthData;private pending?:Pending;private refreshing?:Promise<ChatGPTAccount>;private generation=0;private jwks?:ReturnType<typeof createLocalJWKSet>;
 constructor(private store:CredentialStore,private openBrowser:(url:string)=>Promise<void>,private http:OpenAITransport=openAIRequest){}
 private async load(){return this.data??=(await this.store.read())??{hostId:'urn:uuid:'+randomUUID(),accounts:[]};}
 private async save(){await this.store.write((await this.load()));}
 async status():Promise<AuthStatus>{const d=await this.load(),a=d.accounts.find(a=>a.id===d.active);return {connected:!!a?.idToken,planAllowed:!!a?.accessToken&&a.scopes.includes('chatgpt.tokens.use.direct'),active:a?.id,accounts:d.accounts.map(a=>({id:a.id,label:`${a.email||'ChatGPT 계정'} · ${a.clientId.slice(-6)}`,signedIn:!!a.idToken}))};}
 async select(id:string){this.cancel();const d=await this.load();if(!d.accounts.some(a=>a.id===id))throw new Error('등록되지 않은 계정입니다.');d.active=id;await this.save();}
 async login(addAccount=false){
  if(this.pending)throw new Error('브라우저 로그인이 진행 중입니다. 완료하거나 취소해 주세요.');
  const generation=++this.generation,d=await this.load();await this.save();const selected=addAccount?undefined:d.accounts.find(a=>a.id===d.active),clientId=selected?.clientId??d.draftClientId??'dynamic_agent_client';
  return new Promise<void>((resolve,reject)=>{
   const server=createServer((req,res)=>{void (async()=>{
    const p=this.pending;if(!p||p.server!==server){res.writeHead(410);res.end();return;}
    const expectedHost=new URL(p.redirect).host;
    if(req.method!=='GET'||req.headers.host!==expectedHost||(req.url?.length??0)>8192){res.writeHead(400);res.end();return;}
    const u=new URL(req.url??'/',p.redirect);if(u.pathname!=='/auth/callback'){res.writeHead(404);res.end();return;}
    const state=Buffer.from(u.searchParams.get('state')??''),expectedState=Buffer.from(p.state),valid=state.length===expectedState.length&&timingSafeEqual(state,expectedState);
    if(!valid){res.writeHead(400);res.end('Invalid sign-in state');this.fail(new Error('로그인 상태를 검증하지 못했습니다. 다시 시도해 주세요.'));return;}
    clearTimeout(p.timer);this.pending=undefined;server.close();
    try{
     if(u.searchParams.has('error'))throw new Error('브라우저 인증이 취소되거나 거절됐습니다.');
     const code=u.searchParams.get('code'),issued=u.searchParams.get('client_id')??(p.clientId==='dynamic_agent_client'?'':p.clientId);
     if(!code||!/^oaiapp_[a-zA-Z0-9_-]+$/.test(issued)||p.clientId!=='dynamic_agent_client'&&issued!==p.clientId)throw new Error('OpenAI 앱 등록 정보를 확인하지 못했습니다.');
     if(!selected){d.draftClientId=issued;await this.save();}
     const r=await this.http(TOKEN,'POST',{'content-type':'application/x-www-form-urlencoded'},new URLSearchParams({grant_type:'authorization_code',client_id:issued,code,code_verifier:p.verifier,redirect_uri:p.redirect,resource:RESOURCE}).toString());requireSuccess(r);
     const t=JSON.parse(r.text);const identity=await this.verify(t.id_token,issued,p.nonce);
     if(selected&&identity.sub!==selected.subject)throw new Error('선택한 계정과 로그인한 계정이 다릅니다. 새 계정 추가를 사용해 주세요.');
     if(generation!==this.generation)throw new Error('Sign-in cancelled');
     const account=this.tokens(t,{id:issued+':'+identity.sub,clientId:issued,subject:identity.sub!,email:typeof identity.email==='string'?identity.email:'',scopes:[],expiresAt:0,welcomed:selected?.welcomed});
     const index=d.accounts.findIndex(a=>a.id===account.id);if(index<0)d.accounts.push(account);else d.accounts[index]=account;d.active=account.id;delete d.draftClientId;await this.save();
     res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'"});res.end('<meta charset="utf-8"><title>Local Meeting</title><p>로그인이 완료됐습니다. Obsidian으로 돌아가세요.</p>');p.resolve();
    }catch{res.writeHead(400,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});res.end('로그인을 완료하지 못했습니다. Obsidian에서 다시 시도해 주세요.');p.reject(new Error('OpenAI 로그인 또는 권한 검증에 실패했습니다. 다시 로그인해 주세요.'));}
   })().catch(()=>{res.writeHead(500);res.end();this.fail(new Error('브라우저 로그인을 완료하지 못했습니다.'));});});
   server.on('error',()=>{this.fail(new Error('로그인 반환 주소를 열지 못했습니다.'));reject(new Error('로그인 반환 주소를 열지 못했습니다.'));});
   server.listen(0,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string'){server.close();reject(new Error('로그인 반환 주소 오류'));return;}
    const p:Pending={state:random(),nonce:random(),verifier:random(),redirect:`http://127.0.0.1:${address.port}/auth/callback`,clientId,selected,server,timer:setTimeout(()=>this.fail(new Error('로그인 대기 시간이 지났습니다.')),600000),resolve,reject};this.pending=p;
    const u=new URL(AUTHORIZE);u.search=new URLSearchParams({client_id:clientId,ext_agent_host_id:d.hostId,response_type:'code',redirect_uri:p.redirect,scope:SCOPES,resource:RESOURCE,state:p.state,nonce:p.nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(p.verifier).digest('base64url')}).toString();
    if(clientId==='dynamic_agent_client')u.searchParams.set('agent_name_hint','Obsidian Local Meeting');
    if(selected?.idToken)u.searchParams.set('id_token_hint',selected.idToken);if(selected?.email)u.searchParams.set('login_hint',selected.email);
    if(selected?.idToken&&!selected.scopes.includes('chatgpt.tokens.use.direct'))u.searchParams.set('prompt','consent');
    void this.openBrowser(u.toString()).catch(()=>this.fail(new Error('시스템 브라우저를 열지 못했습니다.')));
   });
  });
 }
 cancel(){this.generation++;this.fail(new Error('로그인을 취소했습니다.'));}
 private fail(error:Error){const p=this.pending;if(!p)return;this.pending=undefined;clearTimeout(p.timer);p.server.close();p.reject(error);}
 private async verify(token:unknown,clientId:string,nonce?:string){if(typeof token!=='string')throw new Error('ID token missing');if(!this.jwks){const r=await this.http(ISSUER+'/.well-known/jwks.json','GET',{});requireSuccess(r);this.jwks=createLocalJWKSet(JSON.parse(r.text));}
  let result;try{result=await jwtVerify(token,this.jwks,{issuer:ISSUER,audience:clientId,requiredClaims:['sub','exp','iat'],algorithms:['RS256'],clockTolerance:5});}catch{this.jwks=undefined;throw new Error('ID token verification failed');}
  if(!result.payload.sub||nonce&&result.payload.nonce!==nonce)throw new Error('ID token identity mismatch');return result.payload;
 }
 private tokens(t:any,prior:ChatGPTAccount):ChatGPTAccount {
  const scopes=typeof t.scope==='string'?t.scope.split(/\s+/):prior.scopes,direct=scopes.includes('chatgpt.tokens.use.direct');
  if(typeof t.id_token!=='string'&&!prior.idToken||direct&&(typeof t.access_token!=='string'||!Number.isFinite(t.expires_in)||t.expires_in<=0||String(t.token_type).toLowerCase()!=='bearer'))throw new Error('Invalid OpenAI credentials');
  const raw=t.earliest_refresh_at,numeric=typeof raw==='number'?raw:typeof raw==='string'&&/^\d+$/.test(raw)?Number(raw):undefined;const earliest=numeric!==undefined?numeric*(numeric<1e12?1000:1):typeof raw==='string'?Date.parse(raw):undefined;
  return {...prior,accessToken:typeof t.access_token==='string'?t.access_token:undefined,refreshToken:typeof t.refresh_token==='string'?t.refresh_token:prior.refreshToken,idToken:t.id_token??prior.idToken,scopes,expiresAt:Number.isFinite(t.expires_in)?Date.now()+t.expires_in*1000:0,earliestRefreshAt:earliest};
 }
 async access(){
  const d=await this.load();let a=d.accounts.find(a=>a.id===d.active);if(!a?.accessToken||!a.scopes.includes('chatgpt.tokens.use.direct'))throw new Error('Continue with ChatGPT로 로그인하고 ChatGPT 사용 권한을 승인해 주세요.');
  if(a.expiresAt-Date.now()>60000)return a.accessToken;
  if(!this.refreshing){const selected=a;this.refreshing=(async()=>{if(!selected.refreshToken)throw new Error('로그인이 만료됐습니다. 다시 로그인해 주세요.');if(selected.earliestRefreshAt&&Date.now()<selected.earliestRefreshAt){if(selected.expiresAt>Date.now()+5000)return selected;throw new Error('OpenAI가 지정한 갱신 가능 시각 전입니다. 잠시 후 다시 시도해 주세요.');}
   const r=await this.http(TOKEN,'POST',{'content-type':'application/x-www-form-urlencoded'},new URLSearchParams({grant_type:'refresh_token',client_id:selected.clientId,refresh_token:selected.refreshToken,resource:RESOURCE}).toString());requireSuccess(r);const t=JSON.parse(r.text);
   if(t.id_token){const identity=await this.verify(t.id_token,selected.clientId);if(identity.sub!==selected.subject)throw new Error('갱신한 계정 정보가 다릅니다.');}
   if(typeof t.refresh_token!=='string')throw new Error('갱신 토큰을 확인하지 못했습니다. 다시 로그인해 주세요.');const next=this.tokens(t,selected);d.accounts[d.accounts.findIndex(x=>x.id===selected.id)]=next;await this.save();return next;
  })().finally(()=>{this.refreshing=undefined;});}
  a=await this.refreshing;if(d.active!==a.id)throw new Error('계정이 바뀌었습니다. 다시 요청해 주세요.');if(!a.scopes.includes('chatgpt.tokens.use.direct'))throw new Error('ChatGPT 사용 권한이 해제됐습니다. 다시 로그인해 주세요.');return a.accessToken!;
 }
 async models():Promise<ModelChoice[]>{const token=await this.access(),r=await this.http(RESOURCE+'/models','GET',{authorization:'Bearer '+token});requireSuccess(r);const data=JSON.parse(r.text);if(!Array.isArray(data.models))throw new Error('ChatGPT 모델 목록을 읽을 수 없습니다.');return data.models.filter((m:any)=>m.visibility==='list'&&typeof m.slug==='string').map((m:any)=>({id:m.slug,name:typeof m.display_name==='string'?m.display_name:m.slug}));}
 async welcome(){const d=await this.load(),a=d.accounts.find(a=>a.id===d.active);if(!a||a.welcomed||!a.scopes.includes('chatgpt.tokens.use.direct'))return false;a.welcomed=true;await this.save();return true;}
 async logout(){this.cancel();if(this.refreshing)await this.refreshing.catch(()=>{});const d=await this.load(),a=d.accounts.find(a=>a.id===d.active);if(!a)return true;let revoked=!a.refreshToken;
  if(a.refreshToken)try{const r=await this.http(ISSUER+'/.well-known/openid-configuration','GET',{});requireSuccess(r);const endpoint=new URL(JSON.parse(r.text).revocation_endpoint);if(endpoint.origin!==ISSUER)throw new Error('Invalid revocation destination');const res=await this.http(endpoint.toString(),'POST',{'content-type':'application/x-www-form-urlencoded'},new URLSearchParams({token:a.refreshToken,token_type_hint:'refresh_token',client_id:a.clientId}).toString());requireSuccess(res);revoked=true;}catch{}
  delete a.accessToken;delete a.refreshToken;delete a.idToken;a.expiresAt=0;a.scopes=[];await this.save();return revoked;
 }
}
