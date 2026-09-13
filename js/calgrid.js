// Date shapes the calendar screen needs, kept pure so they can be tested
// without a DOM. Everything in and out is a 'YYYY-MM-DD' string.
import { addDays, weekday } from '../supabase/functions/_shared/recur.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function shiftMonth(ym, n) {
  const y = +ym.slice(0, 4);
  const m = +ym.slice(5, 7) - 1 + n;
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12 + 1;
  return year + '-' + (month < 10 ? '0' : '') + month;
}

// Always six weeks, so the grid does not change height from month to month and
// the day cells stay where the thumb last found them.
export function monthMatrix(ym) {
  const first = ym + '-01';
  const back = weekday(first) % 7; // Sunday-first: Sunday 7 -> 0
  const start = addDays(first, -back);
  const grid = [];
  for (let w = 0; w < 6; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) week.push(addDays(start, w * 7 + d));
    grid.push(week);
  }
  return grid;
}

export function monthBounds(ym) {
  const grid = monthMatrix(ym);
  return { from: grid[0][0], to: grid[5][6] };
}

export const monthTitle = (ym) => MONTHS[+ym.slice(5, 7) - 1] + ' ' + ym.slice(0, 4);

export function groupByDay(occurrences) {
  const byDay = new Map();
  for (const o of occurrences) {
    if (!byDay.has(o.day)) byDay.set(o.day, []);
    byDay.get(o.day).push(o);
  }
  // Occurrences arrive sorted in practice; grouping should not depend on it.
  return Array.from(byDay.entries())
    .sort(([dayA], [dayB]) => dayA < dayB ? -1 : dayA > dayB ? 1 : 0)
    .map(([day, items]) => ({ day, items }));
}

export function dayLabel(day, today) {
  if (day === today) return 'Today';
  if (day === addDays(today, 1)) return 'Tomorrow';
  const name = WEEKDAYS[weekday(day) - 1];
  const dom = +day.slice(8, 10);
  const month = MONTHS[+day.slice(5, 7) - 1];
  // The year only earns its place once it differs from the one we are in.
  const year = day.slice(0, 4) === today.slice(0, 4) ? '' : ' ' + day.slice(0, 4);
  return name + ' ' + dom + ' ' + month + year;
}
