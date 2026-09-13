#!/usr/bin/env node
// One-off import of Google Calendar exports. Dry run by default; --apply writes.
//
//   node scripts/import-ics.js --file family.ics --category family --db "$PROD_DB_URL"
//   node scripts/import-ics.js --file family.ics --category family --db "$PROD_DB_URL" --apply
//
// Only the four repeat rules the calendar supports are imported. Anything else
// is listed at the end and re-entered by hand: a rule half-mapped is worse than
// a rule the report told you about.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { weekday } from '../supabase/functions/_shared/recur.js';

const DAYS = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

// RFC 5545 folds long lines with CRLF plus one space or tab.
const unfold = (text) => text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
const unescape = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const ymd = (v) => v.slice(0, 4) + '-' + v.slice(4, 6) + '-' + v.slice(6, 8);
const hm = (v) => (v.length >= 15 ? v.slice(9, 11) + ':' + v.slice(11, 13) : null);

const minutesBetween = (a, b) => {
  const at = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10), +a.slice(11, 13) || 0, +a.slice(14, 16) || 0);
  const bt = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10), +b.slice(11, 13) || 0, +b.slice(14, 16) || 0);
  return Math.round((bt - at) / 60000);
};

// Whole-day count between two 'YYYY-MM-DD' days, for the all-day DTEND (which
// RFC 5545 makes exclusive) — never routed through minutesBetween, which
// assumes a time-of-day component that all-day values don't have.
const daysBetween = (a, b) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))
  - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);

function parseRule(value, day) {
  const parts = Object.fromEntries(value.split(';').map((p) => p.split('=')));
  if (parts.INTERVAL && parts.INTERVAL !== '1') return { why: 'INTERVAL is not supported' };
  if (parts.COUNT) return { why: 'COUNT is not supported; use an end date' };
  if (parts.BYSETPOS) return { why: 'BYSETPOS is not supported' };
  if (parts.BYMONTHDAY && Number(parts.BYMONTHDAY) !== +day.slice(8, 10)) return { why: 'BYMONTHDAY differs from the start day' };
  const until = parts.UNTIL ? ymd(parts.UNTIL) : null;

  if (parts.FREQ === 'DAILY') return { repeat: { freq: 'daily' }, until };
  if (parts.FREQ === 'YEARLY') return { repeat: { freq: 'yearly' }, until };
  if (parts.FREQ === 'WEEKLY') {
    const byday = parts.BYDAY ? parts.BYDAY.split(',') : [];
    if (byday.some((d) => !DAYS[d])) return { why: 'BYDAY with an ordinal is not supported' };
    const days = byday.length ? byday.map((d) => DAYS[d]).sort((a, b) => a - b) : [weekday(day)];
    if (!days.includes(weekday(day))) return { why: 'BYDAY does not include the start weekday' };
    return { repeat: { freq: 'weekly', days }, until };
  }
  if (parts.FREQ === 'MONTHLY') {
    if (parts.BYDAY) return { why: 'BYDAY with an ordinal is not supported' };
    return { repeat: { freq: 'monthly', day: +day.slice(8, 10) }, until };
  }
  return { why: 'FREQ ' + parts.FREQ + ' is not supported' };
}

export function parseIcs(text) {
  const events = [];
  const skipped = [];
  const blocks = unfold(text).split(/BEGIN:VEVENT/).slice(1);
  for (const block of blocks) {
    const body = block.split('END:VEVENT')[0];
    const lines = body.split(/\r?\n/).filter(Boolean);
    const get = (name) => lines.find((l) => l.split(/[;:]/)[0] === name) || '';
    const value = (line) => line.slice(line.indexOf(':') + 1).trim();

    const title = unescape(value(get('SUMMARY'))) || '(untitled)';
    const start = get('DTSTART');
    if (!start) { skipped.push({ title, day: '', why: 'no start date' }); continue; }
    const rawStart = value(start);
    const day = ymd(rawStart);
    const time = /VALUE=DATE(?!-TIME)/.test(start) ? null : hm(rawStart);

    let minutes = null;
    if (time) {
      const end = get('DTEND');
      minutes = end ? minutesBetween(day + 'T' + time, ymd(value(end)) + 'T' + (hm(value(end)) || '00:00')) : 60;
      if (!(minutes > 0 && minutes <= 1440)) { skipped.push({ title, day, why: 'length is ' + minutes + ' minutes' }); continue; }
    } else {
      // DTEND on an all-day event is the exclusive next day, so a single-day
      // event has DTEND == DTSTART + 1 and there is nothing to record. A span
      // of more than one day has no field to hold it — `events` is one day
      // per row — so recording just the first day would silently amputate a
      // multi-day trip down to its first morning. Report it instead.
      const end = get('DTEND');
      if (end && daysBetween(day, ymd(value(end))) > 1) {
        skipped.push({ title, day, why: 'spans multiple days; the calendar has no multi-day event, re-enter by hand' });
        continue;
      }
    }

    let repeat = null;
    let repeatUntil = null;
    const rrule = get('RRULE');
    if (rrule) {
      const r = parseRule(value(rrule), day);
      if (r.why) { skipped.push({ title, day, why: r.why }); continue; }
      repeat = r.repeat;
      repeatUntil = r.until;
    }

    const exdates = lines.filter((l) => l.split(/[;:]/)[0] === 'EXDATE')
      .flatMap((l) => value(l).split(',').map((v) => ymd(v.trim())));

    events.push({ title, notes: unescape(value(get('DESCRIPTION'))), day, time, minutes, repeat, repeatUntil, exdates });
  }
  return { events, skipped };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf('--' + name); return i === -1 ? null : args[i + 1]; };
  const file = arg('file');
  const category = arg('category');
  const db = arg('db');
  const apply = args.includes('--apply');
  const owner = arg('owner') || 'snic9004@gmail.com';
  if (!file || !category || !db) {
    console.error('usage: import-ics.js --file X.ics --category <id> --db <url> [--owner <email>] [--apply]');
    process.exit(2);
  }

  const { events, skipped } = parseIcs(readFileSync(file, 'utf8'));
  const sql = postgres(db, { max: 1, prepare: false });
  try {
    const [cat] = await sql`select id from event_categories where id = ${category}`;
    if (!cat) throw new Error('no such category: ' + category);
    if (apply) {
      for (const e of events) {
        const [row] = await sql`
          insert into events (title, notes, category_id, day, time, minutes, repeat, repeat_until, created_by)
          values (${e.title}, ${e.notes}, ${category}, ${e.day}, ${e.time}, ${e.minutes},
                  ${e.repeat ? sql.json(e.repeat) : null}, ${e.repeatUntil}, ${owner})
          returning id`;
        for (const day of e.exdates) {
          await sql`insert into event_exceptions (event_id, day, skipped) values (${row.id}, ${day}, true)
                    on conflict do nothing`;
        }
      }
    }
    console.log((apply ? 'imported ' : 'would import ') + events.length + ' events into ' + category);
    if (skipped.length) {
      console.log('\nleft out, re-enter these by hand:');
      for (const s of skipped) console.log('  ' + s.day + '  ' + s.title + ' — ' + s.why);
    }
    console.log('\n' + skipped.length + ' skipped');
  } finally {
    await sql.end();
  }
}

// Only run when invoked directly, so the tests can import parseIcs.
if (process.argv[1] && process.argv[1].endsWith('import-ics.js')) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
