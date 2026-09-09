# Homebase Phase 1: Habits Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the habits app off Google Apps Script onto Supabase with identical behavior, serving from `homebase.samnichols.dev`, with history migrated and the Apps Script trigger turned off.

**Architecture:** The reward engine moves over unchanged. The Apps Script glue (`main.gs`) is ported almost line for line into `service.js`, which runs synchronously against an in-memory snapshot of the tables and records a write journal. Three thin Deno edge functions (`api`, `checkup`, `dispatch`) each open a transaction, take an advisory lock, load the snapshot, run one service action, and apply the journal. The frontend keeps its rendering code and swaps JSONP for Supabase auth plus `fetch`.

**Tech Stack:** Supabase (Postgres 17, Auth, Edge Functions on Deno, pg_cron, pg_net), postgres.js, Resend, vanilla JS on GitHub Pages, Node 20+ test runner, pgTAP via `supabase test db`.

**Spec:** `docs/superpowers/specs/2026-09-08-homebase-design.md`

**Source being ported:** `/mnt/c/Users/Snic9/samsite/habits/` (read-only reference). Line numbers below refer to `backend/main.gs` and `js/app.js` in that folder as of commit `a73255c`.

## Global Constraints

- Time zone is `America/Denver` everywhere the Apps Script used `TZ`. Weekly rollover hour is 17.
- Actor identity is the lowercase email, exactly as the Sheet stores it. No UUIDs for people.
- Response shapes returned by service actions match the Apps Script responses field for field. The frontend's `render()` must not need edits.
- Every ledger amount is rounded with the engine's `round2`. Never store or return unrounded money.
- Shared code under `supabase/functions/_shared/` must run under both Node 20 and Deno: ES modules only, no Node-only or Deno-only globals outside `pg.js`, `mail.js`, and the function entrypoints. Time comes from `ctx.now()`, never `new Date()` inside `service.js`.
- Tests run with `npm test` from the repo root and must pass before a task is called done.
- **The user commits.** No task runs `git commit` or `git push`. Each task ends by reporting `git status --short` and a suggested commit subject.
- Secrets never enter the repo: no API keys, no signing secret, no database URL. `js/config.js` holds only the Supabase project URL and anon key, which are public by design.

---

## File map

| Path | Responsibility |
| --- | --- |
| `package.json` | `"type": "module"`, test script, `postgres` dev dependency |
| `supabase/functions/deno.json` | Import map so `import postgres from 'postgres'` resolves in Deno |
| `supabase/functions/_shared/engine.js` | Reward rules. Copied from source; only the export block changes. |
| `supabase/functions/_shared/engine.test.js` | Copied from source; `require` becomes `import`. |
| `supabase/functions/_shared/config.js` | `TZ`, `WEEKLY_ROLLOVER_HOUR`, `CHECKUP_TTL_MS` |
| `supabase/functions/_shared/clock.js` | Time zone formatting: `tzDate`, `tzHour`, `tzMonthStart`, `tzStamp` |
| `supabase/functions/_shared/token.js` | Signed check-up tokens: `signToken`, `verifyToken` |
| `supabase/functions/_shared/store.js` | `createStore(snapshot)`: synchronous reads, journaled writes |
| `supabase/functions/_shared/service.js` | Ported `main.gs`: `createService(ctx)` returning `route(p)`, `dispatch()`, `checkup(token)` |
| `supabase/functions/_shared/mail.js` | `createResendMailer(apiKey, from, replyTo)` |
| `supabase/functions/_shared/pg.js` | `runAction(sql, fn)`: lock, load snapshot, run, apply journal |
| `supabase/functions/_shared/cors.js` | CORS headers for the two allowed origins |
| `supabase/functions/api/index.ts` | JWT check, `route(p)` |
| `supabase/functions/checkup/index.ts` | Token check, `checkup(token)` |
| `supabase/functions/dispatch/index.ts` | Cron entry, `dispatch()` |
| `supabase/migrations/0001_habits.sql` | Tables, indexes, RLS, allowlist trigger |
| `supabase/seed.sql` | Two people, holidays |
| `supabase/tests/0001_habits.sql` | pgTAP: tables, trigger |
| `supabase/cron.sql` | Template run by hand in the dashboard: hourly `dispatch` |
| `scripts/migrate-from-sheet.js` | One-off import from `ledger.csv` and `props.json` |
| `scripts/dump-props.gs` | Snippet pasted into Apps Script to export properties |
| `index.html`, `css/style.css`, `js/app.js` | Copied from source, then edited |
| `js/api.js` | Supabase client, `api()`, `checkup()`, auth helpers |
| `js/config.js` | `SUPABASE_URL`, `SUPABASE_ANON_KEY` |
| `CNAME` | `homebase.samnichols.dev` |
| `README.md` | Setup and runbook |

---

### Task 1: Repo scaffold and engine under Node's test runner

**Files:**
- Create: `package.json`, `.gitignore`, `README.md`, `CNAME`
- Create: `supabase/functions/_shared/engine.js` (copy), `supabase/functions/_shared/engine.test.js` (copy)
- Copy: `index.html`, `css/style.css`, `js/app.js`, `js/config.js` from `/mnt/c/Users/Snic9/samsite/habits/`

**Interfaces:**
- Produces: `engine.js` as an ES module exporting every name the source's `module.exports` block lists (`payout`, `isoWeek`, `periodKeyFor`, `shiftDays`, `mondayOf`, `isoDow`, `periodKeyDate`, `freezePeriodStart`, `validPeriodKey`, `claimablePeriodKey`, `choreKeyFitsCadence`, `repairChoreState`, `isChoreClaimed`, `chorePotFor`, `outstandingChorePeriods`, `nextChorePeriodKey`, `choreDueDateFor`, `chorePeriodClosed`, `latestClosedPeriod`, `resumeSweepFrom`, `choreDrainCount`, `choreGroup`, `chorePenaltyAmounts`, `chorePayout`, `isTrueFlag`, `lastClosedPeriodKey`, `shouldSendReminder`, `shouldSendCheckup`, `initialCatState`, `refreshAction`, `applyRebase`, `applyRestart`, `escapeHtml`, `freezesLeft`, `migrateCatState`, `applyEntry`, `applyRefresh`, `applySpend`, `applyDeposit`, `deriveWallet`, `isPeriodRecorded`, `replayCategory`, `inReplayWindow`, `replayFrom`, `periodHasEntries`, `runningBalanceRows`, `normalizeCategory`, `validateCategory`, `round2`, `CHORE_ACCRUAL_CAP`).

- [ ] **Step 1: Copy files**

```bash
cd /mnt/c/Users/Snic9/homebase
SRC=/mnt/c/Users/Snic9/samsite/habits
mkdir -p supabase/functions/_shared js css scripts
cp "$SRC/backend/engine.js" "$SRC/backend/engine.test.js" supabase/functions/_shared/
cp "$SRC/index.html" .
cp "$SRC/css/style.css" css/
cp "$SRC/js/app.js" js/
echo homebase.samnichols.dev > CNAME
```

- [ ] **Step 2: Write package.json and .gitignore**

`package.json`:

```json
{
  "name": "homebase",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test supabase/functions/_shared/ scripts/"
  },
  "devDependencies": {
    "postgres": "^3.4.5"
  }
}
```

`.gitignore`:

```
node_modules/
.env
.env.*
supabase/.temp/
supabase/.branches/
scripts/data/
```

Run `npm install`.

- [ ] **Step 3: Convert the engine's export block to ESM**

At the bottom of `supabase/functions/_shared/engine.js` the source has:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    round2: round2,
    ...
    validateCategory: validateCategory,
  };
}
```

Delete that whole `if` block and replace it with one `export` statement listing the same names plus `CHORE_ACCRUAL_CAP`:

```js
export {
  round2, payout, isoWeek, periodKeyFor, shiftDays, mondayOf, isoDow,
  periodKeyDate, freezePeriodStart, validPeriodKey, claimablePeriodKey,
  choreKeyFitsCadence, repairChoreState, isChoreClaimed, chorePotFor,
  outstandingChorePeriods, nextChorePeriodKey, choreDueDateFor,
  chorePeriodClosed, latestClosedPeriod, resumeSweepFrom, choreDrainCount,
  choreGroup, chorePenaltyAmounts, chorePayout, isTrueFlag,
  lastClosedPeriodKey, shouldSendReminder, shouldSendCheckup, initialCatState,
  refreshAction, applyRebase, applyRestart, escapeHtml, freezesLeft,
  migrateCatState, applyEntry, applyRefresh, applySpend, applyDeposit,
  deriveWallet, isPeriodRecorded, replayCategory, inReplayWindow, replayFrom,
  periodHasEntries, runningBalanceRows, normalizeCategory, validateCategory,
  CHORE_ACCRUAL_CAP,
};
```

Check the source's block for any name missing from this list and add it; the list must match `module.exports` exactly, plus the constant. Change nothing else in the file.

- [ ] **Step 4: Convert the test file's imports**

In `engine.test.js` replace the first three lines:

```js
const test = require('node:test');
const assert = require('node:assert');
const E = require('./engine.js');
```

with:

```js
import test from 'node:test';
import assert from 'node:assert';
import * as E from './engine.js';
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: 106 passing, 0 failing. If a test references `E.something` that is not exported, add it to the export list.

- [ ] **Step 6: Write README.md stub**

```markdown
# Homebase

Habits, chores, and (soon) budgeting for two. Frontend on GitHub Pages at
homebase.samnichols.dev, backend on Supabase.

See `docs/superpowers/specs/2026-09-08-homebase-design.md`.

## Develop

    npm install
    npm test
    supabase start            # local Postgres + functions
    supabase functions serve  # in another shell
```

- [ ] **Step 7: Report**

Run `git status --short`. Suggested commit: `Scaffold repo and move engine to ESM`.

---

### Task 2: Clock and config

**Files:**
- Create: `supabase/functions/_shared/config.js`
- Create: `supabase/functions/_shared/clock.js`
- Test: `supabase/functions/_shared/clock.test.js`

**Interfaces:**
- Produces: `TZ`, `WEEKLY_ROLLOVER_HOUR`, `CHECKUP_TTL_MS` from `config.js`. From `clock.js`: `tzDate(d) -> 'YYYY-MM-DD'`, `tzHour(d) -> 0..23`, `tzHourStr(d) -> 'HH:00'`, `tzMonthStart(d) -> 'YYYY-MM-01'`, `tzStamp(d) -> 'YYYY-MM-DD HH:mm'`, all in `TZ`. These replace every `Utilities.formatDate(..., TZ, ...)` in `main.gs`.

- [ ] **Step 1: Write the failing test**

```js
// supabase/functions/_shared/clock.test.js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test supabase/functions/_shared/clock.test.js`
Expected: FAIL, cannot find module `./clock.js`.

- [ ] **Step 3: Implement**

```js
// supabase/functions/_shared/config.js
export const TZ = 'America/Denver';
// Hour (local) at which a weekly freeze period hands over on Monday. Sunday's
// habit is answered Monday morning; settling at midnight would spend the new
// week's freeze on it and pay the old week's bonus before the answer arrived.
export const WEEKLY_ROLLOVER_HOUR = 17;
// One-tap check-up links stop verifying after this long.
export const CHECKUP_TTL_MS = 2 * 24 * 3600 * 1000;
```

```js
// supabase/functions/_shared/clock.js
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test supabase/functions/_shared/clock.test.js`
Expected: 4 passing.

- [ ] **Step 5: Report**

`git status --short`. Suggested commit: `Add time zone clock helpers`.

---

### Task 3: Signed check-up tokens

**Files:**
- Create: `supabase/functions/_shared/token.js`
- Test: `supabase/functions/_shared/token.test.js`

**Interfaces:**
- Produces: `async signToken(payload, secret) -> string` and `async verifyToken(token, secret, nowMs) -> payload | null`. Payload is `{ person, categoryId, periodKey, result, exp }`. Uses WebCrypto (`globalThis.crypto.subtle`), available in Node 20 and Deno.

- [ ] **Step 1: Write the failing test**

```js
// supabase/functions/_shared/token.test.js
import test from 'node:test';
import assert from 'node:assert';
import { signToken, verifyToken } from './token.js';

const secret = 'test-secret';
const payload = { person: 'a@x.com', categoryId: 'bedtime', periodKey: '2026-09-07', result: 'on_time', exp: 2_000_000_000_000 };

test('round trip', async () => {
  const t = await signToken(payload, secret);
  assert.match(t, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepStrictEqual(await verifyToken(t, secret, 1_000_000_000_000), payload);
});

test('rejects tampering, wrong secret, expiry, garbage', async () => {
  const t = await signToken(payload, secret);
  const [body, sig] = t.split('.');
  const other = await signToken({ ...payload, result: 'missed' }, secret);
  assert.strictEqual(await verifyToken(other.split('.')[0] + '.' + sig, secret, 1), null);
  assert.strictEqual(await verifyToken(t, 'nope', 1), null);
  assert.strictEqual(await verifyToken(t, secret, payload.exp + 1), null);
  assert.strictEqual(await verifyToken('junk', secret, 1), null);
  assert.strictEqual(await verifyToken(body, secret, 1), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test supabase/functions/_shared/token.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

```js
// supabase/functions/_shared/token.js
const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function hmac(msg, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

export async function signToken(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return body + '.' + b64url(await hmac(body, secret));
}

export async function verifyToken(token, secret, nowMs) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  let expected;
  try { expected = b64url(await hmac(body, secret)); } catch { return null; }
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(unb64url(body))); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < nowMs) return null;
  return payload;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test supabase/functions/_shared/token.test.js`
Expected: 2 passing.

- [ ] **Step 5: Report**

Suggested commit: `Add signed check-up tokens`.

---

### Task 4: In-memory store with write journal

**Files:**
- Create: `supabase/functions/_shared/store.js`
- Test: `supabase/functions/_shared/store.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `createStore(snapshot)` where `snapshot = { people, categories, ledger, habitStates, choreStates, settings, holidays }`:
  - `people`: `[{ email, name }]`
  - `categories`: array of category config objects (the JSON the engine consumes, each with `id`, `kind`, `name`, `active`)
  - `ledger`: `[{ id, timestamp (Date), type, category, periodKey, result, freezeUsed, amount, balanceAfter, actor, note }]` oldest first
  - `habitStates`: `[{ actor, category, state }]`
  - `choreStates`: `[{ category, state }]`
  - `settings`: `{ [key]: value }`
  - `holidays`: `['YYYY-MM-DD']`

  Returned store (all synchronous):
  - `allowlist() -> [email]`, `displayName(email) -> string`, `partnerOf(email) -> email|null`
  - `categoriesAll() -> array` (deep copy on read), `saveCategories(list)`
  - `statesAll() -> { [email]: { cats: { [catId]: state } } }`, `saveStatesAll(m)`
  - `choreStatesAll() -> { [catId]: state }`, `saveChoreStates(m)`
  - `getSetting(key) -> value|undefined`, `setSetting(key, value)`, `deleteSetting(key)`
  - `isHoliday(dateStr) -> boolean`
  - `readLedgerRows() -> array` (fresh copies each call), `appendLedger(ev) -> id`, `deleteLedgerRow(id)`, `updateLedgerRow(id, patch)`
  - `journal() -> array` of `{ op: 'append', row } | { op: 'delete', id } | { op: 'update', id, patch } | { op: 'habitState', actor, category, state } | { op: 'choreState', category, state } | { op: 'categories', list } | { op: 'setting', key, value }` (value `null` means delete). Later entries for the same key supersede earlier ones only in `pg.js`; the store records everything in order.
  - Ledger ids come from `crypto.randomUUID()` inside `appendLedger`; nothing else needs an id generator.

- [ ] **Step 1: Write the failing test**

```js
// supabase/functions/_shared/store.test.js
import test from 'node:test';
import assert from 'node:assert';
import { createStore } from './store.js';

function snap() {
  return {
    people: [{ email: 'a@x.com', name: 'Ann' }, { email: 'b@x.com', name: 'Bo' }],
    categories: [{ id: 'bedtime', kind: 'habit', name: 'Bedtime', active: true, cadence: 'daily' }],
    ledger: [{ id: 'r1', timestamp: new Date('2026-09-01T03:00:00Z'), type: 'entry', category: 'bedtime', periodKey: '2026-08-31', result: 'on_time', freezeUsed: false, amount: 0.25, balanceAfter: 0.25, actor: 'a@x.com', note: '' }],
    habitStates: [{ actor: 'a@x.com', category: 'bedtime', state: { streak: 1 } }],
    choreStates: [],
    settings: { chorePauseUntil: '2026-09-20' },
    holidays: ['2026-12-25'],
  };
}

test('people helpers', () => {
  const s = createStore(snap());
  assert.deepStrictEqual(s.allowlist(), ['a@x.com', 'b@x.com']);
  assert.strictEqual(s.displayName('a@x.com'), 'Ann');
  assert.strictEqual(s.displayName('zed@x.com'), 'zed');
  assert.strictEqual(s.partnerOf('a@x.com'), 'b@x.com');
});

test('states map shape and save journals per row', () => {
  const s = createStore(snap());
  assert.deepStrictEqual(s.statesAll(), { 'a@x.com': { cats: { bedtime: { streak: 1 } } } });
  const m = s.statesAll();
  m['a@x.com'].cats.bedtime = { streak: 2 };
  m['b@x.com'] = { cats: { bedtime: { streak: 0 } } };
  s.saveStatesAll(m);
  assert.deepStrictEqual(s.statesAll()['b@x.com'].cats.bedtime, { streak: 0 });
  const j = s.journal().filter((e) => e.op === 'habitState');
  assert.strictEqual(j.length, 2);
  assert.deepStrictEqual(j[0], { op: 'habitState', actor: 'a@x.com', category: 'bedtime', state: { streak: 2 } });
});

test('ledger append, update, delete', () => {
  const s = createStore(snap());
  const id = s.appendLedger({ type: 'spend', amount: 1, balanceAfter: 0, actor: 'a@x.com', note: 'coffee' });
  assert.match(id, /^[0-9a-f-]{36}$/);
  let rows = s.readLedgerRows();
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].id, id);
  assert.strictEqual(rows[1].category, '');
  assert.strictEqual(rows[1].periodKey, '');
  assert.strictEqual(rows[1].freezeUsed, false);
  rows[1].amount = 999; // mutating a read copy must not touch the store
  assert.strictEqual(s.readLedgerRows()[1].amount, 1);
  s.updateLedgerRow('r1', { amount: 0.5, freezeUsed: true });
  assert.strictEqual(s.readLedgerRows()[0].amount, 0.5);
  s.deleteLedgerRow('r1');
  assert.strictEqual(s.readLedgerRows().length, 1);
  const ops = s.journal().map((e) => e.op);
  assert.deepStrictEqual(ops, ['append', 'update', 'delete']);
});

test('settings, holidays, categories', () => {
  const s = createStore(snap());
  assert.strictEqual(s.getSetting('chorePauseUntil'), '2026-09-20');
  s.deleteSetting('chorePauseUntil');
  assert.strictEqual(s.getSetting('chorePauseUntil'), undefined);
  s.setSetting('x', 5);
  assert.strictEqual(s.isHoliday('2026-12-25'), true);
  assert.strictEqual(s.isHoliday('2026-12-26'), false);
  const list = s.categoriesAll();
  list[0].name = 'Sleep';
  assert.strictEqual(s.categoriesAll()[0].name, 'Bedtime');
  s.saveCategories(list);
  assert.strictEqual(s.categoriesAll()[0].name, 'Sleep');
  const j = s.journal();
  assert.deepStrictEqual(j[0], { op: 'setting', key: 'chorePauseUntil', value: null });
  assert.deepStrictEqual(j[1], { op: 'setting', key: 'x', value: 5 });
  assert.strictEqual(j[2].op, 'categories');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test supabase/functions/_shared/store.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

```js
// supabase/functions/_shared/store.js
// Synchronous, in-memory view of the tables an action needs, plus a journal of
// every write. The ported Apps Script logic stays synchronous and near
// verbatim; pg.js turns the journal into SQL inside one transaction.

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function normRow(r) {
  return {
    id: r.id,
    timestamp: r.timestamp instanceof Date ? new Date(r.timestamp) : new Date(r.timestamp),
    type: r.type,
    category: r.category == null ? '' : String(r.category),
    periodKey: r.periodKey == null ? '' : String(r.periodKey),
    result: r.result == null ? '' : String(r.result),
    freezeUsed: r.freezeUsed === true,
    amount: Number(r.amount) || 0,
    balanceAfter: r.balanceAfter === '' || r.balanceAfter == null ? '' : Number(r.balanceAfter),
    actor: r.actor == null ? '' : String(r.actor),
    note: r.note == null ? '' : String(r.note),
  };
}

export function createStore(snapshot) {
  const people = snapshot.people.map((p) => ({ email: String(p.email).toLowerCase(), name: p.name }));
  let categories = clone(snapshot.categories || []);
  const ledger = (snapshot.ledger || []).map(normRow);
  const habit = {};
  for (const r of snapshot.habitStates || []) {
    (habit[r.actor] ||= {})[r.category] = clone(r.state);
  }
  const chores = {};
  for (const r of snapshot.choreStates || []) chores[r.category] = clone(r.state);
  const settings = clone(snapshot.settings || {});
  const holidays = new Set(snapshot.holidays || []);
  const journal = [];

  return {
    allowlist: () => people.map((p) => p.email),
    displayName(email) {
      const p = people.find((x) => x.email === String(email || '').toLowerCase());
      return p ? p.name : String(email || '').split('@')[0];
    },
    partnerOf(email) {
      const p = people.find((x) => x.email !== email);
      return p ? p.email : null;
    },

    categoriesAll: () => clone(categories),
    saveCategories(list) {
      categories = clone(list);
      journal.push({ op: 'categories', list: clone(list) });
    },

    statesAll() {
      const m = {};
      for (const actor of Object.keys(habit)) m[actor] = { cats: clone(habit[actor]) };
      return m;
    },
    saveStatesAll(m) {
      for (const actor of Object.keys(m)) {
        const cats = (m[actor] && m[actor].cats) || {};
        for (const cat of Object.keys(cats)) {
          const before = habit[actor] && habit[actor][cat];
          if (JSON.stringify(before) === JSON.stringify(cats[cat])) continue;
          (habit[actor] ||= {})[cat] = clone(cats[cat]);
          journal.push({ op: 'habitState', actor, category: cat, state: clone(cats[cat]) });
        }
      }
    },

    choreStatesAll: () => clone(chores),
    saveChoreStates(m) {
      for (const cat of Object.keys(m)) {
        if (JSON.stringify(chores[cat]) === JSON.stringify(m[cat])) continue;
        chores[cat] = clone(m[cat]);
        journal.push({ op: 'choreState', category: cat, state: clone(m[cat]) });
      }
    },

    getSetting: (key) => clone(settings[key]),
    setSetting(key, value) {
      settings[key] = clone(value);
      journal.push({ op: 'setting', key, value: clone(value) });
    },
    deleteSetting(key) {
      delete settings[key];
      journal.push({ op: 'setting', key, value: null });
    },

    isHoliday: (dateStr) => holidays.has(String(dateStr)),

    readLedgerRows: () => ledger.map((r) => ({ ...r, timestamp: new Date(r.timestamp) })),
    appendLedger(ev) {
      const row = normRow({ ...ev, id: crypto.randomUUID(), timestamp: ev.timestamp || new Date() });
      ledger.push(row);
      journal.push({ op: 'append', row: { ...row } });
      return row.id;
    },
    deleteLedgerRow(id) {
      const i = ledger.findIndex((r) => String(r.id) === String(id));
      if (i === -1) return false;
      ledger.splice(i, 1);
      journal.push({ op: 'delete', id: String(id) });
      return true;
    },
    updateLedgerRow(id, patch) {
      const row = ledger.find((r) => String(r.id) === String(id));
      if (!row) return false;
      Object.assign(row, normRow({ ...row, ...patch }));
      journal.push({ op: 'update', id: String(id), patch: clone(patch) });
      return true;
    },

    journal: () => journal.slice(),
  };
}
```

Note: `appendLedger` uses `new Date()` for the row timestamp only when the caller did not pass one. `service.js` always passes `timestamp: ctx.now()` so tests stay deterministic.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test supabase/functions/_shared/store.test.js`
Expected: 4 passing.

- [ ] **Step 5: Report**

Suggested commit: `Add journaled in-memory store`.

---

### Task 5: Service port, part 1: context, state, chores, dashboard

This task and the next two port `main.gs` into `service.js`. The port is mechanical. Work through `main.gs` top to bottom and apply this substitution table; everything not in the table copies over as is.

| Apps Script | Port |
| --- | --- |
| `var X = ...` at top level (TZ, WEEKLY_ROLLOVER_HOUR, ALLOWLIST, NAMES, HOLIDAYS, DASHBOARD_URL) | `TZ`, `WEEKLY_ROLLOVER_HOUR` from `config.js`; `ALLOWLIST` becomes `store.allowlist()`; `NAMES`/`displayName` becomes `store.displayName(email)`; `HOLIDAYS`/`isHolidayDay` becomes `store.isHoliday(d)`; `DASHBOARD_URL` becomes `ctx.dashboardUrl` |
| `Utilities.formatDate(d, TZ, 'yyyy-MM-dd')` | `tzDate(d)` |
| `Utilities.formatDate(new Date(), TZ, 'HH')` | `tzHour(ctx.now())` / `tzHourStr(ctx.now())` |
| `Utilities.formatDate(new Date(), TZ, 'yyyy-MM-01')` | `tzMonthStart(ctx.now())` |
| `Utilities.formatDate(d, TZ, 'yyyy-MM-dd HH:mm')` | `tzStamp(d)` |
| `new Date()` | `ctx.now()` |
| `props().getProperty('states')` / `saveStatesAll` | `store.statesAll()` / `store.saveStatesAll(m)` |
| `props().getProperty('choreStates')` / save | `store.choreStatesAll()` / `store.saveChoreStates(m)` |
| `props().getProperty('categories')` / save | `store.categoriesAll()` / `store.saveCategories(list)` |
| `props().getProperty('chorePauseUntil')` | `store.getSetting('chorePauseUntil') || ''` |
| `props().setProperty('chorePauseUntil', v)` / `deleteProperty` | `store.setSetting(...)` / `store.deleteSetting(...)` |
| `readLedgerRows()` | `store.readLedgerRows()` (rows carry `id`, never `rowNumber`) |
| `appendLedger(ev)` | `store.appendLedger({ ...ev, timestamp: ctx.now() })` |
| `ledgerSheet().deleteRow(match.rowNumber)` | `store.deleteLedgerRow(match.id)` |
| `ledgerSheet().getRange(target.rowNumber, 6).setValue(result)` | `store.updateLedgerRow(target.id, { result })` |
| The ranged write at the end of `replayAndSave` | one `store.updateLedgerRow(id, { freezeUsed, amount, balanceAfter })` per row that changed |
| `withLock(fn)` | `fn()` (the transaction in `pg.js` holds the lock) |
| `LockService`, `SpreadsheetApp.flush()`, `cleanupTokens`, `ensureSecret`, `sign`, `actionSig`, `verifyActionSig`, `newToken`, `loginAllowed`, `requestLogin`, `verifyToken`, `doGet`, `doPost`, `handle`, `ensureTotalsTab`, `migrateLedgerIdColumn`, `setup`, `seedChores`, `runTests`, `ensureKeyColumnIsText`, `createLedgerSpreadsheet`, `openLedgerOrThrow`, `ledgerSheet`, `cellPeriodKey`, `props` | Drop. Login is Supabase Auth; check-up links use `token.js`. |
| `MailApp.sendEmail({ to, subject, htmlBody })` | `ctx.mail.send({ to, subject, html })` (collected; see Task 7) |
| `doDeposit` | Drop, and drop its `route` case. |
| `requireUser(p)` | `p.user` (the edge function sets it from the JWT); throw `Error('not authorized — please log in again')` if missing |
| Engine functions | `import * as E from './engine.js'` and call as `E.payout(...)` etc., or destructure the names used at the top of the file |

**Files:**
- Create: `supabase/functions/_shared/service.js`
- Test: `supabase/functions/_shared/service.test.js`
- Create: `supabase/functions/_shared/testkit.js` (fixtures shared by the service tests)

**Interfaces:**
- Consumes: `createStore`, `clock.js`, `config.js`, `engine.js`.
- Produces: `createService(ctx)` where `ctx = { store, now: () => Date, mail: { send(msg) }, dashboardUrl: string, secret: string }`. Returns an object with `route(p)`, `dispatch()`, `checkup(payload)` (Tasks 6 and 7 fill in the last two). `route({ action: 'state', user })` returns the dashboard response exactly as `stateResponse` does today.
- `testkit.js` produces `makeCtx({ nowIso, categories, ledger, habitStates, choreStates, settings, people })` returning `{ ctx, store, sent }` where `sent` collects mail.

- [ ] **Step 1: Write the test kit**

```js
// supabase/functions/_shared/testkit.js
import { createStore } from './store.js';

export const ANN = 'ann@x.com';
export const BO = 'bo@x.com';

export const BEDTIME = {
  id: 'bedtime', kind: 'habit', name: 'Bedtime', emoji: '🛏️', cadence: 'daily',
  rewardIncrement: 0.25, maxPerInstance: 5, freezesPerPeriod: 1, freezeRefresh: 'weekly',
  unusedFreezeBonus: 1, missPenaltyPercent: 100, minPayout: 0, notes: '',
  reminderTime: '21:00', checkupTime: '09:00', active: true,
};

export const DISHES = {
  id: 'dishes', kind: 'chore', name: 'Dishes', emoji: '🍽️', cadence: 'daily',
  value: 2, assignee: '', dueDate: '', dueDay: '', notes: '', reminderTime: '20:00', active: true,
};

export function makeCtx(opts = {}) {
  const store = createStore({
    people: opts.people || [{ email: ANN, name: 'Ann' }, { email: BO, name: 'Bo' }],
    categories: opts.categories || [BEDTIME],
    ledger: opts.ledger || [],
    habitStates: opts.habitStates || [],
    choreStates: opts.choreStates || [],
    settings: opts.settings || {},
    holidays: opts.holidays || [],
  });
  const sent = [];
  // Default clock: Tuesday 2026-09-08 10:00 Denver time (16:00Z).
  let now = new Date(opts.nowIso || '2026-09-08T16:00:00Z');
  const ctx = {
    store,
    now: () => now,
    setNow: (iso) => { now = new Date(iso); },
    mail: { send: async (m) => { sent.push(m); } },
    dashboardUrl: 'https://homebase.samnichols.dev/',
    secret: 'test-secret',
  };
  return { ctx, store, sent };
}
```

- [ ] **Step 2: Write the failing tests for part 1**

```js
// supabase/functions/_shared/service.test.js
import test from 'node:test';
import assert from 'node:assert';
import { createService } from './service.js';
import { makeCtx, ANN, BO, BEDTIME, DISHES } from './testkit.js';

test('state: fresh store initializes states and returns dashboard shape', () => {
  const { ctx, store } = makeCtx();
  const svc = createService(ctx);
  const r = svc.route({ action: 'state', user: ANN });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.user, ANN);
  assert.strictEqual(r.name, 'Ann');
  assert.strictEqual(r.wallet, 0);
  assert.strictEqual(r.pauseUntil, '');
  assert.deepStrictEqual(r.partner, { name: 'Bo', wallet: 0 });
  assert.strictEqual(r.cats.length, 1);
  const c = r.cats[0];
  assert.strictEqual(c.id, 'bedtime');
  assert.strictEqual(c.streak, 0);
  assert.strictEqual(c.freezeAvailable, 1);
  assert.strictEqual(c.potential, 0.25);
  // Tuesday: the recordable daily period is yesterday.
  assert.strictEqual(c.nextPeriodKey, '2026-09-07');
  assert.strictEqual(c.recordedResult, null);
  assert.deepStrictEqual(r.chores, []);
  assert.deepStrictEqual(r.ledger, []);
  // Initial state was written for the caller.
  const states = store.statesAll();
  assert.strictEqual(states[ANN].cats.bedtime.streak, 0);
  // Weekly freeze period starts on Monday 2026-09-07.
  assert.strictEqual(states[ANN].cats.bedtime.periodStart, '2026-09-07');
});

test('state: requires a user', () => {
  const { ctx } = makeCtx();
  assert.throws(() => createService(ctx).route({ action: 'state' }), /not authorized/);
});

test('state: chores appear with claimable period and group', () => {
  const { ctx, store } = makeCtx({ categories: [BEDTIME, DISHES] });
  const r = createService(ctx).route({ action: 'state', user: ANN });
  assert.strictEqual(r.chores.length, 1);
  assert.strictEqual(r.chores[0].claimablePeriodKey, '2026-09-08');
  assert.strictEqual(r.chores[0].claimedBy, null);
  // Fresh chore state starts tracking today; nothing is owed.
  assert.deepStrictEqual(store.choreStatesAll().dishes.since, '2026-09-08');
  assert.strictEqual(store.readLedgerRows().length, 0);
});

test('state: an overdue chore accrues a penalty row for each person on load', () => {
  const { ctx, store } = makeCtx({
    categories: [DISHES],
    choreStates: [{ category: 'dishes', state: { since: '2026-09-05', sweepFrom: '2026-09-05', chargedThrough: '2026-09-06' } }],
  });
  createService(ctx).route({ action: 'state', user: ANN });
  const rows = store.readLedgerRows();
  // Sept 7 drains for the closed period Sept 6; Sept 8 drains again onto Sept 7.
  const penalties = rows.filter((r) => r.type === 'penalty');
  assert.strictEqual(penalties.length, 4);
  assert.deepStrictEqual(new Set(penalties.map((r) => r.actor)), new Set([ANN, BO]));
  assert.ok(penalties.every((r) => r.amount < 0));
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test supabase/functions/_shared/service.test.js`
Expected: FAIL, cannot find module `./service.js`.

- [ ] **Step 4: Port part 1**

Create `service.js` with this frame, then port the listed `main.gs` functions into it, applying the substitution table:

```js
// supabase/functions/_shared/service.js
// Ported from the Apps Script glue (samsite/habits/backend/main.gs). Runs
// synchronously against a journaled store; the caller owns the transaction.
import * as E from './engine.js';
import { WEEKLY_ROLLOVER_HOUR, CHECKUP_TTL_MS } from './config.js';
import { tzDate, tzHour, tzHourStr, tzMonthStart, tzStamp } from './clock.js';
import { signToken } from './token.js';

export function createService(ctx) {
  const store = ctx.store;

  // ── date helpers (main.gs 62-98) ──
  const todayStr = () => tzDate(ctx.now());
  const currentDow = () => E.isoDow(todayStr());
  const currentHourInt = () => tzHour(ctx.now());
  function currentMondayStr() {
    const monday = E.mondayOf(todayStr(), currentDow());
    if (currentDow() === 1 && currentHourInt() < WEEKLY_ROLLOVER_HOUR) return E.shiftDays(monday, -7);
    return monday;
  }
  const recordablePeriodKey = (cat) => E.lastClosedPeriodKey(cat.cadence, todayStr(), currentDow());
  const currentMonthStr = () => tzMonthStart(ctx.now());

  // ── storage helpers (main.gs 100-360) ──
  // port: choreStateOf, chorePauseUntil, sweepNeeded, sweepChores,
  // accrualTarget, catchablePeriod, endChorePause, doPauseChores,
  // doResumeChores, applyChorePenalty, walletOf, catStateOf, saveCatState,
  // categoryById, activeCategories, isHabit, activeHabits, activeChores,
  // categoryNames, currentPeriodStart

  // ── ledger helpers (main.gs 451-485) ──
  // port: formatTimestamp (use tzStamp), recentLedger

  // ── dashboard (main.gs 651-778) ──
  // port: requireUser (reads p.user), ensureCatStates, refreshNeeded,
  // catPublicFromState, catPublic, stateResponse

  // ── refresh (main.gs 1280-1301) ──
  // port: maybeRefresh (needed by stateResponse)

  function route(p) {
    switch (p.action) {
      case 'state': return stateResponse(requireUser(p));
      default: return { ok: true, name: 'Homebase API' };
    }
  }

  return { route };
}
```

Port guidance for the trickier spots:

- `requireUser(p)`: `const email = String(p.user || '').toLowerCase(); if (!email || store.allowlist().indexOf(email) === -1) throw new Error('not authorized — please log in again'); return email;`
- `applyChorePenalty(cat, periodKey, rows)`: replace `ALLOWLIST` with `store.allowlist()`; the pushed in-memory row must use the `id` returned by `store.appendLedger` and `timestamp: ctx.now()`.
- `recentLedger`: `canDelete` keeps `'deposit'` in its list so migrated deposit rows stay removable.
- `stateResponse`: the `withLock(function () {...})` wrapper becomes a plain block.
- `isHolidayDay(d)` becomes `store.isHoliday(d)`.
- `displayName(email)` becomes `store.displayName(email)`; `partnerOf(email)` becomes `store.partnerOf(email)`.

Example of a finished port, `catStateOf` (main.gs 303-318):

```js
  function catStateOf(email, catId, cat) {
    const m = store.statesAll();
    if (!m[email]) m[email] = { cats: {} };
    if (!m[email].cats) m[email].cats = {};
    let s = m[email].cats[catId];
    if (s) {
      const migrated = E.migrateCatState(cat, s);
      if (migrated === s) return s;
      s = migrated;
    } else {
      s = E.initialCatState(cat, currentPeriodStart(cat));
    }
    m[email].cats[catId] = s;
    store.saveStatesAll(m);
    return s;
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test supabase/functions/_shared/service.test.js`
Expected: 4 passing. If the penalty count differs, check `sweepChores` ported `chargedThrough` handling and that `store.isHoliday` returns false for the fixture dates.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all passing.

- [ ] **Step 7: Report**

Suggested commit: `Port dashboard state and chore sweep to service`.

---

### Task 6: Service port, part 2: mutations

**Files:**
- Modify: `supabase/functions/_shared/service.js`
- Test: `supabase/functions/_shared/service.test.js` (append)

**Interfaces:**
- Consumes: part 1.
- Produces: `route(p)` handles `record`, `spend`, `deleteEntry`, `amend`, `catHistory`, `claim`, `pauseChores`, `resumeChores`, `listCategories`, `saveCategory`, `archiveCategory`, `unarchiveCategory`. Also exports `recordFor(person, categoryId, periodKey, result)`, the signed-link path used by `checkup` in Task 7. Response shapes match `main.gs`.

- [ ] **Step 1: Write the failing tests**

Append to `service.test.js`:

```js
test('record: on_time pays and refuses a second answer for the same period', () => {
  const { ctx, store } = makeCtx();
  const svc = createService(ctx);
  const r = svc.route({ action: 'record', user: ANN, categoryId: 'bedtime', result: 'on_time' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.wallet, 0.25);
  assert.strictEqual(r.cat.streak, 1);
  assert.strictEqual(r.event.type, 'entry');
  assert.strictEqual(r.event.periodKey, '2026-09-07');
  const again = svc.route({ action: 'record', user: ANN, categoryId: 'bedtime', result: 'missed' });
  assert.strictEqual(again.ok, false);
  assert.match(again.error, /already recorded/);
  assert.strictEqual(store.readLedgerRows().length, 1);
  const j = store.journal();
  assert.ok(j.some((e) => e.op === 'append'));
  assert.ok(j.some((e) => e.op === 'habitState' && e.actor === ANN));
});

test('record: a miss with a freeze protects the streak and pays nothing', () => {
  const { ctx } = makeCtx({
    habitStates: [{ actor: ANN, category: 'bedtime', state: { streak: 3, periodStart: '2026-09-07', freezeRefresh: 'weekly', freezesUsedThisPeriod: 0, lastRecordedKey: '2026-09-06', since: '2026-08-31' } }],
  });
  const r = createService(ctx).route({ action: 'record', user: ANN, categoryId: 'bedtime', result: 'missed' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.event.freezeUsed, true);
  assert.strictEqual(r.event.amount, 0);
  assert.strictEqual(r.cat.streak, 3);
  assert.strictEqual(r.cat.freezeAvailable, 0);
});

test('record: rejects chores, unknown, archived', () => {
  const { ctx } = makeCtx({ categories: [BEDTIME, DISHES, { ...BEDTIME, id: 'old', active: false }] });
  const svc = createService(ctx);
  assert.match(svc.route({ action: 'record', user: ANN, categoryId: 'dishes', result: 'on_time' }).error, /claimed, not answered/);
  assert.match(svc.route({ action: 'record', user: ANN, categoryId: 'nope', result: 'on_time' }).error, /unknown category/);
  assert.match(svc.route({ action: 'record', user: ANN, categoryId: 'old', result: 'on_time' }).error, /archived/);
});

test('recordFor: the signed-link path records a server-issued period key', () => {
  const { ctx } = makeCtx();
  const svc = createService(ctx);
  const r = svc.recordFor(ANN, 'bedtime', '2026-09-07', 'on_time');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.user, ANN);
  assert.strictEqual(r.event.amount, 0.25);
  assert.match(svc.recordFor('stranger@x.com', 'bedtime', '2026-09-07', 'on_time').error, /unknown person/);
});

test('record: a late answer for a rolled-over period is appended and replayed', () => {
  const { ctx, store } = makeCtx({
    habitStates: [{ actor: ANN, category: 'bedtime', state: { streak: 0, periodStart: '2026-09-07', freezeRefresh: 'weekly', freezesUsedThisPeriod: 0, lastRecordedKey: null, since: '2026-08-31' } }],
  });
  const r = createService(ctx).recordFor(ANN, 'bedtime', '2026-09-05', 'on_time');
  assert.strictEqual(r.ok, true);
  const rows = store.readLedgerRows();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].periodKey, '2026-09-05');
  assert.strictEqual(rows[0].amount, 0.25);
  assert.strictEqual(r.wallet, 0.25);
});

test('spend: debits the wallet and floors at zero', () => {
  const { ctx } = makeCtx({
    ledger: [{ id: 'r1', timestamp: new Date('2026-09-01T03:00:00Z'), type: 'entry', category: 'bedtime', periodKey: '2026-08-31', result: 'on_time', freezeUsed: false, amount: 3, balanceAfter: 3, actor: ANN, note: '' }],
  });
  const svc = createService(ctx);
  const r = svc.route({ action: 'spend', user: ANN, amount: 1.25, note: 'coffee' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.wallet, 1.75);
  assert.strictEqual(r.event.type, 'spend');
  assert.strictEqual(svc.route({ action: 'spend', user: ANN, amount: 10 }).wallet, 0);
});

test('deleteEntry: removes own entry and replays; refuses partner rows', () => {
  const { ctx, store } = makeCtx();
  const svc = createService(ctx);
  svc.route({ action: 'record', user: ANN, categoryId: 'bedtime', result: 'on_time' });
  const id = store.readLedgerRows()[0].id;
  assert.match(svc.route({ action: 'deleteEntry', user: BO, id }).error, /your own entries/);
  const r = svc.route({ action: 'deleteEntry', user: ANN, id });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.wallet, 0);
  assert.strictEqual(r.cat.streak, 0);
  assert.strictEqual(store.readLedgerRows().length, 0);
  assert.ok(store.journal().some((e) => e.op === 'delete' && e.id === id));
});

test('amend: back-fills a closed day and ripples later amounts', () => {
  const { ctx, store } = makeCtx({
    ledger: [{ id: 'r1', timestamp: new Date('2026-09-08T03:00:00Z'), type: 'entry', category: 'bedtime', periodKey: '2026-09-07', result: 'on_time', freezeUsed: false, amount: 0.25, balanceAfter: 0.25, actor: ANN, note: '' }],
    habitStates: [{ actor: ANN, category: 'bedtime', state: { streak: 1, periodStart: '2026-09-07', freezeRefresh: 'weekly', freezesUsedThisPeriod: 0, lastRecordedKey: '2026-09-07', since: '2026-08-31' } }],
  });
  const svc = createService(ctx);
  const r = svc.route({ action: 'amend', user: ANN, categoryId: 'bedtime', periodKey: '2026-09-06', result: 'on_time' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ripple.entriesChanged, 1); // Sept 7 is now streak 2 and re-priced
  const rows = store.readLedgerRows().sort((a, b) => (a.periodKey < b.periodKey ? -1 : 1));
  assert.strictEqual(rows[0].amount, 0.25);
  assert.strictEqual(rows[1].amount, 0.5);
  assert.strictEqual(r.wallet, 0.75);
  assert.strictEqual(r.cat.streak, 2);
  assert.match(svc.route({ action: 'amend', user: ANN, categoryId: 'bedtime', periodKey: '2026-09-08', result: 'on_time' }).error, /isn't over yet/);
  assert.match(svc.route({ action: 'amend', user: ANN, categoryId: 'bedtime', periodKey: 'nope', result: 'on_time' }).error, /real date/);
});

test('catHistory: newest first', () => {
  const { ctx } = makeCtx({
    ledger: [
      { id: 'a', timestamp: new Date(), type: 'entry', category: 'bedtime', periodKey: '2026-09-05', result: 'on_time', freezeUsed: false, amount: 0.25, balanceAfter: 0.25, actor: ANN, note: '' },
      { id: 'b', timestamp: new Date(), type: 'entry', category: 'bedtime', periodKey: '2026-09-06', result: 'missed', freezeUsed: true, amount: 0, balanceAfter: 0.25, actor: ANN, note: '' },
    ],
  });
  const r = createService(ctx).route({ action: 'catHistory', user: ANN, categoryId: 'bedtime' });
  assert.deepStrictEqual(r.entries, [
    { periodKey: '2026-09-06', result: 'missed', freezeUsed: true },
    { periodKey: '2026-09-05', result: 'on_time', freezeUsed: false },
  ]);
});

test('claim: pays the chore value and blocks a second claim', () => {
  const { ctx } = makeCtx({ categories: [DISHES] });
  const svc = createService(ctx);
  svc.route({ action: 'state', user: ANN }); // initializes chore state
  const r = svc.route({ action: 'claim', user: ANN, categoryId: 'dishes' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.wallet, 2);
  assert.strictEqual(r.event.periodKey, '2026-09-08');
  assert.match(svc.route({ action: 'claim', user: BO, categoryId: 'dishes' }).error, /already done/);
});

test('pauseChores and resumeChores', () => {
  const { ctx, store } = makeCtx({ categories: [DISHES] });
  const svc = createService(ctx);
  assert.match(svc.route({ action: 'pauseChores', user: ANN, until: '2026-09-01' }).error, /after today/);
  const r = svc.route({ action: 'pauseChores', user: ANN, until: '2026-09-15' });
  assert.deepStrictEqual(r, { ok: true, pauseUntil: '2026-09-15' });
  assert.strictEqual(store.getSetting('chorePauseUntil'), '2026-09-15');
  assert.strictEqual(svc.route({ action: 'state', user: ANN }).pauseUntil, '2026-09-15');
  assert.deepStrictEqual(svc.route({ action: 'resumeChores', user: ANN }), { ok: true, pauseUntil: '' });
  assert.strictEqual(store.getSetting('chorePauseUntil'), undefined);
});

test('category admin: save, archive, unarchive, kind is fixed', () => {
  const { ctx, store } = makeCtx();
  const svc = createService(ctx);
  const list = svc.route({ action: 'listCategories', user: ANN });
  assert.strictEqual(list.categories.length, 1);
  assert.deepStrictEqual(list.people, [{ email: ANN, name: 'Ann' }, { email: BO, name: 'Bo' }]);
  const saved = svc.route({ action: 'saveCategory', user: ANN, category: JSON.stringify({ name: 'Run', cadence: 'daily', rewardIncrement: 1, maxPerInstance: 5, freezesPerPeriod: 1 }) });
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(saved.categories.length, 2);
  assert.strictEqual(saved.categories[1].id, 'run');
  assert.match(svc.route({ action: 'saveCategory', user: ANN, category: JSON.stringify({ id: 'run', kind: 'chore', name: 'Run', cadence: 'daily', value: 1 }) }).error, /can't change between habit and chore/);
  assert.match(svc.route({ action: 'saveCategory', user: ANN, category: JSON.stringify({ kind: 'chore', name: 'Bins', cadence: 'weekly', value: 1, assignee: 'stranger@x.com' }) }).error, /one of the two of you/);
  assert.strictEqual(svc.route({ action: 'archiveCategory', user: ANN, categoryId: 'run' }).categories[1].active, false);
  assert.strictEqual(svc.route({ action: 'unarchiveCategory', user: ANN, categoryId: 'run' }).categories[1].active, true);
  assert.ok(store.journal().some((e) => e.op === 'categories'));
});

test('deposit is gone', () => {
  const { ctx } = makeCtx();
  const r = createService(ctx).route({ action: 'deposit', user: ANN, amount: 5 });
  assert.deepStrictEqual(r, { ok: true, name: 'Homebase API' });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test supabase/functions/_shared/service.test.js`
Expected: the new tests FAIL (actions fall through to the default response).

- [ ] **Step 3: Port part 2**

Port from `main.gs`, applying the substitution table: `doRecord` (780-835), `doSpend` (836-842), `doDeleteEntry` (857-903), `walletWithout`, `entryRowsFor`, `replayAndSave` (924-993), `doAmend` (994-1045), `doCatHistory` (1046-1063), `doClaim` (1064-1110), `doListCategories`, `doSaveCategory` (1118-1179), `doArchiveCategory`, `doUnarchiveCategory` (1180-1214), `restartPeriod` (1215-1226). Skip `doDeposit`.

Split `doRecord` so the two auth paths share one body:

```js
  // Dashboard path: the SERVER decides which period is being recorded (the
  // just-closed one, in TZ), so device clocks can't skew entries.
  function doRecord(p) {
    const person = requireUser(p);
    const cat = categoryById(p.categoryId);
    if (!cat) return { ok: false, error: 'unknown category' };
    return recordEntry(person, cat, recordablePeriodKey(cat), p.result);
  }
  // Signed-link path: the token carried a server-issued period key.
  function recordFor(person, categoryId, periodKey, result) {
    const cat = categoryById(categoryId);
    if (!cat) return { ok: false, error: 'unknown category' };
    person = String(person || '').trim().toLowerCase();
    if (store.allowlist().indexOf(person) === -1) return { ok: false, error: 'unknown person' };
    return recordEntry(person, cat, String(periodKey), result);
  }
  function recordEntry(person, cat, periodKey, result) {
    if (!isHabit(cat)) return { ok: false, error: 'chores are claimed, not answered — use its card on the dashboard' };
    if (!cat.active) return { ok: false, error: 'that habit is archived' };
    if (result !== 'on_time' && result !== 'missed') return { ok: false, error: 'result must be "on_time" or "missed"' };
    // ... the body of main.gs doRecord from `maybeRefresh(cat);` (line 808) to
    // the end, with appendLedger/readLedgerRows/etc. substituted.
  }
```

`replayAndSave` after the port ends like this (replacing the `touch`/ranged-write machinery, main.gs 934-975):

```js
    let changed = 0;
    mine.forEach((row) => {
      const e = corrected[String(row.id)];
      if (!e) return; // before the edited period — never re-priced
      if (E.isTrueFlag(row.freezeUsed) === e.freezeUsed && (Number(row.amount) || 0) === e.amount) return;
      if (String(row.id) !== String(excludeId)) changed++;
      row.freezeUsed = e.freezeUsed;
      row.amount = e.amount;
      store.updateLedgerRow(row.id, { freezeUsed: e.freezeUsed, amount: e.amount });
    });
    // balanceAfter is cosmetic (the app re-derives) but keep rows readable.
    const a = String(email || '').toLowerCase();
    const myAll = rows.filter((x) => String(x.actor || '').toLowerCase() === a);
    const rb = E.runningBalanceRows(rows, email);
    for (let i = 0; i < rb.length; i++) {
      if (Number(myAll[i].balanceAfter) !== rb[i].balanceAfter) {
        myAll[i].balanceAfter = rb[i].balanceAfter;
        store.updateLedgerRow(myAll[i].id, { balanceAfter: rb[i].balanceAfter });
      }
    }
```

`rows` here is the array returned by `store.readLedgerRows()` after the caller's mutation; `mine` is `entryRowsFor(rows, email, cat.id)`, which are references into `rows`, so the in-place edits feed `runningBalanceRows` exactly as in the original.

Extend `route`:

```js
  function route(p) {
    switch (p.action) {
      case 'state': return stateResponse(requireUser(p));
      case 'record': return doRecord(p);
      case 'spend': return doSpend(p);
      case 'deleteEntry': return doDeleteEntry(p);
      case 'amend': return doAmend(p);
      case 'catHistory': return doCatHistory(p);
      case 'claim': return doClaim(p);
      case 'pauseChores': return doPauseChores(p);
      case 'resumeChores': return doResumeChores(p);
      case 'listCategories': return doListCategories(p);
      case 'saveCategory': return doSaveCategory(p);
      case 'archiveCategory': return doArchiveCategory(p);
      case 'unarchiveCategory': return doUnarchiveCategory(p);
      default: return { ok: true, name: 'Homebase API' };
    }
  }
  return { route, recordFor };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test supabase/functions/_shared/service.test.js`
Expected: all passing. The amend ripple test is the most sensitive; if `entriesChanged` is 0, check that `replayAndSave` reads rows after the mutation and that `updateLedgerRow` was applied to the Sept 7 row.

- [ ] **Step 5: Run the whole suite and report**

Run: `npm test`. Suggested commit: `Port record, spend, amend, claim, and admin actions`.

---

### Task 7: Service port, part 3: dispatch, check-up, mailer

**Files:**
- Modify: `supabase/functions/_shared/service.js`
- Create: `supabase/functions/_shared/mail.js`
- Test: `supabase/functions/_shared/service.test.js` (append), `supabase/functions/_shared/mail.test.js`

**Interfaces:**
- Produces: `dispatch() -> Promise<{ ok, failures: string[] }>` (async because mail sends are awaited), `checkup(payload) -> response` where `payload` is a verified token payload. Check-up links are `${dashboardUrl}?t=${token}`. `mail.js` exports `createResendMailer({ apiKey, from, replyTo, fetchImpl })` with `send({ to, subject, html })`.

- [ ] **Step 1: Write the failing tests**

Append to `service.test.js`:

```js
import { verifyToken } from './token.js';

test('dispatch: sends reminder at reminder hour to both people', async () => {
  // 21:00 Denver on Tue 2026-09-08 is 03:00Z Wed.
  const { ctx, sent } = makeCtx({ nowIso: '2026-09-09T03:00:00Z' });
  const r = await createService(ctx).dispatch();
  assert.deepStrictEqual(r, { ok: true, failures: [] });
  assert.strictEqual(sent.length, 2);
  assert.deepStrictEqual(new Set(sent.map((m) => m.to)), new Set([ANN, BO]));
  assert.match(sent[0].subject, /Bedtime — \$0\.25 on the line/);
});

test('dispatch: check-up carries signed yes/no links and skips recorded people', async () => {
  // 09:00 Denver Tue 2026-09-08 is 15:00Z.
  const { ctx, sent } = makeCtx({
    nowIso: '2026-09-08T15:00:00Z',
    ledger: [{ id: 'r1', timestamp: new Date(), type: 'entry', category: 'bedtime', periodKey: '2026-09-07', result: 'on_time', freezeUsed: false, amount: 0.25, balanceAfter: 0.25, actor: BO, note: '' }],
  });
  await createService(ctx).dispatch();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, ANN);
  const links = [...sent[0].html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.strictEqual(links.length, 2);
  const url = new URL(links[0]);
  assert.strictEqual(url.origin + url.pathname, 'https://homebase.samnichols.dev/');
  const nowMs = new Date('2026-09-08T15:00:00Z').getTime();
  const payload = await verifyToken(url.searchParams.get('t'), 'test-secret', nowMs);
  assert.deepStrictEqual(payload, { person: ANN, categoryId: 'bedtime', periodKey: '2026-09-07', result: 'on_time', exp: nowMs + 2 * 24 * 3600 * 1000 });
});

test('dispatch: settles a weekly rollover and pays the unused-freeze bonus', async () => {
  // Monday 2026-09-14 17:00 Denver (23:00Z): the week of Sept 7 closes.
  const { ctx, store } = makeCtx({
    nowIso: '2026-09-14T23:00:00Z',
    ledger: [{ id: 'r1', timestamp: new Date(), type: 'entry', category: 'bedtime', periodKey: '2026-09-09', result: 'on_time', freezeUsed: false, amount: 0.25, balanceAfter: 0.25, actor: ANN, note: '' }],
    habitStates: [{ actor: ANN, category: 'bedtime', state: { streak: 1, periodStart: '2026-09-07', freezeRefresh: 'weekly', freezesUsedThisPeriod: 0, lastRecordedKey: '2026-09-09', since: '2026-08-31' } }],
  });
  await createService(ctx).dispatch();
  const bonus = store.readLedgerRows().filter((r) => r.type === 'bonus');
  assert.strictEqual(bonus.length, 1);
  assert.strictEqual(bonus[0].actor, ANN);
  assert.strictEqual(bonus[0].amount, 1);
  assert.strictEqual(store.statesAll()[ANN].cats.bedtime.periodStart, '2026-09-14');
});

test('dispatch: a failing send is reported, other categories still go out', async () => {
  const { ctx, sent } = makeCtx({ nowIso: '2026-09-09T03:00:00Z', categories: [BEDTIME, { ...BEDTIME, id: 'floss', name: 'Floss' }] });
  let n = 0;
  ctx.mail.send = async (m) => { if (n++ === 0) throw new Error('boom'); sent.push(m); };
  const r = await createService(ctx).dispatch();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.failures.length, 1);
  assert.match(r.failures[0], /reminder bedtime — boom/);
  // Bedtime's loop aborted on its first send; Floss still reached both people.
  assert.strictEqual(sent.length, 2);
  assert.ok(sent.every((m) => /Floss/.test(m.subject)));
});

test('checkup: records via a verified payload and reports already recorded', () => {
  const { ctx } = makeCtx();
  const svc = createService(ctx);
  const payload = { person: ANN, categoryId: 'bedtime', periodKey: '2026-09-07', result: 'on_time', exp: 9e15 };
  const r = svc.checkup(payload);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.event.amount, 0.25);
  assert.match(svc.checkup(payload).error, /already recorded/);
});
```

`mail.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { createResendMailer } from './mail.js';

test('posts to Resend with from, reply_to, and bearer auth', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '{}' }; };
  const mailer = createResendMailer({ apiKey: 'k', from: 'Homebase <homebase@samnichols.dev>', replyTo: 'snic9004@gmail.com', fetchImpl });
  await mailer.send({ to: 'a@x.com', subject: 'Hi', html: '<b>x</b>' });
  assert.strictEqual(calls[0].url, 'https://api.resend.com/emails');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer k');
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { from: 'Homebase <homebase@samnichols.dev>', to: ['a@x.com'], reply_to: 'snic9004@gmail.com', subject: 'Hi', html: '<b>x</b>' });
});

test('throws with the response body on a non-2xx', async () => {
  const fetchImpl = async () => ({ ok: false, status: 422, text: async () => 'bad from' });
  const mailer = createResendMailer({ apiKey: 'k', from: 'x@y.z', replyTo: '', fetchImpl });
  await assert.rejects(mailer.send({ to: 'a@x.com', subject: 's', html: 'h' }), /Resend 422: bad from/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement mail.js**

```js
// supabase/functions/_shared/mail.js
export function createResendMailer({ apiKey, from, replyTo, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  return {
    async send({ to, subject, html }) {
      const body = { from, to: Array.isArray(to) ? to : [to], subject, html };
      if (replyTo) body.reply_to = replyTo;
      const res = await doFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Resend ' + res.status + ': ' + (await res.text()));
    },
  };
}
```

- [ ] **Step 4: Port part 3 into service.js**

Port `money`, `currentHourStr` (use `tzHourStr(ctx.now())`), `emailDispatch` (1239-1278) as `async function dispatch()`, `sendReminder`, `sendChoreReminder`, `sendCheckup` (1303-1364) as async functions that `await ctx.mail.send(...)`.

`dispatch` returns instead of throwing:

```js
  async function dispatch() {
    const hour = tzHourStr(ctx.now());
    const dow = currentDow();
    const cats = activeHabits();
    const failures = [];
    const attempt = async (what, fn) => {
      try { await fn(); } catch (e) { failures.push(what + ' — ' + ((e && e.message) || e)); }
    };
    await attempt('refresh/sweep', async () => {
      cats.forEach(maybeRefresh);
      let rows = null;
      sweepChores(() => { if (rows === null) rows = store.readLedgerRows(); return rows; });
    });
    for (const cat of cats) {
      if (cat.reminderTime && cat.reminderTime === hour && E.shouldSendReminder(cat, dow)) {
        await attempt('reminder ' + cat.id, () => sendReminder(cat));
      }
      if (cat.checkupTime && cat.checkupTime === hour && E.shouldSendCheckup(cat, dow)) {
        await attempt('check-up ' + cat.id, () => sendCheckup(cat));
      }
    }
    if (!(chorePauseUntil() > todayStr())) {
      for (const cat of activeChores()) {
        if (cat.reminderTime && cat.reminderTime === hour) {
          await attempt('chore reminder ' + cat.id, () => sendChoreReminder(cat));
        }
      }
    }
    return { ok: failures.length === 0, failures };
  }
```

`sendCheckup` builds links with tokens instead of `sig`:

```js
  async function sendCheckup(cat) {
    const periodKey = recordablePeriodKey(cat);
    const btn = 'display:inline-block;padding:14px 22px;margin:6px 0;border-radius:10px;font-size:18px;text-decoration:none;color:#fff';
    const rows = store.readLedgerRows();
    const exp = ctx.now().getTime() + CHECKUP_TTL_MS;
    for (const to of store.allowlist()) {
      if (E.isPeriodRecorded(rows, to, cat.id, periodKey)) continue;
      const link = async (result) =>
        ctx.dashboardUrl + '?t=' + encodeURIComponent(await signToken({ person: to, categoryId: cat.id, periodKey, result, exp }, ctx.secret));
      const yesUrl = await link('on_time');
      const noUrl = await link('missed');
      const subject = 'Did you do ' + cat.name + '? ' + (cat.emoji || '');
      const html =
        '<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">' +
        '<h2>' + E.escapeHtml(cat.emoji || '☀️') + ' ' + E.escapeHtml(cat.name) + ' — ' + E.escapeHtml(periodKey) + '</h2>' +
        '<p><a href="' + yesUrl + '" style="' + btn + ';background:#2e7d32">✅ Yes</a></p>' +
        '<p><a href="' + noUrl + '" style="' + btn + ';background:#b00020">❌ No</a></p>' +
        '<p style="color:#666;font-size:13px">If you miss and still have a freeze, it\'s used automatically.</p></div>';
      await ctx.mail.send({ to, subject, html });
    }
  }
```

`checkup`:

```js
  function checkup(payload) {
    return recordFor(payload.person, payload.categoryId, payload.periodKey, payload.result);
  }
```

Return `{ route, recordFor, dispatch, checkup }`.

- [ ] **Step 5: Run to verify they pass**

Run: `npm test`
Expected: all passing. For the bonus test, if no bonus row appears, check `maybeRefresh` computes `hadEntries` with `E.periodHasEntries(cat, entryRowsFor(rows, email, cat.id), s.periodStart)` and that `currentMondayStr` returns `2026-09-14` at 17:00 Monday.

- [ ] **Step 6: Report**

Suggested commit: `Port hourly dispatch and one-tap check-up`.

---

### Task 8: Database schema, seed, pgTAP tests

**Files:**
- Create: `supabase/config.toml` (via `supabase init`), `supabase/migrations/0001_habits.sql`, `supabase/seed.sql`, `supabase/tests/0001_habits.sql`

**Interfaces:**
- Produces: tables `people`, `categories`, `ledger`, `habit_state`, `chore_state`, `settings`, `holidays`, all with RLS enabled and no client policies; trigger `enforce_allowlist` on `auth.users`.

- [ ] **Step 1: Initialize Supabase locally**

```bash
cd /mnt/c/Users/Snic9/homebase
supabase init        # answers: no to VS Code / IntelliJ settings
supabase start       # needs Docker; prints API URL, anon key, DB URL
```

If `supabase` is not installed: `npm i -g supabase` or see https://supabase.com/docs/guides/cli. Record the printed `DB URL` for Task 9.

- [ ] **Step 2: Write the pgTAP test**

```sql
-- supabase/tests/0001_habits.sql
begin;
select plan(10);

select has_table('public', 'people', 'people exists');
select has_table('public', 'categories', 'categories exists');
select has_table('public', 'ledger', 'ledger exists');
select has_table('public', 'habit_state', 'habit_state exists');
select has_table('public', 'chore_state', 'chore_state exists');
select has_table('public', 'settings', 'settings exists');
select has_table('public', 'holidays', 'holidays exists');

select col_type_is('public', 'ledger', 'amount', 'numeric(10,2)', 'ledger.amount is money');

-- RLS is on and nobody but the service role can read.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.ledger'::regclass),
  'ledger has RLS enabled'
);

-- Only allowlisted emails may become auth users.
insert into public.people (email, name) values ('ann@x.com', 'Ann');
select throws_ok(
  $$ insert into auth.users (id, email, instance_id, aud, role)
     values (gen_random_uuid(), 'stranger@x.com', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated') $$,
  'P0001',
  'signups are closed',
  'unknown email is rejected'
);

select * from finish();
rollback;
```

- [ ] **Step 3: Run to verify it fails**

Run: `supabase test db`
Expected: failures, tables do not exist.

- [ ] **Step 4: Write the migration**

```sql
-- supabase/migrations/0001_habits.sql
create extension if not exists pgtap with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create table public.people (
  email text primary key check (email = lower(email)),
  name text not null
);

create table public.categories (
  id text primary key,
  kind text not null check (kind in ('habit', 'chore')),
  name text not null,
  active boolean not null default true,
  config jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.ledger (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  type text not null check (type in ('entry', 'bonus', 'spend', 'deposit', 'claim', 'penalty')),
  category text,
  period_key text,
  result text,
  freeze_used boolean not null default false,
  amount numeric(10,2) not null default 0,
  balance_after numeric(10,2),
  actor text not null references public.people(email),
  note text not null default ''
);
create index ledger_actor_ts on public.ledger (actor, ts);
create index ledger_category_period on public.ledger (category, period_key);

create table public.habit_state (
  actor text not null references public.people(email),
  category text not null,
  state jsonb not null,
  primary key (actor, category)
);

create table public.chore_state (
  category text primary key,
  state jsonb not null
);

create table public.settings (
  key text primary key,
  value jsonb not null
);

create table public.holidays (
  day date primary key
);

-- Nothing is readable from the browser in phase 1; every access goes through
-- an edge function running as the service role.
alter table public.people enable row level security;
alter table public.categories enable row level security;
alter table public.ledger enable row level security;
alter table public.habit_state enable row level security;
alter table public.chore_state enable row level security;
alter table public.settings enable row level security;
alter table public.holidays enable row level security;

-- Signups are closed: only the two rows in people may authenticate.
create or replace function public.enforce_allowlist()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.people where email = lower(new.email)) then
    raise exception 'signups are closed';
  end if;
  return new;
end $$;

drop trigger if exists enforce_allowlist on auth.users;
create trigger enforce_allowlist
  before insert on auth.users
  for each row execute function public.enforce_allowlist();
```

- [ ] **Step 5: Write the seed**

```sql
-- supabase/seed.sql
insert into public.people (email, name) values
  ('snic9004@gmail.com', 'Sam'),
  ('sierra.author@gmail.com', 'Sierra')
on conflict do nothing;

insert into public.holidays (day) values
  ('2026-01-01'), ('2026-05-25'), ('2026-07-03'), ('2026-07-04'), ('2026-09-07'),
  ('2026-11-26'), ('2026-11-27'), ('2026-12-24'), ('2026-12-25'),
  ('2027-01-01'), ('2027-05-31'), ('2027-07-05'), ('2027-09-06'),
  ('2027-11-25'), ('2027-11-26'), ('2027-12-24'), ('2027-12-25')
on conflict do nothing;
```

- [ ] **Step 6: Apply and run tests**

```bash
supabase db reset     # applies migrations and seed
supabase test db
```

Expected: `All tests successful`, 10 tests.

- [ ] **Step 7: Report**

Suggested commit: `Add habits schema, allowlist trigger, and seed`.

---

### Task 9: Snapshot load and journal apply

**Files:**
- Create: `supabase/functions/_shared/pg.js`, `supabase/functions/deno.json`
- Test: `supabase/functions/_shared/pg.test.js`

**Interfaces:**
- Consumes: `createStore`, the schema.
- Produces: `runAction(sql, fn)` where `sql` is a postgres.js client. Opens a transaction, takes `pg_advisory_xact_lock(7461)`, loads the snapshot, builds a store, calls `await fn(store)`, applies `store.journal()`, commits, and returns `fn`'s result. Also exports `loadSnapshot(sql)` and `applyJournal(sql, journal)` for the migration script.
- Category rows: `categories.config` holds the full category object; `kind`, `name`, `active` are copied from it on write.

- [ ] **Step 1: Write the import map**

```json
// supabase/functions/deno.json
{
  "imports": {
    "postgres": "npm:postgres@3.4.5"
  }
}
```

Node resolves `postgres` from `node_modules`; Deno resolves it through this map.

- [ ] **Step 2: Write the failing test**

```js
// supabase/functions/_shared/pg.test.js
// Runs only against a local database: `DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test`
import test from 'node:test';
import assert from 'node:assert';
import postgres from 'postgres';
import { runAction, loadSnapshot } from './pg.js';

const DB_URL = process.env.DB_URL;

test('runAction loads a snapshot, applies the journal, and is serialized', { skip: !DB_URL && 'set DB_URL' }, async () => {
  const sql = postgres(DB_URL);
  try {
    await sql`delete from ledger`;
    await sql`delete from habit_state`;
    await sql`delete from chore_state`;
    await sql`delete from settings`;
    await sql`delete from categories`;
    await sql`insert into people (email, name) values ('ann@x.com', 'Ann'), ('bo@x.com', 'Bo') on conflict do nothing`;

    const out = await runAction(sql, (store) => {
      assert.ok(store.allowlist().includes('ann@x.com') && store.allowlist().includes('bo@x.com'));
      store.saveCategories([{ id: 'bedtime', kind: 'habit', name: 'Bedtime', active: true, cadence: 'daily', rewardIncrement: 0.25 }]);
      const id = store.appendLedger({ timestamp: new Date('2026-09-08T03:00:00Z'), type: 'entry', category: 'bedtime', periodKey: '2026-09-07', result: 'on_time', amount: 0.25, balanceAfter: 0.25, actor: 'ann@x.com' });
      store.appendLedger({ timestamp: new Date('2026-09-08T03:01:00Z'), type: 'spend', amount: 0.1, balanceAfter: 0.15, actor: 'ann@x.com', note: 'gum' });
      store.updateLedgerRow(id, { amount: 0.5, freezeUsed: true });
      const m = store.statesAll();
      m['ann@x.com'] = { cats: { bedtime: { streak: 1 } } };
      store.saveStatesAll(m);
      store.saveChoreStates({ dishes: { since: '2026-09-08' } });
      store.setSetting('chorePauseUntil', '2026-09-20');
      return { id };
    });

    const snap = await loadSnapshot(sql);
    assert.strictEqual(snap.categories.length, 1);
    assert.strictEqual(snap.categories[0].rewardIncrement, 0.25);
    assert.strictEqual(snap.ledger.length, 2);
    const entry = snap.ledger.find((r) => r.id === out.id);
    assert.strictEqual(Number(entry.amount), 0.5);
    assert.strictEqual(entry.freezeUsed, true);
    assert.strictEqual(entry.periodKey, '2026-09-07');
    assert.ok(snap.ledger[0].timestamp instanceof Date);
    assert.deepStrictEqual(snap.habitStates, [{ actor: 'ann@x.com', category: 'bedtime', state: { streak: 1 } }]);
    assert.deepStrictEqual(snap.choreStates, [{ category: 'dishes', state: { since: '2026-09-08' } }]);
    assert.strictEqual(snap.settings.chorePauseUntil, '2026-09-20');
    assert.ok(Array.isArray(snap.holidays));

    // delete and setting removal
    await runAction(sql, (store) => {
      store.deleteLedgerRow(out.id);
      store.deleteSetting('chorePauseUntil');
    });
    const snap2 = await loadSnapshot(sql);
    assert.strictEqual(snap2.ledger.length, 1);
    assert.strictEqual(snap2.settings.chorePauseUntil, undefined);

    // a throwing action rolls back
    await assert.rejects(runAction(sql, (store) => { store.setSetting('x', 1); throw new Error('nope'); }), /nope/);
    assert.strictEqual((await loadSnapshot(sql)).settings.x, undefined);
  } finally {
    await sql.end();
  }
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres node --test supabase/functions/_shared/pg.test.js`
Expected: FAIL, cannot find module `./pg.js`. (Without `DB_URL` the test is skipped; `npm test` stays green on machines without Docker.)

- [ ] **Step 4: Implement**

```js
// supabase/functions/_shared/pg.js
import { createStore } from './store.js';

const LOCK_KEY = 7461;

export async function loadSnapshot(sql) {
  const [people, cats, ledger, habit, chores, settings, holidays] = await Promise.all([
    sql`select email, name from people order by email`,
    sql`select config from categories order by id`,
    sql`select id, ts, type, category, period_key, result, freeze_used, amount, balance_after, actor, note from ledger order by ts, id`,
    sql`select actor, category, state from habit_state`,
    sql`select category, state from chore_state`,
    sql`select key, value from settings`,
    sql`select to_char(day, 'YYYY-MM-DD') as day from holidays`,
  ]);
  return {
    people,
    categories: cats.map((r) => r.config),
    ledger: ledger.map((r) => ({
      id: r.id, timestamp: r.ts, type: r.type, category: r.category, periodKey: r.period_key,
      result: r.result, freezeUsed: r.freeze_used, amount: Number(r.amount),
      balanceAfter: r.balance_after == null ? '' : Number(r.balance_after), actor: r.actor, note: r.note,
    })),
    habitStates: habit,
    choreStates: chores,
    settings: Object.fromEntries(settings.map((r) => [r.key, r.value])),
    holidays: holidays.map((r) => r.day),
  };
}

const COL = { freezeUsed: 'freeze_used', amount: 'amount', balanceAfter: 'balance_after', result: 'result', periodKey: 'period_key', note: 'note' };

export async function applyJournal(sql, journal) {
  for (const e of journal) {
    switch (e.op) {
      case 'append': {
        const r = e.row;
        await sql`insert into ledger (id, ts, type, category, period_key, result, freeze_used, amount, balance_after, actor, note)
          values (${r.id}, ${r.timestamp}, ${r.type}, ${r.category || null}, ${r.periodKey || null}, ${r.result || null},
                  ${r.freezeUsed === true}, ${r.amount}, ${r.balanceAfter === '' ? null : r.balanceAfter}, ${r.actor}, ${r.note || ''})`;
        break;
      }
      case 'update': {
        const patch = {};
        for (const k of Object.keys(e.patch)) {
          if (!COL[k]) continue;
          let v = e.patch[k];
          if (k === 'balanceAfter' && v === '') v = null;
          patch[COL[k]] = v;
        }
        if (Object.keys(patch).length) await sql`update ledger set ${sql(patch)} where id = ${e.id}`;
        break;
      }
      case 'delete':
        await sql`delete from ledger where id = ${e.id}`;
        break;
      case 'habitState':
        await sql`insert into habit_state (actor, category, state) values (${e.actor}, ${e.category}, ${sql.json(e.state)})
          on conflict (actor, category) do update set state = excluded.state`;
        break;
      case 'choreState':
        await sql`insert into chore_state (category, state) values (${e.category}, ${sql.json(e.state)})
          on conflict (category) do update set state = excluded.state`;
        break;
      case 'categories': {
        const ids = e.list.map((c) => c.id);
        for (const c of e.list) {
          await sql`insert into categories (id, kind, name, active, config, updated_at)
            values (${c.id}, ${c.kind === 'chore' ? 'chore' : 'habit'}, ${c.name}, ${c.active !== false}, ${sql.json(c)}, now())
            on conflict (id) do update set kind = excluded.kind, name = excluded.name, active = excluded.active, config = excluded.config, updated_at = now()`;
        }
        if (ids.length) await sql`delete from categories where id <> all(${ids})`;
        else await sql`delete from categories`;
        break;
      }
      case 'setting':
        if (e.value === null) await sql`delete from settings where key = ${e.key}`;
        else await sql`insert into settings (key, value) values (${e.key}, ${sql.json(e.value)}) on conflict (key) do update set value = excluded.value`;
        break;
      default:
        throw new Error('unknown journal op ' + e.op);
    }
  }
}

// One action, one transaction, serialized across all callers by an advisory
// lock so two simultaneous requests can't double-record or clobber saves.
export async function runAction(sql, fn) {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK_KEY})`;
    const store = createStore(await loadSnapshot(tx));
    const result = await fn(store);
    await applyJournal(tx, store.journal());
    return result;
  });
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test`
Expected: all passing including the pg test. Then `npm test` without `DB_URL`: the pg test reports skipped, everything else passes.

- [ ] **Step 6: Report**

Suggested commit: `Add snapshot load and journal apply for Postgres`.

---

### Task 10: Edge functions

**Files:**
- Create: `supabase/functions/_shared/cors.js`, `supabase/functions/_shared/env.js`, `supabase/functions/api/index.ts`, `supabase/functions/checkup/index.ts`, `supabase/functions/dispatch/index.ts`, `supabase/functions/.env.example`
- Modify: `supabase/config.toml` (function `verify_jwt` settings)

**Interfaces:**
- Consumes: `runAction`, `createService`, `createResendMailer`, `verifyToken`.
- Produces: HTTP endpoints.
  - `POST /functions/v1/api` with header `Authorization: Bearer <user JWT>` and JSON body `{ action, ...params }`. Response: the service's JSON. Unauthorized: `{ ok: false, error: 'not authorized — please log in again' }` with 401.
  - `POST /functions/v1/checkup` with JSON body `{ t }`. Response: the service's JSON, or `{ ok: false, error: 'this link has expired — open the dashboard instead' }`.
  - `POST /functions/v1/dispatch` with header `Authorization: Bearer <DISPATCH_SECRET>`. Response `{ ok, failures }`; 500 when `ok` is false so the cron log shows red.
- Environment (set with `supabase secrets set` in production, `supabase/functions/.env` locally): `CHECKUP_SECRET`, `DISPATCH_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_REPLY_TO`, `DASHBOARD_URL`, `ALLOWED_ORIGINS`. Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL` automatically.

- [ ] **Step 1: Shared helpers**

```js
// supabase/functions/_shared/cors.js
export function corsHeaders(req, allowedOrigins) {
  const origin = req.headers.get('origin') || '';
  const allow = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

export function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}
```

```js
// supabase/functions/_shared/env.js
// Deno-only. Reads the function environment once.
export function readEnv() {
  const get = (k, dflt) => {
    const v = Deno.env.get(k);
    if (v == null || v === '') {
      if (dflt !== undefined) return dflt;
      throw new Error('missing env ' + k);
    }
    return v;
  };
  return {
    dbUrl: get('SUPABASE_DB_URL'),
    supabaseUrl: get('SUPABASE_URL'),
    anonKey: get('SUPABASE_ANON_KEY'),
    checkupSecret: get('CHECKUP_SECRET'),
    dispatchSecret: get('DISPATCH_SECRET'),
    resendKey: get('RESEND_API_KEY'),
    mailFrom: get('MAIL_FROM'),
    mailReplyTo: get('MAIL_REPLY_TO', ''),
    dashboardUrl: get('DASHBOARD_URL'),
    allowedOrigins: get('ALLOWED_ORIGINS').split(',').map((s) => s.trim()),
  };
}
```

`supabase/functions/.env.example` (copy to `.env`, which is gitignored):

```
CHECKUP_SECRET=change-me-32-random-chars
DISPATCH_SECRET=change-me-too
RESEND_API_KEY=re_xxx
MAIL_FROM=Homebase <homebase@samnichols.dev>
MAIL_REPLY_TO=snic9004@gmail.com
DASHBOARD_URL=http://localhost:8000/
ALLOWED_ORIGINS=http://localhost:8000,https://homebase.samnichols.dev
```

- [ ] **Step 2: api function**

```ts
// supabase/functions/api/index.ts
import postgres from 'postgres';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { readEnv } from '../_shared/env.js';
import { corsHeaders, json } from '../_shared/cors.js';
import { runAction } from '../_shared/pg.js';
import { createService } from '../_shared/service.js';
import { createResendMailer } from '../_shared/mail.js';

const env = readEnv();
const sql = postgres(env.dbUrl, { max: 2, prepare: false });
const mail = createResendMailer({ apiKey: env.resendKey, from: env.mailFrom, replyTo: env.mailReplyTo });

Deno.serve(async (req) => {
  const cors = corsHeaders(req, env.allowedOrigins);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405, cors);

  const auth = req.headers.get('Authorization') || '';
  const supa = createClient(env.supabaseUrl, env.anonKey, { global: { headers: { Authorization: auth } } });
  const { data, error } = await supa.auth.getUser();
  if (error || !data?.user?.email) {
    return json({ ok: false, error: 'not authorized — please log in again' }, 401, cors);
  }

  let p: Record<string, unknown> = {};
  try { p = await req.json(); } catch { /* empty body is fine */ }
  p.user = data.user.email.toLowerCase();

  try {
    const result = await runAction(sql, (store) =>
      createService({ store, now: () => new Date(), mail, dashboardUrl: env.dashboardUrl, secret: env.checkupSecret }).route(p),
    );
    return json(result, 200, cors);
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    return json({ ok: false, error: msg }, /not authorized/.test(msg) ? 401 : 500, cors);
  }
});
```

- [ ] **Step 3: checkup function**

```ts
// supabase/functions/checkup/index.ts
import postgres from 'postgres';
import { readEnv } from '../_shared/env.js';
import { corsHeaders, json } from '../_shared/cors.js';
import { runAction } from '../_shared/pg.js';
import { createService } from '../_shared/service.js';
import { verifyToken } from '../_shared/token.js';
import { createResendMailer } from '../_shared/mail.js';

const env = readEnv();
const sql = postgres(env.dbUrl, { max: 2, prepare: false });
const mail = createResendMailer({ apiKey: env.resendKey, from: env.mailFrom, replyTo: env.mailReplyTo });

Deno.serve(async (req) => {
  const cors = corsHeaders(req, env.allowedOrigins);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405, cors);
  let body: { t?: string } = {};
  try { body = await req.json(); } catch { /* fallthrough */ }
  const payload = await verifyToken(body.t, env.checkupSecret, Date.now());
  if (!payload) return json({ ok: false, error: 'this link has expired — open the dashboard instead' }, 200, cors);
  try {
    const result = await runAction(sql, (store) =>
      createService({ store, now: () => new Date(), mail, dashboardUrl: env.dashboardUrl, secret: env.checkupSecret }).checkup(payload),
    );
    return json(result, 200, cors);
  } catch (err) {
    return json({ ok: false, error: String((err as Error)?.message || err) }, 500, cors);
  }
});
```

- [ ] **Step 4: dispatch function**

```ts
// supabase/functions/dispatch/index.ts
import postgres from 'postgres';
import { readEnv } from '../_shared/env.js';
import { runAction } from '../_shared/pg.js';
import { createService } from '../_shared/service.js';
import { createResendMailer } from '../_shared/mail.js';

const env = readEnv();
const sql = postgres(env.dbUrl, { max: 2, prepare: false });
const mail = createResendMailer({ apiKey: env.resendKey, from: env.mailFrom, replyTo: env.mailReplyTo });

Deno.serve(async (req) => {
  if ((req.headers.get('Authorization') || '') !== 'Bearer ' + env.dispatchSecret) {
    return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403 });
  }
  const result = await runAction(sql, (store) =>
    createService({ store, now: () => new Date(), mail, dashboardUrl: env.dashboardUrl, secret: env.checkupSecret }).dispatch(),
  );
  console.log('dispatch', JSON.stringify(result));
  return new Response(JSON.stringify(result), { status: result.ok ? 200 : 500, headers: { 'Content-Type': 'application/json' } });
});
```

Note: mail must NOT be sent inside the transaction. `dispatch/index.ts` passes a queueing mailer into `runAction`, and sends the queued messages through Resend only after the transaction commits, merging any send failures into `failures`. That keeps settlement under the lock and mail outside it, as the Apps Script did (lock around refresh/sweep, mail after), and other requests never wait on Resend. Phase 2's Plaid sync must follow the same rule: network calls outside `runAction`, only the resulting rows inside.

- [ ] **Step 5: Turn off gateway JWT checks for the two public functions**

Append to `supabase/config.toml`:

```toml
[functions.api]
import_map = "./functions/deno.json"

[functions.checkup]
verify_jwt = false
import_map = "./functions/deno.json"

[functions.dispatch]
verify_jwt = false
import_map = "./functions/deno.json"
```

`api` keeps the default (`verify_jwt = true`), and also checks the user itself. The `import_map` lines point every function at the shared map from Step 1 so `import postgres from 'postgres'` resolves.

- [ ] **Step 6: Smoke test locally**

```bash
cp supabase/functions/.env.example supabase/functions/.env   # fill RESEND_API_KEY with a real key or leave re_xxx
supabase functions serve --env-file supabase/functions/.env
```

In another shell, with the anon key from `supabase status`:

```bash
ANON=$(supabase status -o json | python3 -c 'import sys,json;print(json.load(sys.stdin)["ANON_KEY"])')
# dispatch: wrong secret is forbidden
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:54321/functions/v1/dispatch
# expected: 403
# dispatch: right secret runs (mail will fail with a fake Resend key; that's the failures list)
curl -s -X POST -H 'Authorization: Bearer change-me-too' http://127.0.0.1:54321/functions/v1/dispatch
# expected: {"ok":true,"failures":[]}  (no category is scheduled at this hour)
# checkup: garbage token
curl -s -X POST -H "apikey: $ANON" -H 'Content-Type: application/json' -d '{"t":"junk"}' http://127.0.0.1:54321/functions/v1/checkup
# expected: {"ok":false,"error":"this link has expired — open the dashboard instead"}
# api: no JWT
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "apikey: $ANON" http://127.0.0.1:54321/functions/v1/api -d '{"action":"state"}'
# expected: 401
```

To exercise `api` with a real session, create a local user and sign in through the frontend in Task 11; the allowlist trigger means the email must be in `people` (seeded).

- [ ] **Step 7: Report**

Suggested commit: `Add api, checkup, and dispatch edge functions`.

---

### Task 11: Frontend on Supabase

**Files:**
- Create: `js/api.js`, `js/config.js`
- Modify: `js/app.js`, `index.html`, `css/style.css`

**Interfaces:**
- Consumes: the three functions.
- Produces: `js/api.js` exporting `api(action, extra)`, `checkup(t)`, `requestLogin(email)`, `getSession()`, `signOut()`, `onAuthChange(cb)`. `js/app.js` becomes a module that imports these.

- [ ] **Step 1: config.js**

```js
// js/config.js
window.CONFIG = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: 'paste the anon key from `supabase status`',
};
```

Production values are swapped in during Task 13. Both are public by design.

- [ ] **Step 2: api.js**

```js
// js/api.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const cfg = window.CONFIG || {};
export const configured = () => /^https?:\/\//.test(cfg.SUPABASE_URL || '') && !!cfg.SUPABASE_ANON_KEY && !/paste/.test(cfg.SUPABASE_ANON_KEY);

const supabase = configured() ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
const fnUrl = (name) => cfg.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/' + name;

async function post(name, body, token) {
  if (!supabase) throw new Error('Backend not configured (set SUPABASE_URL and SUPABASE_ANON_KEY in js/config.js)');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(fnUrl(name), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + (token || cfg.SUPABASE_ANON_KEY),
      },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Network timeout — check your connection' : 'Could not reach the backend');
  } finally {
    clearTimeout(timer);
  }
  let data;
  try { data = await res.json(); } catch { throw new Error('Backend returned an unreadable response'); }
  return data;
}

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

export async function api(action, extra) {
  const session = await getSession();
  if (!session) return { ok: false, error: 'not authorized — please log in again' };
  return post('api', Object.assign({ action }, extra || {}), session.access_token);
}

export const checkup = (t) => post('checkup', { t });

export async function requestLogin(email) {
  if (!supabase) throw new Error('Backend not configured');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin + location.pathname },
  });
  // Unknown emails are rejected by the database trigger; say the same thing
  // either way so the allowlist can't be probed.
  if (error && !/signups are closed|Database error/i.test(error.message)) throw new Error(error.message);
}

export const signOut = () => (supabase ? supabase.auth.signOut() : Promise.resolve());
export const onAuthChange = (cb) => supabase && supabase.auth.onAuthStateChange((_evt, session) => cb(session));
```

- [ ] **Step 3: Edit app.js**

Make these edits to `js/app.js` (line numbers from the source copy):

1. At the very top add:
   ```js
   import { api, checkup, requestLogin, getSession, signOut, onAuthChange, configured } from './api.js';
   ```
2. Delete the token helpers (lines 38-40: `getToken`, `setToken`, `clearToken`) and the JSONP client (lines 72-119: `jsonpSeq`, `jsonp`, `api`, and `configured` if defined there).
3. `setView` (line 66): replace `$('logoutBtn').hidden = !getToken();` with `$('logoutBtn').hidden = !SIGNED_IN;` and add `let SIGNED_IN = false;` near `CAT_LIST`.
4. `showDashboard` (line 387): replace the `clearToken(); setView('login');` branch with `await signOut(); SIGNED_IN = false; setView('login');`. Before `const r = await api('state');` add the cached render:
   ```js
   try {
     const cached = JSON.parse(localStorage.getItem('hb_state') || 'null');
     if (cached && !keepBanner) { render(cached); banner('Refreshing…', false); }
   } catch { /* ignore */ }
   ```
   and after a successful response, before `render(r)`: `try { localStorage.setItem('hb_state', JSON.stringify(r)); } catch { /* ignore */ }`.
5. `checkinFlow` / `recordViaSig` (lines 540-568): replace both with
   ```js
   async function checkinFlow(t) {
     setView('checkin');
     $('checkinTitle').textContent = 'Check-in';
     $('checkinBody').textContent = 'Recording your answer…';
     $('checkinResult').hidden = false;
     $('checkinResult').textContent = 'Saving…';
     try {
       const r = await checkup(t);
       const res = $('checkinResult');
       if (!r.ok) {
         res.textContent = /already recorded/i.test(r.error || '') ? '✅ Already recorded.' : '⚠️ ' + (r.error || 'Could not save');
       } else {
         const e = r.event;
         $('checkinTitle').textContent = 'Check-in: ' + e.periodKey;
         if (e.result === 'on_time') res.textContent = '🎉 Recorded! Earned ' + money(e.amount) + '. Wallet: ' + money(r.wallet) + '.';
         else if (e.freezeUsed) res.textContent = '❄️ Freeze used — streak protected.';
         else res.textContent = 'Streak reset. Fresh start 💪 Wallet: ' + money(r.wallet) + '.';
       }
     } catch (err) {
       $('checkinResult').textContent = '⚠️ ' + err.message;
     }
     $('checkinDoneBtn').hidden = false;
   }
   ```
6. Login form handler (line 675): replace `await jsonp({ action: 'requestLogin', email });` with `await requestLogin(email);`.
7. Logout handler (line 687): replace `clearToken();` with `await signOut(); SIGNED_IN = false;` and make the handler `async`.
8. Delete the deposit form handler (the block starting at line 717 that calls `api('deposit', ...)`).
9. `boot` (line 790 onward): replace from `const qp = new URLSearchParams(location.search);` to the end of the function with
   ```js
     const qp = new URLSearchParams(location.search);
     const t = qp.get('t');
     if (t) {
       history.replaceState({}, '', location.origin + location.pathname);
       checkinFlow(t);
       return;
     }
     // Supabase puts the magic-link session in the URL hash; the client
     // consumes it and fires onAuthChange.
     const session = await getSession();
     SIGNED_IN = !!session;
     if (location.hash) history.replaceState({}, '', location.origin + location.pathname);
     if (SIGNED_IN) showDashboard(); else setView('login');
     onAuthChange((s) => {
       const was = SIGNED_IN;
       SIGNED_IN = !!s;
       if (SIGNED_IN && !was) showDashboard();
     });
   ```
   and make `boot` `async`. Update the "not configured" banner text to mention `js/config.js` Supabase values.
10. Update the STALE_BACKEND_MSG constant if it names Apps Script; say "backend" instead.

- [ ] **Step 4: Edit index.html**

- Change the two script tags at the bottom to:
  ```html
  <script src="js/config.js"></script>
  <script type="module" src="js/app.js"></script>
  ```
- Delete the "Add money" form (`depositForm` and its inputs) from the dashboard section. Search for `deposit` and remove the whole form element and any heading tied to it.
- Change the login copy from "login link is on its way" style text if it mentions 90 days; Supabase links expire in an hour but the session persists.

- [ ] **Step 5: Style**

In `css/style.css`, remove any rule that only targeted the deposit form. Add a tablet breakpoint after the existing 430px one:

```css
@media (min-width: 700px) {
  .wrap { max-width: 680px; }
}
```

(Match the actual wrapper class used in `index.html`; the source uses a 560px max-width on it at line 34.)

- [ ] **Step 6: Run it locally**

```bash
# terminal 1
supabase start && supabase functions serve --env-file supabase/functions/.env
# terminal 2, from the repo root
python3 -m http.server 8000
```

Open http://localhost:8000. Enter `snic9004@gmail.com`. Local Supabase does not send real mail; open the Inbucket UI printed by `supabase status` (usually http://127.0.0.1:54324), open the message, click the link. Expected: the dashboard loads with zero categories and wallet $0.00. Add a habit under Categories, record it, spend, undo the spend, archive it. Each action should return in well under a second. Reload: the cached state renders immediately, then refreshes.

Check-in: run `supabase functions serve` logs while calling dispatch at a category's check-up hour is impractical; instead sign a token by hand:

```bash
node -e "import('./supabase/functions/_shared/token.js').then(async m => console.log(await m.signToken({person:'snic9004@gmail.com',categoryId:'<your habit id>',periodKey:'<yesterday YYYY-MM-DD>',result:'on_time',exp:Date.now()+3600e3}, 'change-me-32-random-chars')))"
```

Open `http://localhost:8000/?t=<token>`. Expected: "Recorded! Earned $…". Open it again: "Already recorded."

- [ ] **Step 7: Report**

Suggested commit: `Move frontend to Supabase auth and functions`.

---

### Task 12: Migration from the Sheet

**Files:**
- Create: `scripts/dump-props.gs`, `scripts/migrate-from-sheet.js`
- Test: `scripts/migrate-from-sheet.test.js`

**Interfaces:**
- Consumes: `loadSnapshot`, `applyJournal`, `createStore`, `E.deriveWallet`.
- Produces: `parseLedgerCsv(text) -> rows` and `buildJournal(rows, props) -> journal` (pure, tested), plus a CLI: `node scripts/migrate-from-sheet.js --ledger scripts/data/ledger.csv --props scripts/data/props.json --db "$DB_URL" [--apply]`. Without `--apply` it prints counts and each person's derived wallet and writes nothing.

- [ ] **Step 1: The Apps Script export snippet**

```js
// scripts/dump-props.gs
// Paste into the Apps Script editor, run once, copy the log output into
// scripts/data/props.json.
function dumpProps() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var out = {
    states: JSON.parse(all.states || '{}'),
    choreStates: JSON.parse(all.choreStates || '{}'),
    categories: JSON.parse(all.categories || '[]'),
    chorePauseUntil: all.chorePauseUntil || '',
  };
  Logger.log(JSON.stringify(out));
}
```

The ledger comes from the Sheet: File, Download, Comma-separated values, saved as `scripts/data/ledger.csv`. Its header row is `id,timestamp,type,category,periodKey,result,freezeUsed,amount,balanceAfter,actor,note`.

- [ ] **Step 2: Write the failing test**

```js
// scripts/migrate-from-sheet.test.js
import test from 'node:test';
import assert from 'node:assert';
import { parseLedgerCsv, buildJournal } from './migrate-from-sheet.js';

const csv = [
  'id,timestamp,type,category,periodKey,result,freezeUsed,amount,balanceAfter,actor,note',
  '11111111-1111-1111-1111-111111111111,2026-06-20 21:05:11,entry,bedtime,2026-06-19,on_time,FALSE,0.25,0.25,snic9004@gmail.com,',
  '22222222-2222-2222-2222-222222222222,2026-06-21 09:00:00,entry,bedtime,6/20/2026,missed,TRUE,0,0.25,snic9004@gmail.com,',
  '33333333-3333-3333-3333-333333333333,2026-06-22 12:00:00,spend,,,,FALSE,1.5,0,snic9004@gmail.com,"coffee, large"',
].join('\n');

test('parseLedgerCsv handles quoted commas, TRUE/FALSE, and Sheets-mangled dates', () => {
  const rows = parseLedgerCsv(csv);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].freezeUsed, false);
  assert.strictEqual(rows[1].freezeUsed, true);
  assert.strictEqual(rows[1].periodKey, '2026-06-20');
  assert.strictEqual(rows[2].note, 'coffee, large');
  assert.strictEqual(rows[2].category, '');
  assert.ok(rows[0].timestamp instanceof Date);
  assert.strictEqual(rows[0].amount, 0.25);
});

test('buildJournal emits categories, ledger appends, states, and settings', () => {
  const props = {
    states: { 'snic9004@gmail.com': { cats: { bedtime: { streak: 1 } } } },
    choreStates: { dishes: { since: '2026-09-01', sweepFrom: '2026-09-01', chargedThrough: '2026-09-07' } },
    categories: [{ id: 'bedtime', name: 'Bedtime', cadence: 'daily', rewardIncrement: 0.25, maxPerInstance: 5, freezesPerPeriod: 1, freezeRefresh: 'weekly', active: true }],
    chorePauseUntil: '2026-09-20',
  };
  const j = buildJournal(parseLedgerCsv(csv), props);
  assert.strictEqual(j.filter((e) => e.op === 'categories').length, 1);
  assert.strictEqual(j.filter((e) => e.op === 'append').length, 3);
  assert.deepStrictEqual(j.find((e) => e.op === 'habitState'), { op: 'habitState', actor: 'snic9004@gmail.com', category: 'bedtime', state: { streak: 1 } });
  assert.deepStrictEqual(j.find((e) => e.op === 'choreState'), { op: 'choreState', category: 'dishes', state: props.choreStates.dishes });
  assert.deepStrictEqual(j.find((e) => e.op === 'setting'), { op: 'setting', key: 'chorePauseUntil', value: '2026-09-20' });
  // Categories are normalized so kind is explicit.
  assert.strictEqual(j.find((e) => e.op === 'categories').list[0].kind, 'habit');
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test scripts/`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Implement**

```js
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

function parseStamp(v) {
  // "2026-06-20 21:05:11" is Denver local time in the Sheet; treat as such.
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?/.exec(v || '');
  if (m) {
    // Build the UTC instant for that Denver wall-clock time.
    const guess = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
    const denver = new Date(guess.toLocaleString('en-US', { timeZone: 'America/Denver' }));
    return new Date(guess.getTime() + (guess.getTime() - denver.getTime()));
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
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test`
Expected: all passing.

- [ ] **Step 6: Rehearse against local**

Export the real CSV and props into `scripts/data/` (gitignored). Then:

```bash
supabase db reset
DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
node scripts/migrate-from-sheet.js --ledger scripts/data/ledger.csv --props scripts/data/props.json --db "$DB_URL"
# compare the printed wallets to the live dashboard; they must match to the cent
node scripts/migrate-from-sheet.js --ledger scripts/data/ledger.csv --props scripts/data/props.json --db "$DB_URL" --apply
```

Reload the local frontend from Task 11. Expected: same streaks, freezes, wallet, and recent activity as the live site. If a period key looks like `Tue Jun 20 2026`, the CSV export mangled it differently than `fixPeriodKey` expects; extend the regex and rerun after `supabase db reset`.

- [ ] **Step 7: Report**

Suggested commit: `Add ledger and properties import from Apps Script`.

---

### Task 13: Production runbook and cutover

This task is operations, not code, apart from `supabase/cron.sql` and the README. Each step is done by the user or with the user present, since it touches accounts the agent does not hold.

**Files:**
- Create: `supabase/cron.sql`
- Modify: `README.md`, `js/config.js`

- [ ] **Step 1: Write the cron template**

```sql
-- supabase/cron.sql
-- Run once in the Supabase SQL editor after the first deploy. Replace the two
-- placeholders. Not a migration: the URL and secret differ per environment.
select cron.unschedule('homebase-dispatch') where exists (select 1 from cron.job where jobname = 'homebase-dispatch');
select cron.schedule(
  'homebase-dispatch',
  '0 * * * *',
  $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/dispatch',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer DISPATCH_SECRET"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
-- Check it ran: select * from cron.job_run_details order by start_time desc limit 5;
```

- [ ] **Step 2: Write the runbook into README.md**

Append this section verbatim:

```markdown
## Production setup (once)

1. **Supabase project.** supabase.com, New project, region US West, note the
   project ref and database password. Then locally:

       supabase link --project-ref PROJECT_REF
       supabase db push
       psql "$PROD_DB_URL" -f supabase/seed.sql

2. **Resend.** resend.com, Domains, add `samnichols.dev`, add the TXT and
   CNAME records it shows at your DNS host, wait for Verified. Create an API
   key with sending access.

3. **Auth email through Resend.** Supabase dashboard, Authentication, SMTP
   Settings: host `smtp.resend.com`, port 465, user `resend`, password = the
   API key, sender `homebase@samnichols.dev`, sender name `Homebase`.
   Authentication, URL Configuration: Site URL
   `https://homebase.samnichols.dev`, add the same to Redirect URLs. Under
   Providers, Email: keep Email enabled and leave "Allow new users to sign
   up" ON. The first magic link creates each auth user, and the
   `enforce_allowlist` trigger is what rejects anyone not in `people`.
   Set OTP expiry to 3600.

4. **Function secrets.**

       openssl rand -hex 32   # CHECKUP_SECRET
       openssl rand -hex 32   # DISPATCH_SECRET
       supabase secrets set CHECKUP_SECRET=... DISPATCH_SECRET=... \
         RESEND_API_KEY=re_... 'MAIL_FROM=Homebase <homebase@samnichols.dev>' \
         MAIL_REPLY_TO=snic9004@gmail.com \
         DASHBOARD_URL=https://homebase.samnichols.dev/ \
         ALLOWED_ORIGINS=https://homebase.samnichols.dev
       supabase functions deploy api
       supabase functions deploy checkup --no-verify-jwt
       supabase functions deploy dispatch --no-verify-jwt

5. **Cron.** Open `supabase/cron.sql`, fill in PROJECT_REF and
   DISPATCH_SECRET, run it in the SQL editor. Next hour, check
   `cron.job_run_details` shows status `succeeded`.

6. **Frontend.** Put the project URL and anon key (Settings, API) in
   `js/config.js`. Push to GitHub. Repo Settings, Pages: deploy from `main`,
   root. Custom domain `homebase.samnichols.dev`, enforce HTTPS. At your
   DNS host add `CNAME homebase -> snicker7.github.io`.

7. **Migrate.** Run `dumpProps` in Apps Script, save the log as
   `scripts/data/props.json`; download the Ledger tab as
   `scripts/data/ledger.csv`. Then:

       node scripts/migrate-from-sheet.js --ledger scripts/data/ledger.csv \
         --props scripts/data/props.json --db "$PROD_DB_URL"          # dry run
       node scripts/migrate-from-sheet.js ... --db "$PROD_DB_URL" --apply

   Both wallets must match the old dashboard to the cent.

8. **Cut over.** In Apps Script, Triggers, delete the hourly `emailDispatch`
   trigger. Log in at homebase.samnichols.dev on both phones. Leave the
   Sheet as a read-only backup.
```

- [ ] **Step 3: Verify in production**

After step 8 of the runbook, with the user:

- Record today's answer on one habit from the dashboard. Expected under one second.
- Wait for the next reminder hour; both inboxes receive one email from `Homebase <homebase@samnichols.dev>` with Reply-To the Gmail address.
- Tap a check-up link from a phone; the check-in view shows the recorded result; a second tap says already recorded.
- Supabase dashboard, Edge Functions, Logs: the hourly `dispatch` line shows `{"ok":true,"failures":[]}`.

- [ ] **Step 4: Retire the old app**

In the `samsite` repo, the user decides whether to delete `habits/` or leave a redirect page at `habits/index.html` pointing to `https://homebase.samnichols.dev/`. Recommend the redirect, since old check-up emails still link there.

- [ ] **Step 5: Report**

Suggested commit: `Add production runbook and cron template`.

---

## Self-review

**Spec coverage.** Architecture (Tasks 9, 10), edge functions `api`/`checkup`/`dispatch` (10), repo layout (1, 10), people/categories/ledger/habit_state/chore_state/settings/holidays (8), login through Supabase magic link with allowlist trigger (8, 11), record flow with lock and journal (6, 9), dashboard read through `api` with cached render (5, 11), hourly dispatch via cron and Resend with Reply-To (7, 13), one-tap check-up with signed two-day tokens (3, 7, 10, 11), deposit removed (6, 11), migration and cutover (12, 13), failure handling: structured errors, retry-safe writes, cached banner (10, 11), testing: engine, service, token, pg, pgTAP (1 to 9), DNS and Pages (13). Not in phase 1 by design: budget tables, views, Plaid, direct table reads.

**Placeholders.** Task 5 and 6 point at `main.gs` line ranges for the bulk of the port rather than repeating 900 lines; the substitution table and the three worked examples (`catStateOf`, `recordEntry` frame, `replayAndSave` tail) define the transformation completely. Every other code step is full code.

**Type consistency.** `ctx` is `{ store, now, mail, dashboardUrl, secret }` in testkit, service, and all three functions. Journal ops in `store.js`, `pg.js`, and `migrate-from-sheet.js` share the same seven names. `verifyToken(token, secret, nowMs)` matches its callers in `checkup/index.ts` and the dispatch test. `runAction(sql, fn)` matches its three callers. `recordFor(person, categoryId, periodKey, result)` matches `checkup(payload)`.
