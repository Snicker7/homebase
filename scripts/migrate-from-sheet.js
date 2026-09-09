// scripts/migrate-from-sheet.js
// One-off import of the Apps Script ledger + properties into Postgres.
// Usage:
//   node scripts/migrate-from-sheet.js --ledger scripts/data/ledger.csv \
//        --props scripts/data/props.json --db "$DB_URL" [--apply]
import fs from 'node:fs';
import postgres from 'postgres';
import * as E from '../supabase/functions/_shared/engine.js';
import { createStore } from '../supabase/functions/_shared/store.js';
import { loadSnapshot, applyJournal } from '../supabase/functions/_shared/pg.js';

// Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

// Sheets re-renders a "YYYY-MM-DD" text cell as "M/D/YYYY" on export when it
// decided the cell was a date. Weekly ("2026-W33") and monthly ("2026-06")
// keys survive untouched.
function fixPeriodKey(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v || '');
  if (!m) return v || '';
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

// Offset (ms) such that `asUTC(fields shown in timeZone at `date`) - date == offset`.
// Uses Intl with an explicit target zone, so it is independent of the host's
// own default timezone (unlike the toLocaleString-round-trip trick, which
// only works when the host's default zone differs from the target zone).
function tzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== 'literal') parts[p.type] = p.value;
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUTC - date.getTime();
}

function parseStamp(v) {
  // "2026-06-20 21:05:11" is Denver local time in the Sheet; treat as such.
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?/.exec(v || '');
  if (m) {
    // Build the UTC instant for that Denver wall-clock time.
    const guess = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
    const offset = tzOffsetMs(guess, 'America/Denver');
    return new Date(guess.getTime() - offset);
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

export function parseLedgerCsv(text) {
  const [header, ...lines] = parseCsv(text);
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  for (const k of ['id', 'timestamp', 'type', 'category', 'periodKey', 'result', 'freezeUsed', 'amount', 'balanceAfter', 'actor', 'note']) {
    if (!(k in idx)) throw new Error('ledger.csv missing column ' + k);
  }
  return lines.map((r) => ({
    id: r[idx.id].trim(),
    timestamp: parseStamp(r[idx.timestamp]),
    type: r[idx.type].trim(),
    category: (r[idx.category] || '').trim(),
    periodKey: fixPeriodKey((r[idx.periodKey] || '').trim()),
    result: (r[idx.result] || '').trim(),
    freezeUsed: /^true$/i.test((r[idx.freezeUsed] || '').trim()),
    amount: Number(r[idx.amount]) || 0,
    balanceAfter: r[idx.balanceAfter] === '' ? '' : Number(r[idx.balanceAfter]) || 0,
    actor: (r[idx.actor] || '').trim().toLowerCase(),
    note: r[idx.note] || '',
  }));
}

export function buildJournal(rows, props) {
  const j = [];
  j.push({ op: 'categories', list: (props.categories || []).map((c) => E.normalizeCategory(c)) });
  for (const r of rows) j.push({ op: 'append', row: { ...r } });
  for (const actor of Object.keys(props.states || {})) {
    const cats = (props.states[actor] && props.states[actor].cats) || {};
    for (const category of Object.keys(cats)) j.push({ op: 'habitState', actor: actor.toLowerCase(), category, state: cats[category] });
  }
  for (const category of Object.keys(props.choreStates || {})) j.push({ op: 'choreState', category, state: props.choreStates[category] });
  if (props.chorePauseUntil) j.push({ op: 'setting', key: 'chorePauseUntil', value: props.chorePauseUntil });
  return j;
}

async function main() {
  const arg = (k) => { const i = process.argv.indexOf(k); return i === -1 ? undefined : process.argv[i + 1]; };
  const ledgerPath = arg('--ledger'), propsPath = arg('--props'), db = arg('--db');
  const apply = process.argv.includes('--apply');
  if (!ledgerPath || !propsPath || !db) throw new Error('need --ledger, --props, --db');
  const rows = parseLedgerCsv(fs.readFileSync(ledgerPath, 'utf8'));
  const props = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
  const journal = buildJournal(rows, props);

  const actors = [...new Set(rows.map((r) => r.actor))];
  console.log(`ledger rows: ${rows.length}, categories: ${journal[0].list.length}, states: ${journal.filter((e) => e.op === 'habitState').length}, chore states: ${journal.filter((e) => e.op === 'choreState').length}`);
  for (const a of actors) console.log(`wallet ${a}: ${E.deriveWallet(rows, a).toFixed(2)}`);

  const sql = postgres(db);
  try {
    const snap = await loadSnapshot(sql);
    const known = new Set(snap.people.map((p) => p.email));
    const unknown = actors.filter((a) => !known.has(a));
    if (unknown.length) throw new Error('actors not in people: ' + unknown.join(', ') + ' — insert them first');
    if (snap.ledger.length) throw new Error(`ledger already has ${snap.ledger.length} rows — refusing to import twice`);
    if (!apply) { console.log('dry run; pass --apply to write'); return; }
    await sql.begin(async (tx) => { await applyJournal(tx, journal); });
    const after = await loadSnapshot(sql);
    const store = createStore(after);
    for (const a of actors) console.log(`db wallet ${a}: ${E.deriveWallet(store.readLedgerRows(), a).toFixed(2)}`);
    console.log('applied');
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('migrate-from-sheet.js')) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
