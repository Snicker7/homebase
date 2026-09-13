import test from 'node:test';
import assert from 'node:assert';
import { CAL_ACTIONS, validateEvent, validateOccurrence, validateEventCategory, validateId } from './calactions.js';

const ok = (over) => Object.assign({
  title: 'Soccer', categoryId: 'family', day: '2026-09-15', time: null, minutes: null,
}, over);

test('the action list is what api routes on', () => {
  assert.deepStrictEqual(CAL_ACTIONS, [
    'eventSave', 'eventDelete', 'occurrenceSkip', 'occurrenceSave',
    'calCategorySave', 'calCategoryRetire', 'officeRefresh',
  ]);
});

test('a minimal all-day event validates and normalizes', () => {
  const v = validateEvent(ok());
  assert.deepStrictEqual(v, {
    id: null, title: 'Soccer', notes: '', categoryId: 'family', day: '2026-09-15',
    time: null, minutes: null, repeat: null, repeatUntil: null,
  });
});

test('a timed event keeps its duration and defaults nothing silently', () => {
  const v = validateEvent(ok({ time: '09:00', minutes: 30 }));
  assert.strictEqual(v.time, '09:00');
  assert.strictEqual(v.minutes, 30);
});

test('titles and dates are required and bounded', () => {
  assert.match(validateEvent(ok({ title: '   ' })).error, /title/);
  assert.match(validateEvent(ok({ title: 'x'.repeat(201) })).error, /200/);
  assert.match(validateEvent(ok({ day: '15/09/2026' })).error, /date/);
  assert.match(validateEvent(ok({ day: '2026-02-30' })).error, /date/);
  assert.match(validateEvent(ok({ categoryId: '' })).error, /category/);
});

test('a time needs a duration and a duration needs a time', () => {
  assert.match(validateEvent(ok({ time: '09:00' })).error, /how long/);
  assert.match(validateEvent(ok({ minutes: 30 })).error, /all-day/);
  assert.match(validateEvent(ok({ time: '9am', minutes: 30 })).error, /time/);
  assert.match(validateEvent(ok({ time: '09:00', minutes: 0 })).error, /1 and 1440/);
  assert.match(validateEvent(ok({ time: '09:00', minutes: 2000 })).error, /1 and 1440/);
});

test('the four repeat shapes are accepted', () => {
  // 2026-09-15 is a Tuesday, so weekly must list 2.
  assert.deepStrictEqual(validateEvent(ok({ repeat: { freq: 'daily' } })).repeat, { freq: 'daily' });
  assert.deepStrictEqual(validateEvent(ok({ repeat: { freq: 'weekly', days: [2, 4] } })).repeat, { freq: 'weekly', days: [2, 4] });
  assert.deepStrictEqual(validateEvent(ok({ repeat: { freq: 'monthly', day: 15 } })).repeat, { freq: 'monthly', day: 15 });
  assert.deepStrictEqual(validateEvent(ok({ repeat: { freq: 'yearly' } })).repeat, { freq: 'yearly' });
});

test('anything outside those four shapes is refused', () => {
  assert.match(validateEvent(ok({ repeat: { freq: 'fortnightly' } })).error, /repeat/);
  assert.match(validateEvent(ok({ repeat: { freq: 'weekly', days: [] } })).error, /weekday/);
  assert.match(validateEvent(ok({ repeat: { freq: 'weekly', days: [9] } })).error, /weekday/);
  // The start day must be one of the repeat's own days, or the first
  // occurrence would not be the day the event says it starts.
  assert.match(validateEvent(ok({ repeat: { freq: 'weekly', days: [3] } })).error, /starts on a Tuesday/);
  // Likewise monthly: the rule's day is the start's day of month.
  assert.match(validateEvent(ok({ repeat: { freq: 'monthly', day: 20 } })).error, /15th/);
});

test('an end date needs a rule and cannot precede the start', () => {
  assert.match(validateEvent(ok({ repeatUntil: '2026-12-31' })).error, /repeat/);
  assert.match(validateEvent(ok({ repeat: { freq: 'daily' }, repeatUntil: '2026-09-01' })).error, /before/);
  assert.strictEqual(validateEvent(ok({ repeat: { freq: 'daily' }, repeatUntil: '2026-09-15' })).repeatUntil, '2026-09-15');
});

test('an occurrence change names its event and its original day', () => {
  const v = validateOccurrence({ eventId: 'e1', day: '2026-09-22', skipped: true });
  assert.deepStrictEqual(v, { eventId: 'e1', day: '2026-09-22', skipped: true, override: null });
  const moved = validateOccurrence({ eventId: 'e1', day: '2026-09-22', override: { day: '2026-09-24', title: 'Moved' } });
  assert.deepStrictEqual(moved.override, { day: '2026-09-24', title: 'Moved' });
  assert.match(validateOccurrence({ day: '2026-09-22', skipped: true }).error, /event/);
  assert.match(validateOccurrence({ eventId: 'e1', day: '2026-09-22' }).error, /nothing to change/);
  assert.match(validateOccurrence({ eventId: 'e1', day: 'x', skipped: true }).error, /date/);
  assert.match(validateOccurrence({ eventId: 'e1', day: '2026-09-22', override: { colour: 'red' } }).error, /nothing to change/);
});

test('override validations are enforced', () => {
  // time without minutes rejected
  assert.match(validateOccurrence({ eventId: 'e1', day: '2026-09-22', override: { time: '09:00' } }).error, /time and the length together/);
  // minutes without time rejected
  assert.match(validateOccurrence({ eventId: 'e1', day: '2026-09-22', override: { minutes: 30 } }).error, /time and the length together/);
  // both together accepted
  const both = validateOccurrence({ eventId: 'e1', day: '2026-09-22', override: { time: '09:00', minutes: 30 } });
  assert.strictEqual(both.override.time, '09:00');
  assert.strictEqual(both.override.minutes, 30);
  // { time: null, minutes: null } accepted as all-day
  const allDay = validateOccurrence({ eventId: 'e1', day: '2026-09-22', override: { time: null, minutes: null } });
  assert.strictEqual(allDay.override.time, null);
  assert.strictEqual(allDay.override.minutes, null);
  // minutes out of bounds rejected
  assert.match(validateOccurrence({ eventId: 'e1', day: '2026-09-22', override: { time: '09:00', minutes: 0 } }).error, /1 and 1440/);
  assert.match(validateOccurrence({ eventId: 'e1', day: '2026-09-22', override: { time: '09:00', minutes: 2000 } }).error, /1 and 1440/);
  // time: null and minutes: not-null is all-day with duration error
  assert.match(validateOccurrence({ eventId: 'e1', day: '2026-09-22', override: { time: null, minutes: 30 } }).error, /all-day event has no length/);
  // over-long notes rejected
  assert.match(validateOccurrence({ eventId: 'e1', day: '2026-09-22', override: { title: 'x', notes: 'x'.repeat(2001) } }).error, /notes must be 2000/);
  // empty categoryId rejected
  assert.match(validateOccurrence({ eventId: 'e1', day: '2026-09-22', override: { title: 'x', categoryId: '' } }).error, /category required/);
});

test('a category needs a name and a six-digit hex color', () => {
  assert.deepStrictEqual(validateEventCategory({ name: 'Vet visits', color: '#AABBCC' }),
    { id: 'vet-visits', name: 'Vet visits', color: '#aabbcc', sort: 100 });
  assert.match(validateEventCategory({ name: '', color: '#aabbcc' }).error, /name/);
  assert.match(validateEventCategory({ name: 'x', color: 'red' }).error, /color/);
  assert.match(validateEventCategory({ name: '🙂', color: '#aabbcc' }).error, /letter or digit/);
});

test('validateId trims and refuses empty', () => {
  assert.deepStrictEqual(validateId({ id: ' e1 ' }), { id: 'e1' });
  assert.match(validateId({}).error, /required/);
});
