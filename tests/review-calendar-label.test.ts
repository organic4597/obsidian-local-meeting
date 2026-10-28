import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eventDateLabel} from '../src/meeting-dates';
test('reviewed all-day schedule displays its inclusive dates without an invented time',()=>{
 assert.equal(eventDateLabel({title:'일정',start:'2026-12-30T15:00:00.000Z',end:'2027-01-01T15:00:00.000Z',date:'2026-12-31',endDate:'2027-01-01',whenText:'',allDay:true}),'2026-12-31–2027-01-01 · 종일');
});
