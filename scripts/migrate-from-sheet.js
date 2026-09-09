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

// ISO-ish "2026-06-20 21:05:11" (or with a "T" separator) and Sheets'
// mangled "6/20/2026 21:05:11" — the same M/D/YYYY re-render `fixPeriodKey`
// handles, but on a timestamp cell instead of a period-key cell.
const ISO_STAMP_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/;
const US_STAMP_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/;

function parseStamp(v) {
  const s = String(v || '').trim();
  let y, mo, d, h, mi, se;
  let m = ISO_STAMP_RE.exec(s);
  if (m) { [y, mo, d, h, mi, se] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)]; }
  else {
    m = US_STAMP_RE.exec(s);
    if (m) { [mo, d, y, h, mi, se] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)]; }
  }
  if (!m) throw new Error('unrecognised timestamp: ' + v);

  // Build the UTC instant for that Denver wall-clock time. A single offset
  // sample is wrong for wall-clock times on the day Denver's own DST
  // transition falls, because the offset that applies AT the guessed UTC
  // instant can differ from the offset that applies at the actual target
  // instant; resample at the corrected instant to settle on the right one.
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  const off1 = tzOffsetMs(guess, 'America/Denver');
  const off2 = tzOffsetMs(new Date(guess.getTime() - off1), 'America/Denver');
  return new Date(guess.getTime() - off2);
}

// Sheets exports a currency-formatted cell as "$1.50" or "1,234.50", and
// `Number(x) || 0` turns any of those — and any typo — into a silent 0 that
// only shows up as a wrong wallet. Strip the formatting, refuse the rest.
function money(cell, field, lineNo) {
  const s = String(cell == null ? '' : cell).trim().replace(/[$,]/g, '');
  if (s === '') return field === 'balanceAfter' ? '' : 0;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error('bad ' + field + ' on line ' + lineNo + ': ' + cell);
  return n;
}

export function parseLedgerCsv(text) {
  const [header, ...lines] = parseCsv(text);
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  // The production sheet predates the rename from nightDate to periodKey.
  if (!('periodKey' in idx) && 'nightDate' in idx) idx.periodKey = idx.nightDate;
  for (const k of ['id', 'timestamp', 'type', 'category', 'periodKey', 'result', 'freezeUsed', 'amount', 'balanceAfter', 'actor', 'note']) {
    if (!(k in idx)) throw new Error('ledger.csv missing column ' + k);
  }
  return lines.map((r, i) => ({
    // +2: the header is line 1 and `lines` starts at line 2.
    id: r[idx.id].trim(),
    timestamp: parseStamp(r[idx.timestamp]),
    type: r[idx.type].trim(),
    category: (r[idx.category] || '').trim(),
    periodKey: fixPeriodKey((r[idx.periodKey] || '').trim()),
    result: (r[idx.result] || '').trim(),
    freezeUsed: /^true$/i.test((r[idx.freezeUsed] || '').trim()),
    amount: money(r[idx.amount], 'amount', i + 2),
    balanceAfter: money(r[idx.balanceAfter], 'balanceAfter', i + 2),
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
  // `loadSnapshot` reads the ledger back ordered by (ts, id), which is not
  // necessarily the CSV's order. Compare the wallet each order derives before
  // touching the database, so an import that would settle differently the
  // moment it is read back never happens.
  const sorted = [...rows].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const orderDiffs = [];
  for (const a of actors) {
    const csvWallet = E.deriveWallet(rows, a).toFixed(2);
    const readWallet = E.deriveWallet(sorted, a).toFixed(2);
    console.log(`wallet ${a}: csv order ${csvWallet}, read-back order ${readWallet}`);
    if (csvWallet !== readWallet) orderDiffs.push(`${a}: csv ${csvWallet} vs read-back ${readWallet}`);
  }
  if (orderDiffs.length) {
    console.error('row order changes the wallet: ' + orderDiffs.join('; '));
    console.error('The ledger stores no sequence column, so rows sharing a timestamp come back in (ts, id) order, not CSV order.');
    console.error('Fix the source rows — give the same-second rows distinct timestamps — and re-export before importing.');
    process.exit(1);
  }

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
    const mismatches = [];
    for (const a of actors) {
      const csvWallet = E.deriveWallet(rows, a);
      const dbWallet = E.deriveWallet(store.readLedgerRows(), a);
      console.log(`db wallet ${a}: ${dbWallet.toFixed(2)}`);
      if (dbWallet.toFixed(2) !== csvWallet.toFixed(2)) {
        mismatches.push(`${a}: csv ${csvWallet.toFixed(2)} vs db ${dbWallet.toFixed(2)}`);
      }
    }
    if (mismatches.length) {
      // The transaction already committed — printing and re-running won't
      // fix it. The caller has to wipe (local) or restore (production)
      // before trying again.
      console.error('wallet mismatch after apply — data already committed; run `npx supabase db reset` (local) or restore from backup (production) before retrying');
      throw new Error('wallet mismatch after apply: ' + mismatches.join('; '));
    }
    console.log('applied');
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('migrate-from-sheet.js')) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
