import {test} from 'node:test';
import assert from 'node:assert/strict';
import {textEdits} from '../src/text-edits';
function apply(before:string,after:string){let result=before;for(const e of textEdits(before,after).reverse())result=result.slice(0,e.from)+e.insert+result.slice(e.to);assert.equal(result,after);}
test('separates an inserted heading from an edited later sentence',()=>{const before='화자 1: 첫 발언. 이어서 설명합니다.\n\n',after='추가 필기\n\n화자 1: 첫 발언. 사용자 수정합니다.\n\n';const changes=textEdits(before,after);assert.equal(changes[0]!.from,0);assert.equal(changes[0]!.to,0);assert.ok(changes.length>1);apply(before,after);});
test('diff covers empty, Unicode, repeated text and bounded wholesale replacements',()=>{for(const [a,b] of [['','한글'],['abc',''],['가나다 가나다','앞\n가나다 라마바'],['a'.repeat(2000),'b'.repeat(2000)],['😀 김영희 👩‍💻','😀 진행자 👩‍💻'],['unchanged','unchanged']])apply(a!,b!);});
test('multiple small edits reconstruct the complete original document',()=>{for(let i=0;i<60;i++){const before='prefix '+Array.from({length:20},(_,j)=>`문장${j} `).join('')+'suffix';let after=before.slice(0,i)+'메모'+before.slice(i);after=after.slice(0,80)+'수정'+after.slice(82);apply(before,after);}});
