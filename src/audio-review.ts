import {open} from 'node:fs/promises';
export async function audioRange(path:string,startMs:number,endMs:number):Promise<Uint8Array>{
 if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs<0||endMs<startMs)throw new Error('잘못된 재생 구간');
 const file=await open(path,'r');
 try{
  const header=Buffer.alloc(44);await file.read(header,0,44,0);
  if(header.toString('ascii',0,4)!=='RIFF'||header.toString('ascii',8,12)!=='WAVE'||header.toString('ascii',36,40)!=='data'||header.readUInt16LE(20)!==1||header.readUInt16LE(22)!==1||header.readUInt16LE(34)!==16||header.readUInt32LE(24)!==16000)throw new Error('이 회의의 PCM16 모노 원본을 재생할 수 없습니다.');
  const stat=await file.stat(),total=Math.min(header.readUInt32LE(40),stat.size-44);
  const from=Math.min(total,Math.max(0,Math.floor((startMs-1000)*32/2)*2));
  const to=Math.min(total,Math.ceil(Math.min(endMs+1000,startMs+30000)*32/2)*2);
  const data=Buffer.alloc(Math.max(0,to-from));const read=await file.read(data,0,data.length,44+from);
  const size=read.bytesRead-read.bytesRead%2;header.writeUInt32LE(36+size,4);header.writeUInt32LE(size,40);
  return new Uint8Array(Buffer.concat([header,data.subarray(0,size)]));
 }finally{await file.close();}
}
