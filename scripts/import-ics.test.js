import test from 'node:test';
import assert from 'node:assert';
import { parseIcs } from './import-ics.js';

const ics = (body) => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' + body + 'END:VCALENDAR\r\n';
const vevent = (lines) => 'BEGIN:VEVENT\r\n' + lines.join('\r\n') + '\r\nEND:VEVENT\r\n';

test('an all-day event keeps its day and has no time', () => {
  const out = parseIcs(ics(vevent(['SUMMARY:Bin day', 'DTSTART;VALUE=DATE:20260915', 'DTEND;VALUE=DATE:20260916'])));
  assert.deepStrictEqual(out.events[0], {
    title: 'Bin day', notes: '', day: '2026-09-15', time: null, minutes: null,
    repeat: null, repeatUntil: null, exdates: [],
  });
});

test('a timed event becomes a day, a time, and a length in minutes', () => {
  const out = parseIcs(ics(vevent(['SUMMARY:Soccer', 'DTSTART;TZID=America/Denver:20260915T090000', 'DTEND;TZID=America/Denver:20260915T093000'])));
  assert.strictEqual(out.events[0].day, '2026-09-15');
  assert.strictEqual(out.events[0].time, '09:00');
  assert.strictEqual(out.events[0].minutes, 30);
});

test('the four supported RRULEs map across', () => {
  const rule = (r) => parseIcs(ics(vevent(['SUMMARY:x', 'DTSTART;VALUE=DATE:20260915', r]))).events[0].repeat;
  assert.deepStrictEqual(rule('RRULE:FREQ=DAILY'), { freq: 'daily' });
  assert.deepStrictEqual(rule('RRULE:FREQ=WEEKLY;BYDAY=TU,TH'), { freq: 'weekly', days: [2, 4] });
  assert.deepStrictEqual(rule('RRULE:FREQ=MONTHLY'), { freq: 'monthly', day: 15 });
  assert.deepStrictEqual(rule('RRULE:FREQ=YEARLY'), { freq: 'yearly' });
});

test('UNTIL becomes repeatUntil as a plain day', () => {
  const out = parseIcs(ics(vevent(['SUMMARY:x', 'DTSTART;VALUE=DATE:20260915', 'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T235959Z'])));
  assert.strictEqual(out.events[0].repeatUntil, '2026-12-31');
});

test('a weekly rule with no BYDAY takes the start weekday', () => {
  const out = parseIcs(ics(vevent(['SUMMARY:x', 'DTSTART;VALUE=DATE:20260915', 'RRULE:FREQ=WEEKLY'])));
  assert.deepStrictEqual(out.events[0].repeat, { freq: 'weekly', days: [2] });
});

test('rules we cannot express are skipped by name rather than approximated', () => {
  const out = parseIcs(ics(
    vevent(['SUMMARY:Third Thursday', 'DTSTART;VALUE=DATE:20260917', 'RRULE:FREQ=MONTHLY;BYDAY=3TH']) +
    vevent(['SUMMARY:Ten times', 'DTSTART;VALUE=DATE:20260915', 'RRULE:FREQ=WEEKLY;COUNT=10']) +
    vevent(['SUMMARY:Fortnightly', 'DTSTART;VALUE=DATE:20260915', 'RRULE:FREQ=WEEKLY;INTERVAL=2'])));
  assert.strictEqual(out.events.length, 0);
  assert.deepStrictEqual(out.skipped.map((s) => s.title), ['Third Thursday', 'Ten times', 'Fortnightly']);
  assert.match(out.skipped[0].why, /BYDAY/);
});

test('EXDATE becomes skipped occurrences', () => {
  const out = parseIcs(ics(vevent(['SUMMARY:x', 'DTSTART;VALUE=DATE:20260915', 'RRULE:FREQ=WEEKLY;BYDAY=TU',
    'EXDATE;VALUE=DATE:20260922,20260929'])));
  assert.deepStrictEqual(out.events[0].exdates, ['2026-09-22', '2026-09-29']);
});

test('folded lines and escaped text are unwrapped', () => {
  const out = parseIcs(ics('BEGIN:VEVENT\r\nSUMMARY:A very long tit\r\n le\r\nDESCRIPTION:one\\ntwo\\, three\r\nDTSTART;VALUE=DATE:20260915\r\nEND:VEVENT\r\n'));
  assert.strictEqual(out.events[0].title, 'A very long title');
  assert.strictEqual(out.events[0].notes, 'one\ntwo, three');
});

test('an event with no start is skipped, not guessed at', () => {
  const out = parseIcs(ics(vevent(['SUMMARY:Nowhere'])));
  assert.strictEqual(out.events.length, 0);
  assert.match(out.skipped[0].why, /no start/);
});

// `events` has one day per row; a multi-day all-day DTEND (exclusive, so a
// 3-day trip is DTSTART + 3) has nowhere to go and must not be truncated to
// its first day without saying so.
test('a multi-day all-day event is skipped, not truncated to its first day', () => {
  const out = parseIcs(ics(vevent(['SUMMARY:Grand Canyon trip', 'DTSTART;VALUE=DATE:20260915', 'DTEND;VALUE=DATE:20260918'])));
  assert.strictEqual(out.events.length, 0);
  assert.match(out.skipped[0].why, /multiple days/);
});

// A YEARLY rule anchored on BYMONTH+BYDAY (the shape every US holiday
// calendar uses for Thanksgiving) must not flatten to DTSTART's literal
// month and day — that silently drops both qualifiers.
test('a yearly rule with BYMONTH and BYDAY is skipped, not flattened', () => {
  const out = parseIcs(ics(vevent(['SUMMARY:Thanksgiving', 'DTSTART;VALUE=DATE:20261126', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH'])));
  assert.strictEqual(out.events.length, 0);
  assert.match(out.skipped[0].why, /BYMONTH/);
});

// A DAILY rule with BYDAY ("every weekday") must not become true daily,
// which would silently add the weekends back in.
test('a daily rule with BYDAY is skipped, not treated as every day', () => {
  const out = parseIcs(ics(vevent(['SUMMARY:Weekdays', 'DTSTART;VALUE=DATE:20260915', 'RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR'])));
  assert.strictEqual(out.events.length, 0);
  assert.match(out.skipped[0].why, /BYDAY/);
});

// A timed value outside Denver needs real timezone conversion to import at
// the right wall-clock time; the script never converts, so it must refuse
// rather than import two hours wrong.
test('a timed event in another time zone is refused, not shifted', () => {
  const out = parseIcs(ics(vevent(['SUMMARY:Flight', 'DTSTART;TZID=America/New_York:20260915T090000', 'DTEND;TZID=America/New_York:20260915T110000'])));
  assert.strictEqual(out.events.length, 0);
  assert.match(out.skipped[0].why, /America\/New_York/);
});

test('a UTC (Z) timed event is refused, not treated as Denver wall-clock', () => {
  const out = parseIcs(ics(vevent(['SUMMARY:Webinar', 'DTSTART:20260915T160000Z', 'DTEND:20260915T170000Z'])));
  assert.strictEqual(out.events.length, 0);
  assert.match(out.skipped[0].why, /UTC/);
});

test('an edited instance of a series is reported, not imported alongside its parent', () => {
  const parent = vevent(['UID:abc@google.com', 'SUMMARY:Soccer', 'DTSTART;VALUE=DATE:20260915', 'RRULE:FREQ=WEEKLY;BYDAY=TU']);
  const moved = vevent(['UID:abc@google.com', 'SUMMARY:Soccer', 'RECURRENCE-ID;VALUE=DATE:20260922',
    'DTSTART;VALUE=DATE:20260924']);
  const out = parseIcs(ics(parent + moved));
  assert.strictEqual(out.events.length, 1, 'only the series itself imports');
  assert.strictEqual(out.events[0].day, '2026-09-15');
  assert.strictEqual(out.skipped.length, 1);
  assert.strictEqual(out.skipped[0].day, '2026-09-24');
  assert.match(out.skipped[0].why, /changed occurrence/);
});
