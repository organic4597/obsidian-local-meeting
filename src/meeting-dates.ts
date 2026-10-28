/** Calendar arithmetic is independent of the host clock and timezone. */
export const MEETING_ZONE='Asia/Seoul';
export function validDay(value:unknown):value is string{return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
export function meetingDay(started:string){const date=new Date(started);if(!Number.isFinite(date.valueOf()))throw new Error('회의 시작 날짜를 확인해 주세요.');const p=new Intl.DateTimeFormat('en-CA',{timeZone:MEETING_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);const get=(t:string)=>p.find(x=>x.type===t)!.value;return `${get('year')}-${get('month')}-${get('day')}`;}
export function addDays(day:string,days:number){return new Date(Date.parse(day+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);}
export function dateContext(started:string){const date=meetingDay(started),weekday=(new Date(date+'T00:00:00Z').getUTCDay()+6)%7,monday=addDays(date,-weekday);return {referenceDate:date,timeZone:MEETING_ZONE,weekStartsOn:'Monday',today:date,tomorrow:addDays(date,1),dayAfterTomorrow:addDays(date,2),thisWeekMonday:monday,nextWeekMonday:addDays(monday,7),weekdays:'월=0, 화=1, 수=2, 목=3, 금=4, 토=5, 일=6'};}
export function resolveMeetingDays(expression:string,started:string):string[]|null{
 const c=dateContext(started),s=expression.replace(/\s+/g,'');
 if(/내일모레|지난|저번|언젠가|조만간/.test(s))return null;
 const offsets=[...s.matchAll(/오늘|내일|모레|모래|글피/g)].map(m=>({오늘:0,내일:1,모레:2,모래:2,글피:3}[m[0]]!));
 const days=offsets.map(n=>addDays(c.referenceDate,n));
 const weekdays=[...s.matchAll(/([월화수목금토일])요일/g)];
 for(const m of weekdays){const prefix=s.slice(0,m.index),week=[...prefix.matchAll(/다다음주|다음주|차주|이번주|금주/g)].at(-1)?.[0],index='월화수목금토일'.indexOf(m[1]!);
  if(week){const n=week==='다다음주'?14:week==='다음주'||week==='차주'?7:0;days.push(addDays(c.thisWeekMonday,n+index));}
  else {const now=(new Date(c.referenceDate+'T00:00:00Z').getUTCDay()+6)%7;days.push(addDays(c.referenceDate,(index-now+7)%7));}
 }
 const explicit=s.match(/(?:(\d{4})년)?(\d{1,2})월(\d{1,2})일/);
 if(explicit){let year=Number(explicit[1]??c.referenceDate.slice(0,4));if(!explicit[1]&&s.includes('내년'))year++;let day=`${year}-${explicit[2]!.padStart(2,'0')}-${explicit[3]!.padStart(2,'0')}`;if(!explicit[1]&&!s.includes('올해')&&!s.includes('내년')&&day<c.referenceDate)day=`${year+1}`+day.slice(4);if(validDay(day))days.push(day);}
 return days.length?[...new Set(days)].sort():null;
}
export interface DatedEvent {title:string;start:string|null;end:string|null;whenText:string;date?:string|null;endDate?:string|null;allDay?:boolean;}
export function normalizeEventDates<T extends DatedEvent>(event:T,started:string):Array<T&DatedEvent>{
 const dates=resolveMeetingDays(event.whenText,started);let e={...event};
 if(!dates){if(/다음\s*주|다다음\s*주|조만간|언젠가|내일모레/.test(event.whenText)){e.date=null;e.endDate=null;e.start=null;e.end=null;}return [e];}
 const apply=(day:string,endDate:string|null)=>{let result={...e,date:day,endDate};
  // A contradictory timestamp must not silently book the wrong day.
  if(result.start&&meetingDay(result.start)!==day){result.start=null;result.end=null;}
  if(result.end&&endDate&&meetingDay(result.end)!==endDate){result.start=null;result.end=null;}
  return result;
 };
 if(dates.length>1&&/부터|까지|[~～]/.test(event.whenText))return [apply(dates[0]!,dates.at(-1)!)];
 return dates.map(day=>apply(day,null));
}
export function eventDateLabel(e:DatedEvent){const date=e.date??(e.start?meetingDay(e.start):null);if(!date)return e.whenText?`${e.whenText} · 날짜 확인 필요`:'날짜·시간 미정';const range=e.endDate&&e.endDate!==date?`${date}–${e.endDate}`:date;const time=e.allDay?'종일':e.start?new Intl.DateTimeFormat('ko-KR',{timeZone:MEETING_ZONE,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(e.start)):'시간 미정';return `${range} · ${time}`;}

export function normalizeEvents<T extends DatedEvent>(events:T[],started:string){const seen=new Set<string>();return events.flatMap(e=>normalizeEventDates(e,started)).filter(e=>{const key=JSON.stringify([e.title,e.whenText,e.date,e.endDate,e.start,e.end]);if(seen.has(key))return false;seen.add(key);return true;});}
