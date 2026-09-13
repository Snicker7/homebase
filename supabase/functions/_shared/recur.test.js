import test from 'node:test';
import assert from 'node:assert';
import { expandAll, expandSeries, officeOccurrence, sortOccurrences, addDays, daysBetween, weekday, daysInMonth, MAX_WINDOW_DAYS, PAD_DAYS } from './recur.js';

const series = (over) => Object.assign({
  id: 'e1', title: 'Thing', notes: '', categoryId: 'family',
  day: '2026-09-15', time: null, minutes: null, repeat: null, repeatUntil: null,
}, over);
const days = (list) => list.map((o) => o.day);

test('day helpers work on strings without touching local time', () => {
  assert.strictEqual(addDays('2026-09-15', 1), '2026-09-16');
  assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(addDays('2026-03-01', -1), '2026-02-28');
  assert.strictEqual(weekday('2026-09-14'), 1, 'Monday is 1');
  assert.strictEqual(weekday('2026-09-20'), 7, 'Sunday is 7');
  assert.strictEqual(daysInMonth(2026, 2), 28);
  assert.strictEqual(daysInMonth(2028, 2), 29);
});

test('a one-off appears only inside the window', () => {
  const s = series();
  assert.deepStrictEqual(days(expandSeries(s, [], '2026-09-01', '2026-09-30')), ['2026-09-15']);
  assert.deepStrictEqual(expandSeries(s, [], '2026-10-01', '2026-10-31'), []);
});

test('a daily rule fills the window and stops at repeat_until', () => {
  const s = series({ repeat: { freq: 'daily' }, repeatUntil: '2026-09-18' });
  assert.deepStrictEqual(days(expandSeries(s, [], '2026-09-01', '2026-09-30')),
    ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']);
});

test('repeat_until is inclusive', () => {
  const s = series({ repeat: { freq: 'daily' }, repeatUntil: '2026-09-16' });
  assert.deepStrictEqual(days(expandSeries(s, [], '2026-09-01', '2026-09-30')), ['2026-09-15', '2026-09-16']);
});

test('a weekly rule fires on its listed weekdays only', () => {
  // 2026-09-15 is a Tuesday. Tue and Thu.
  const s = series({ repeat: { freq: 'weekly', days: [2, 4] } });
  assert.deepStrictEqual(days(expandSeries(s, [], '2026-09-14', '2026-09-27')),
    ['2026-09-15', '2026-09-17', '2026-09-22', '2026-09-24']);
});

test('a weekly rule crosses the spring and autumn DST boundaries unshifted', () => {
  // DST starts 2027-03-14 and ends 2026-11-01 in Denver. Times are wall-clock,
  // so a 09:00 Sunday event is 09:00 on both sides.
  const s = series({ day: '2026-10-25', time: '09:00', minutes: 60, repeat: { freq: 'weekly', days: [7] } });
  const out = expandSeries(s, [], '2026-10-25', '2026-11-08');
  assert.deepStrictEqual(days(out), ['2026-10-25', '2026-11-01', '2026-11-08']);
  assert.ok(out.every((o) => o.time === '09:00'));
});

test('a monthly rule skips months that lack the day rather than sliding', () => {
  const s = series({ day: '2026-01-31', repeat: { freq: 'monthly', day: 31 } });
  assert.deepStrictEqual(days(expandSeries(s, [], '2026-01-01', '2026-05-31')),
    ['2026-01-31', '2026-03-31', '2026-05-31']);
});

test('a yearly rule on 29 February skips common years', () => {
  const s = series({ day: '2028-02-29', repeat: { freq: 'yearly' } });
  assert.deepStrictEqual(days(expandSeries(s, [], '2028-01-01', '2032-12-31')),
    ['2028-02-29', '2032-02-29']);
});

test('a yearly rule carries a birthday forever', () => {
  const s = series({ day: '1991-06-04', repeat: { freq: 'yearly' } });
  assert.deepStrictEqual(days(expandSeries(s, [], '2026-01-01', '2026-12-31')), ['2026-06-04']);
});

test('a skipped occurrence disappears and the rest stay', () => {
  const s = series({ repeat: { freq: 'weekly', days: [2] } });
  const ex = [{ eventId: 'e1', day: '2026-09-22', skipped: true, override: null }];
  assert.deepStrictEqual(days(expandSeries(s, ex, '2026-09-15', '2026-09-29')), ['2026-09-15', '2026-09-29']);
});

test('an override changes one occurrence and leaves the series alone', () => {
  const s = series({ repeat: { freq: 'weekly', days: [2] }, time: '09:00', minutes: 30 });
  const ex = [{ eventId: 'e1', day: '2026-09-22', skipped: false, override: { title: 'Moved', time: '14:00' } }];
  const out = expandSeries(s, ex, '2026-09-15', '2026-09-29');
  assert.deepStrictEqual(out.map((o) => [o.day, o.title, o.time]), [
    ['2026-09-15', 'Thing', '09:00'],
    ['2026-09-22', 'Moved', '14:00'],
    ['2026-09-29', 'Thing', '09:00'],
  ]);
});

test('an exception belonging to another event is ignored', () => {
  const s = series({ repeat: { freq: 'weekly', days: [2] } });
  const ex = [{ eventId: 'other', day: '2026-09-22', skipped: true, override: null }];
  assert.strictEqual(expandSeries(s, ex, '2026-09-15', '2026-09-29').length, 3);
});

test('expandAll follows an occurrence moved into the window and drops one moved out', () => {
  const s = series({ id: 'e1', day: '2026-09-01', repeat: { freq: 'monthly', day: 1 } });
  const ex = [
    // Moved out of October, and into October from November.
    { eventId: 'e1', day: '2026-10-01', skipped: false, override: { day: '2026-09-30' } },
    { eventId: 'e1', day: '2026-11-01', skipped: false, override: { day: '2026-10-31' } },
  ];
  assert.deepStrictEqual(days(expandAll([s], ex, '2026-10-01', '2026-10-31')), ['2026-10-31']);
});

test('seriesDay stays the original date after a move, so the exception can be found again', () => {
  const s = series({ repeat: { freq: 'weekly', days: [2] } });
  const ex = [{ eventId: 'e1', day: '2026-09-22', skipped: false, override: { day: '2026-09-24' } }];
  const moved = expandSeries(s, ex, '2026-09-15', '2026-09-29').find((o) => o.day === '2026-09-24');
  assert.strictEqual(moved.seriesDay, '2026-09-22');
});

test('a window wider than five years is refused rather than spun over', () => {
  const s = series({ repeat: { freq: 'daily' } });
  assert.throws(() => expandSeries(s, [], '2020-01-01', '2030-01-01'), /window/);
});

test('office rows become occurrences filed under their brand', () => {
  const task = officeOccurrence({
    id: 'abc', kind: 'task', brand: 'keepsite', slug: 'sapphire-stem-floral', business: 'Sapphire Stem Floral',
    title: 'Layouts approved', day: '2026-09-15', time: null, minutes: null, done: false,
    waits_on_client: false, url: 'https://example.com/x',
  });
  assert.strictEqual(task.categoryId, 'keepsite');
  assert.strictEqual(task.readOnly, true);
  assert.strictEqual(task.business, 'Sapphire Stem Floral');

  const own = officeOccurrence({ id: 'd', kind: 'task', brand: null, title: 'Post', day: '2026-09-19', time: '09:00:00' });
  assert.strictEqual(own.categoryId, 'office', 'a brand-free own task files under office');
  assert.strictEqual(own.time, '09:00', 'a Postgres time loses its seconds');
});

test('sorting puts all-day items before timed ones, then by time, then by title', () => {
  const at = (day, time, title) => ({ day, time, title });
  const out = sortOccurrences([
    at('2026-09-16', '09:00', 'B'), at('2026-09-15', '14:00', 'Late'),
    at('2026-09-15', null, 'Zebra'), at('2026-09-15', null, 'Apple'), at('2026-09-15', '09:00', 'Early'),
  ]);
  assert.deepStrictEqual(out.map((o) => o.title), ['Apple', 'Zebra', 'Early', 'Late', 'B']);
});

test('expandAll accepts a window of exactly the documented maximum and refuses one day more', () => {
  const s = series({ repeat: { freq: 'daily' } });
  const from = '2026-01-01';
  // The padding expandAll applies internally must not eat into the caller's allowance.
  assert.doesNotThrow(() => expandAll([s], [], from, addDays(from, MAX_WINDOW_DAYS)));
  assert.throws(() => expandAll([s], [], from, addDays(from, MAX_WINDOW_DAYS + 1)), /window/);
});

test('daysBetween counts whole days in both directions', () => {
  assert.strictEqual(daysBetween('2026-09-01', '2026-10-02'), 31);
  assert.strictEqual(daysBetween('2026-10-02', '2026-09-01'), -31);
  assert.strictEqual(daysBetween('2026-09-01', '2026-09-01'), 0);
});

test('an override moved by the pad still lands in the window it moved into', () => {
  const s = series({ day: '2026-09-01', repeat: { freq: 'monthly', day: 1 } });
  const moved = addDays('2026-09-01', PAD_DAYS);
  const ex = [{ eventId: 'e1', day: '2026-09-01', skipped: false, override: { day: moved } }];
  assert.deepStrictEqual(days(expandAll([s], ex, moved, moved)), [moved]);
});
