import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dayKey,monthDays,eventsOnDay,defaultEventTimes,eventValidation,eventDateLabel,CalendarEvent} from '../src/calendar-model';
const event=(start:string,end:string,allDay=false):CalendarEvent=>({id:start,title:'sample',start,end,allDay});
test('month view spans 42 local days across a year boundary',()=>{const days=monthDays(new Date(2027,0,10));assert.equal(days.length,42);assert.equal(dayKey(days[0]!), '2026-12-27');assert.equal(dayKey(days[41]!), '2027-02-06');assert.equal(days[0]!.getDay(),0);});
test('leap-year February includes the 29th',()=>assert.ok(monthDays(new Date(2028,1,1)).some(d=>dayKey(d)==='2028-02-29')));
test('a midnight ending does not leak onto the next day',()=>{const item=event('2026-10-24T23:00','2026-10-25T00:00');assert.equal(eventsOnDay([item],new Date(2026,9,25)).length,0);});
test('overnight events appear on both dates; all-day entries sort first',()=>{const overnight=event('2026-10-24T23:00','2026-10-25T01:00'),allDay=event('2026-10-25T00:00','2026-10-26T00:00',true);assert.equal(eventsOnDay([overnight],new Date(2026,9,24)).length,1);assert.deepEqual(eventsOnDay([overnight,allDay],new Date(2026,9,25)),[allDay,overnight]);});
test('new event uses selected day and rounds today to the next quarter hour',()=>{const now=new Date(2026,9,25,13,9);assert.deepEqual(defaultEventTimes(now,now),{start:'2026-10-25T13:15',end:'2026-10-25T14:15'});assert.deepEqual(defaultEventTimes(new Date(2026,9,27),now),{start:'2026-10-27T09:00',end:'2026-10-27T10:00'});});
test('event form rejects empty titles, invalid dates and reversed times',()=>{assert.ok(eventValidation(' ','2026-10-25T09:00','2026-10-25T10:00'));assert.ok(eventValidation('a','','bad'));assert.ok(eventValidation('a','2026-10-25T10:00','2026-10-25T09:00'));assert.equal(eventValidation('a','2026-10-25T09:00','2026-10-25T10:00'),null);});

test('multi-day detail dates include both ends and all-day exclusive midnight',()=>{const allDay=event('2026-10-03T00:00','2026-10-06T00:00',true);assert.match(eventDateLabel(allDay),/10월 3일/);assert.match(eventDateLabel(allDay),/10월 5일/);assert.doesNotMatch(eventDateLabel(allDay),/10월 6일/);const single=event('2026-10-03T00:00','2026-10-04T00:00',true);assert.ok(!eventDateLabel(single).includes(' – '));});

test('all-day candidate uses an inclusive displayed last day and exclusive calendar end',async()=>{const {allDayBounds}=await import('../src/calendar-model');assert.deepEqual(allDayBounds('2026-12-31','2027-01-01'),{start:'2026-12-31T00:00:00+09:00',end:'2027-01-02T00:00:00+09:00'});assert.equal(allDayBounds('2026-02-30','2026-03-01'),null);assert.equal(allDayBounds('2026-03-02','2026-03-01'),null);});
