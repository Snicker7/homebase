import { TZ } from './config.js';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

// { year, month, day, hour, minute } as strings, in TZ.
function parts(d) {
  const out = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  // Some engines print midnight as "24"; normalize.
  if (out.hour === '24') out.hour = '00';
  return out;
}

export function tzDate(d) {
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day}`;
}
export function tzHour(d) {
  return parseInt(parts(d).hour, 10);
}
export function tzHourStr(d) {
  return parts(d).hour + ':00';
}
export function tzMonthStart(d) {
  const p = parts(d);
  return `${p.year}-${p.month}-01`;
}
export function tzStamp(d) {
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
