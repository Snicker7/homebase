import test from 'node:test';
import assert from 'node:assert';
import { monthMatrix, monthBounds, groupByDay, dayLabel, timeLabel, shiftMonth } from './calgrid.js';

test('a month grid is six Sunday-first weeks that contain the month', () => {
  const grid = monthMatrix('2026-09');
  assert.strictEqual(grid.length, 6);
  assert.ok(grid.every((w) => w.length === 7));
  // 1 September 2026 is a Tuesday, so the grid opens on Sunday 30 August.
  assert.strictEqual(grid[0][0], '2026-08-30');
  assert.strictEqual(grid[0][2], '2026-09-01');
  assert.strictEqual(grid[5][6], '2026-10-10');
});

test('a month that starts on a Sunday still gets a leading week, never a gap', () => {
  const grid = monthMatrix('2026-11'); // 1 November 2026 is a Sunday
  assert.strictEqual(grid[0][0], '2026-11-01');
  assert.strictEqual(grid.length, 6);
});

test('monthBounds covers the whole grid, not just the month', () => {
  assert.deepStrictEqual(monthBounds('2026-09'), { from: '2026-08-30', to: '2026-10-10' });
});

test('shiftMonth walks across year ends', () => {
  assert.strictEqual(shiftMonth('2026-09', 1), '2026-10');
  assert.strictEqual(shiftMonth('2026-12', 1), '2027-01');
  assert.strictEqual(shiftMonth('2026-01', -1), '2025-12');
});

test('groupByDay keeps order and drops empty days', () => {
  const out = groupByDay([
    { day: '2026-09-15', title: 'a' }, { day: '2026-09-17', title: 'b' }, { day: '2026-09-15', title: 'c' },
  ]);
  assert.deepStrictEqual(out.map((g) => [g.day, g.items.length]), [['2026-09-15', 2], ['2026-09-17', 1]]);
});

test('dayLabel names today and tomorrow, then falls back to the date', () => {
  assert.strictEqual(dayLabel('2026-09-15', '2026-09-15'), 'Today');
  assert.strictEqual(dayLabel('2026-09-16', '2026-09-15'), 'Tomorrow');
  assert.strictEqual(dayLabel('2026-09-17', '2026-09-15'), 'Thursday 17 September');
  assert.strictEqual(dayLabel('2027-01-02', '2026-09-15'), 'Saturday 2 January 2027');
});

test('timeLabel reads a range and collapses a shared meridiem', () => {
  assert.strictEqual(timeLabel(null, null), 'All day');
  assert.strictEqual(timeLabel('09:00', 30), '9:00 – 9:30 AM');
  assert.strictEqual(timeLabel('11:30', 60), '11:30 AM – 12:30 PM');
  assert.strictEqual(timeLabel('00:00', 15), '12:00 – 12:15 AM');
  assert.strictEqual(timeLabel('23:30', 60), '11:30 PM – 12:30 AM');
});
