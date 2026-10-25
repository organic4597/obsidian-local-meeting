export interface TextEdit {from:number;to:number;insert:string;}
/** Bounded Myers diff: frequent typing takes the single-change fast path. */
export function textEdits(before:string,after:string):TextEdit[] {
 if(before===after)return [];
 let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
 let end=before.length,last=after.length;while(end>start&&last>start&&before[end-1]===after[last-1]){end--;last--;}
 const fallback=[{from:start,to:end,insert:after.slice(start,last)}];
 if(start===end||start===last)return fallback;
 const a=before.slice(start,end),b=after.slice(start,last),trace:Map<number,number>[]=[];
 const frontier=new Map<number,number>([[1,0]]);let work=0;
 for(let distance=0;distance<=Math.min(a.length+b.length,256);distance++){
  trace.push(new Map(frontier));
  for(let k=-distance;k<=distance;k+=2){
   if(++work>500000)return fallback;
   let x=k===-distance||(k!==distance&&(frontier.get(k-1)??-1)<(frontier.get(k+1)??-1))?(frontier.get(k+1)??0):(frontier.get(k-1)??0)+1;
   let y=x-k;
   while(x<a.length&&y<b.length&&a[x]===b[y]){x++;y++;if(++work>500000)return fallback;}
   frontier.set(k,x);
   if(x<a.length||y<b.length)continue;
   const steps:('equal'|'insert'|'delete')[]=[];
   for(let d=distance;d>=0;d--){
    const v=trace[d]!,diagonal=x-y;
    const previous=diagonal===-d||(diagonal!==d&&(v.get(diagonal-1)??-1)<(v.get(diagonal+1)??-1))?diagonal+1:diagonal-1;
    const px=v.get(previous)??0,py=px-previous;
    while(x>px&&y>py){steps.push('equal');x--;y--;}
    if(d===0)break;
    if(x===px){steps.push('insert');y--;}else{steps.push('delete');x--;}
   }
   const edits:TextEdit[]=[];let old=start,next=start,edit:TextEdit|undefined;
   for(const step of steps.reverse()){
    if(step==='equal'){if(edit){edits.push(edit);edit=undefined;}old++;next++;}
    else{edit??={from:old,to:old,insert:''};if(step==='delete'){old++;edit.to=old;}else edit.insert+=after[next++]!;}
   }
   if(edit)edits.push(edit);return edits;
  }
 }
 return fallback;
}
