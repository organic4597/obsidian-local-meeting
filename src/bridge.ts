import {spawn,ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {parseEvent,WorkerEvent} from './model';
export class WorkerBridge {
  private child?:ChildProcessWithoutNullStreams;
  constructor(private event:(event:WorkerEvent)=>void,private exit:()=>void) {}
  start(python:string,script:string,model:string,directory:string,resume:boolean,device:string) {
    if(this.child) throw new Error('이미 실행 중입니다.');
    const args=['-u',script,'--model',model,'--session',directory];
    if(resume) args.push('--resume');
    if(device.trim()) {
      if(!/^\d+$/.test(device)) throw new Error('입력 장치 번호는 숫자여야 합니다.');
      args.push('--device',device.trim());
    }
    const child=spawn(python,args,{shell:false,env:{...process.env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1'},stdio:'pipe'});
    this.child=child;
    let diagnostic='';
    child.stderr.on('data',(data:Buffer)=>{diagnostic=(diagnostic+data.toString()).slice(-4000);});
    const reader=createInterface({input:child.stdout});
    reader.on('line',line=>{try {this.event(parseEvent(line));} catch {this.event({type:'error',message:'워커 출력 형식 오류: '+line.slice(0,150)});}});
    child.on('error',error=>this.event({type:'error',message:error.message,fatal:true}));
    child.on('close',code=>{
      reader.close();this.child=undefined;
      if(code!==0) this.event({type:'error',message:`워커 종료(${code}). ${diagnostic.slice(-1000)}`});
      this.exit();
    });
    child.stdin.on('error',error=>this.event({type:'error',message:error.message}));
  }
  stop(){this.child?.stdin.write(JSON.stringify({type:'stop'})+'\n');}
  retry(){this.child?.stdin.write(JSON.stringify({type:'retry'})+'\n');}
  dispose(){this.stop(); this.child?.stdin.end();}
}
