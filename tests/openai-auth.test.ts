import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {ChatGPTAuth,AuthData} from '../src/openai-auth';
import {OpenAITransport} from '../src/openai-http';
const keyPromise=(async()=>{const key=await generateKeyPair('RS256');return {key,jwk:{...await exportJWK(key.publicKey),kid:'test-key',alg:'RS256',use:'sig'}};})();
async function fixture(options:{nonceWrong?:boolean;scopes?:string;subject?:string;identityOnly?:boolean;beforeExchange?:()=>Promise<void>}={}){
 const {key,jwk}=await keyPromise;
 let stored:AuthData|null=null,urlResolve!:(u:URL)=>void;const opened=new Promise<URL>(r=>urlResolve=r);let authUrl:URL,refreshes=0;
 const http:OpenAITransport=async(url,method,headers,body)=>{
  if(url.endsWith('jwks.json'))return {status:200,headers:{},text:JSON.stringify({keys:[jwk]})};
  if(url.endsWith('openid-configuration'))return {status:200,headers:{},text:JSON.stringify({revocation_endpoint:'https://auth.openai.com/revoke'})};
  if(url.endsWith('/revoke'))return {status:200,headers:{},text:''};
  assert.ok(url.endsWith('/oauth/token'));const form=new URLSearchParams(body);assert.equal(form.get('client_id'),'oaiapp_test');
  if(form.get('grant_type')==='refresh_token'){refreshes++;return {status:200,headers:{},text:JSON.stringify({access_token:'rotated-test-access',refresh_token:'rotated-test-refresh',token_type:'Bearer',expires_in:3600,scope:'chatgpt.tokens.use.direct'})};}
  await options.beforeExchange?.();
  assert.equal(form.get('redirect_uri'),authUrl.searchParams.get('redirect_uri'));assert.ok(form.get('code_verifier'));
  const id=await new SignJWT({nonce:options.nonceWrong?'wrong':authUrl.searchParams.get('nonce'),email:'synthetic@example.test'}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuer('https://auth.openai.com').setAudience('oaiapp_test').setSubject(options.subject??'synthetic-account').setIssuedAt().setExpirationTime('1h').sign(key.privateKey);
  return {status:200,headers:{},text:JSON.stringify({id_token:id,...(options.identityOnly?{}:{access_token:'test-access',refresh_token:'test-refresh',token_type:'Bearer',expires_in:3600}),scope:options.scopes??'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'})};
 };
 const auth=new ChatGPTAuth({read:async()=>stored,write:async d=>{stored=structuredClone(d);}},async u=>{authUrl=new URL(u);urlResolve(authUrl);},http);
 return {auth,opened,store:()=>stored,refreshes:()=>refreshes,expire:()=>{const d=(auth as any).data;d.accounts[0].expiresAt=0;}};
}
async function complete(f:Awaited<ReturnType<typeof fixture>>,change?:(u:URL)=>void){const result=f.auth.login().then(()=>null,e=>e as Error);const url=await f.opened;assert.equal(url.origin,'https://auth.openai.com');assert.equal(url.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(url.searchParams.get('code_challenge_method'),'S256');const callback=new URL(url.searchParams.get('redirect_uri')!);assert.equal(callback.hostname,'127.0.0.1');callback.search=new URLSearchParams({state:url.searchParams.get('state')!,code:'synthetic-code',client_id:'oaiapp_test'}).toString();change?.(callback);const response=await fetch(callback);await response.text();return {error:await result,status:response.status};}
test('browser OAuth verifies signed identity and saves only issued client identity',async()=>{const f=await fixture();assert.equal((await complete(f)).error,null);const s=await f.auth.status();assert.equal(s.planAllowed,true);assert.equal(f.store()!.accounts[0]!.clientId,'oaiapp_test');assert.equal(await f.auth.access(),'test-access');assert.equal(await f.auth.welcome(),true);assert.equal(await f.auth.welcome(),false);await f.auth.logout();assert.equal((await f.auth.status()).connected,false);assert.equal(f.store()!.accounts[0]!.clientId,'oaiapp_test');});
test('wrong OAuth state cannot exchange or save any token',async()=>{const f=await fixture();const r=await complete(f,u=>u.searchParams.set('state','wrong'));assert.equal(r.status,400);assert.ok(r.error);assert.equal(f.store()!.accounts.length,0);});
test('signed token with wrong nonce is rejected',async()=>{const f=await fixture({nonceWrong:true});assert.ok((await complete(f)).error);assert.equal(f.store()!.accounts.length,0);});
test('identity-only consent does not enable inference',async()=>{const f=await fixture({scopes:'openid profile email'});assert.equal((await complete(f)).error,null);assert.equal((await f.auth.status()).planAllowed,false);await assert.rejects(()=>f.auth.access(),/사용 권한/);});
test('concurrent access refreshes a rotating token once',async()=>{const f=await fixture();await complete(f);f.expire();assert.deepEqual(await Promise.all([f.auth.access(),f.auth.access()]),['rotated-test-access','rotated-test-access']);assert.equal(f.refreshes(),1);assert.equal(f.store()!.accounts[0]!.refreshToken,'rotated-test-refresh');});
test('denied browser consent ends the attempt without credentials',async()=>{const f=await fixture();assert.ok((await complete(f,u=>u.searchParams.set('error','access_denied'))).error);assert.equal(f.store()!.accounts.length,0);});

test('declining plan usage can retain a verified identity without API access tokens',async()=>{const f=await fixture({scopes:'openid profile email',identityOnly:true});assert.equal((await complete(f)).error,null);assert.equal((await f.auth.status()).connected,true);assert.equal((await f.auth.status()).planAllowed,false);assert.equal(f.store()!.accounts[0]!.accessToken,undefined);await assert.rejects(()=>f.auth.access(),/사용 권한/);});

test('cancelling during code exchange cannot later persist a signed-in session',async()=>{let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>entered=r),continueExchange=new Promise<void>(r=>release=r);const f=await fixture({beforeExchange:async()=>{entered();await continueExchange;}});const result=complete(f);await waiting;f.auth.cancel();release();assert.ok((await result).error);assert.equal(f.store()!.accounts.length,0);});
