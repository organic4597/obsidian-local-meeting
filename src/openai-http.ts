import {request} from 'node:https';
import * as tls from 'node:tls';
export interface HttpResult {status:number;headers:Record<string,string|undefined>;text:string;}
export type OpenAITransport=(url:string,method:string,headers:Record<string,string>,body?:string)=>Promise<HttpResult>;
/** Node HTTPS avoids renderer CORS; redirects and arbitrary credential destinations are forbidden. */
export const openAIRequest:OpenAITransport=(url,method,headers,body)=>new Promise((resolve,reject)=>{
 const target=new URL(url);if(target.protocol!=='https:'||!['auth.openai.com','api.openai.com'].includes(target.hostname)||target.port||target.username||target.password){reject(new Error('허용되지 않은 OpenAI 연결 주소'));return;}
 const systemCa=(tls as typeof tls & {getCACertificates?:(kind:string)=>string[]}).getCACertificates?.('system')??[];
 const req=request(target,{method,headers,timeout:180000,ca:systemCa.length?[...tls.rootCertificates,...systemCa]:undefined},res=>{let text='',bytes=0;res.setEncoding('utf8');res.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>8_000_000){req.destroy(new Error('OpenAI 응답이 너무 큽니다.'));return;}text+=chunk;});res.on('end',()=>resolve({status:res.statusCode??0,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(','):v])),text}));res.on('error',()=>reject(new Error('OpenAI 응답 연결이 중단됐습니다.')));});
 req.on('timeout',()=>req.destroy(new Error('OpenAI 응답 시간이 초과됐습니다.')));req.on('error',()=>reject(new Error('OpenAI에 연결하지 못했습니다. 네트워크 상태를 확인해 주세요.')));if(body)req.write(body);req.end();
});
export function requireSuccess(r:HttpResult){if(r.status>=200&&r.status<300)return;let code='';try{const e=JSON.parse(r.text).error;const candidate=typeof e==='object'?e?.code:e;if(typeof candidate==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(candidate))code=candidate;}catch{}throw new Error(`OpenAI 요청 실패 (${r.status}${code?' · '+code:''}). ${r.status===401?'다시 로그인해 주세요.':r.status===429?'ChatGPT 사용량 설정을 확인해 주세요.':'계정 권한과 연결 상태를 확인해 주세요.'}`);}
