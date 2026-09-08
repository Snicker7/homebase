import test from 'node:test';
import assert from 'node:assert';
import { tzDate, tzHour, tzHourStr, tzMonthStart, tzStamp } from './clock.js';

// 2026-03-08 09:30Z is 02:30 MST on Mar 8 (DST starts at 2am local that day,
// so 09:30Z is 03:30 MDT). Either way the local date is Mar 8.
const springForward = new Date('2026-03-08T09:30:00Z');
// 2026-07-01 05:30Z is 23:30 MDT on Jun 30.
const lateEvening = new Date('2026-07-01T05:30:00Z');

test('tzDate uses Denver local date', () => {
  assert.strictEqual(tzDate(lateEvening), '2026-06-30');
  assert.strictEqual(tzDate(springForward), '2026-03-08');
});

test('tzHour and tzHourStr', () => {
  assert.strictEqual(tzHour(lateEvening), 23);
  assert.strictEqual(tzHourStr(lateEvening), '23:00');
  assert.strictEqual(tzHourStr(new Date('2026-07-01T15:05:00Z')), '09:00');
});

test('tzMonthStart', () => {
  assert.strictEqual(tzMonthStart(lateEvening), '2026-06-01');
});

test('tzStamp', () => {
  assert.strictEqual(tzStamp(lateEvening), '2026-06-30 23:30');
});
