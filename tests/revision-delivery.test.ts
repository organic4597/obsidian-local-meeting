import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import {join} from 'node:path';
const requireFromRepo=createRequire(join(process.cwd(),'package.json'));
const code=buildSync({entryPoints:['src/main.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['obsidian','electron','@codemirror/state','@codemirror/view']}).outputFiles![0]!.text;
class Base {app:unknown;manifest={version:'test'};constructor(app:unknown){this.app=app;}}
function setup(){
 const module:{exports:any}={exports:{}};
 runInNewContext(code,{module,exports:module.exports,require:(id:string)=>id==='obsidian'?{Plugin:Base,PluginSettingTab:Base,ItemView:Base,Modal:Base,Notice:Base}:requireFromRepo(id),structuredClone,Buffer,setTimeout,clearTimeout,window:{setTimeout,clearTimeout}});
 const p:any=new module.exports.default({});const commands:unknown[]=[];const errors:string[]=[];
 p.editors={find:()=>undefined};p.refresh=()=>{};p.showError=(e:string)=>errors.push(e);p.bridge={command:(c:unknown)=>commands.push(c)};
 p.meeting={id:'session',note:'test.md',directory:'/tmp/test',speakers:{},segments:[{id:'u_1',start:0,end:1000,text:'원문',speaker:'speaker_1',revision:1}],rendered:{},started:''};
 return {p,commands,errors};
}
const update={type:'segment',session:'session',segment:{id:'u_1',start:0,end:2000,text:'새 전사',speaker:'speaker_1',revision:2}};
test('failed note application is not acknowledged and can be replayed',async()=>{
 const {p,commands,errors}=setup();p.renderSegments=async()=>{throw Object.assign(new Error('disk unavailable'),{noteCommitted:false});};
 p.receive(update,'session');await p.writes;assert.equal(p.meeting.segments[0].revision,1);assert.equal(commands.length,0);assert.equal(errors.length,1);
 p.renderSegments=async()=>{};p.receive(update,'session');await p.writes;assert.equal(p.meeting.segments[0].text,'새 전사');assert.equal(commands.length,1);
});
test('a saved note with failed metadata is persisted before duplicate acknowledgement',async()=>{
 const {p,commands}=setup();p.renderSegments=async()=>{p.persistFailed=true;throw Object.assign(new Error('metadata unavailable'),{noteCommitted:true});};
 p.receive(update,'session');await p.writes;assert.equal(p.meeting.segments[0].revision,2);assert.equal(commands.length,0);
 let saves=0;p.saveMeeting=async()=>{saves++;p.persistFailed=false;};p.receive(update,'session');await p.writes;assert.equal(saves,1);assert.equal(commands.length,1);
});
test('late events from a previous meeting cannot update or acknowledge the active note',async()=>{
 const {p,commands}=setup();p.renderSegments=async()=>{throw new Error('must not run');};p.receive(update,'previous-session');await p.writes;
 assert.equal(p.meeting.segments[0].revision,1);assert.equal(commands.length,0);
});
