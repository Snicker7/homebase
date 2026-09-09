import test from 'node:test';
import assert from 'node:assert';
import { createService } from './service.js';
import { makeCtx, ANN, BO, BEDTIME, DISHES } from './testkit.js';
import { verifyToken } from './token.js';

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

test('claim together: splits the payout into one row per person', () => {
  const { ctx, store } = makeCtx({ categories: [DISHES] });
  const svc = createService(ctx);
  svc.route({ action: 'state', user: ANN });
  const r = svc.route({ action: 'claim', user: ANN, categoryId: 'dishes', together: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.wallet, 1);
  assert.strictEqual(r.event.amount, 1);
  assert.strictEqual(r.event.together, true);
  const claims = store.readLedgerRows().filter((x) => x.type === 'claim');
  assert.deepStrictEqual(claims.map((x) => [x.actor, x.amount, x.balanceAfter]).sort(), [[ANN, 1, 1], [BO, 1, 1]]);
  assert.strictEqual(svc.route({ action: 'state', user: BO }).wallet, 1);
  assert.strictEqual(svc.route({ action: 'state', user: BO }).chores[0].claimedBy, 'Ann & Bo');
  assert.match(svc.route({ action: 'claim', user: BO, categoryId: 'dishes' }).error, /already done/);
});

test('claim together: the tapper keeps the odd cent', () => {
  const { ctx, store } = makeCtx({ categories: [{ ...DISHES, value: 2.01 }] });
  const svc = createService(ctx);
  svc.route({ action: 'state', user: BO });
  const r = svc.route({ action: 'claim', user: BO, categoryId: 'dishes', together: true });
  assert.strictEqual(r.wallet, 1.01);
  const claims = store.readLedgerRows().filter((x) => x.type === 'claim');
  assert.deepStrictEqual(claims.map((x) => [x.actor, x.amount]).sort(), [[ANN, 1], [BO, 1.01]]);
});

test('claim together: refused on an assigned chore', () => {
  const { ctx } = makeCtx({ categories: [{ ...DISHES, assignee: ANN }] });
  const svc = createService(ctx);
  svc.route({ action: 'state', user: ANN });
  const r = svc.route({ action: 'claim', user: ANN, categoryId: 'dishes', together: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /assigned/);
});

/* ── fortnightly chores ────────────────────────────────────────────────── */
const BINS = { id: 'bins', kind: 'chore', name: 'Bins', emoji: '🗑️', cadence: 'biweekly', value: 4, assignee: '', dueDate: '', dueDay: '', notes: '', reminderTime: '', active: true };

test('biweekly chore: an undone fortnight drains onto its key and stays claimable next fortnight', () => {
  // W35 ran Aug 24 – Sep 6; today is Tue Sep 8, inside W37.
  const { ctx, store } = makeCtx({
    categories: [BINS],
    choreStates: [{ category: 'bins', state: { since: '2026-W35', sweepFrom: '2026-W35', chargedThrough: '2026-09-06' } }],
  });
  const svc = createService(ctx);
  const st = svc.route({ action: 'state', user: ANN });
  assert.strictEqual(st.chores[0].claimablePeriodKey, '2026-W37');
  const penalties = store.readLedgerRows().filter((r) => r.type === 'penalty');
  assert.ok(penalties.length > 0);
  assert.ok(penalties.every((r) => r.periodKey === '2026-W35'));
  assert.deepStrictEqual(st.chores[0].outstanding.map((o) => o.periodKey), ['2026-W35']);
  const r = svc.route({ action: 'claim', user: ANN, categoryId: 'bins', periodKey: '2026-W35' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.event.pot > 0);
  assert.strictEqual(r.event.amount, 4 + r.event.pot);
});

/* ── morning chore digest ──────────────────────────────────────────────── */
// 08:00 Denver on Tue 2026-09-08 is 14:00Z.
const DIGEST_HOUR = '2026-09-08T14:00:00Z';
const TRASH = { ...DISHES, id: 'trash', name: 'Trash', emoji: '🗑️', value: 1, assignee: BO };

test('digest: one morning email each, listing own and shared chores due today', async () => {
  const { ctx, sent } = makeCtx({ nowIso: DIGEST_HOUR, categories: [DISHES, TRASH] });
  const r = await createService(ctx).dispatch();
  assert.deepStrictEqual(r, { ok: true, failures: [] });
  assert.strictEqual(sent.length, 2);
  const to = (who) => sent.find((m) => m.to === who);
  assert.match(to(ANN).subject, /Dishes/);
  assert.doesNotMatch(to(ANN).subject, /Trash/);
  assert.match(to(BO).subject, /Dishes/);
  assert.match(to(BO).subject, /Trash/);
  assert.match(to(BO).html, /\$2\.00/);
});

test('digest: claimed chores drop out, and nobody is mailed when nothing is due', async () => {
  const claimed = { id: 'c1', timestamp: new Date('2026-09-08T13:00:00Z'), type: 'claim', category: 'dishes', periodKey: '2026-09-08', result: '', freezeUsed: false, amount: 2, balanceAfter: 2, actor: BO, note: '' };
  const { ctx, sent } = makeCtx({ nowIso: DIGEST_HOUR, categories: [DISHES], ledger: [claimed] });
  await createService(ctx).dispatch();
  assert.strictEqual(sent.length, 0);
});

test('digest: a waiting pot is mentioned', async () => {
  const { ctx, sent } = makeCtx({
    nowIso: DIGEST_HOUR, categories: [DISHES],
    choreStates: [{ category: 'dishes', state: { since: '2026-09-06', sweepFrom: '2026-09-06', chargedThrough: '2026-09-06' } }],
  });
  await createService(ctx).dispatch();
  assert.strictEqual(sent.length, 2);
  assert.match(sent[0].html, /pot/i);
});

test('digest: silent while chores are paused', async () => {
  const { ctx, sent } = makeCtx({ nowIso: DIGEST_HOUR, categories: [DISHES], settings: { chorePauseUntil: '2026-09-20' } });
  await createService(ctx).dispatch();
  assert.strictEqual(sent.length, 0);
});

test('digest: fires at the configured hour, and per-chore reminder hours no longer send', async () => {
  const nine = makeCtx({ nowIso: DIGEST_HOUR, categories: [DISHES], settings: { choreDigestTime: '09:00' } });
  await createService(nine.ctx).dispatch();
  assert.strictEqual(nine.sent.length, 0);
  // 09:00 Denver is 15:00Z.
  const later = makeCtx({ nowIso: '2026-09-08T15:00:00Z', categories: [DISHES], settings: { choreDigestTime: '09:00' } });
  await createService(later.ctx).dispatch();
  assert.strictEqual(later.sent.length, 2);
  // 20:00 Denver Tue is 02:00Z Wed: Dishes' own reminder hour, now silent.
  const evening = makeCtx({ nowIso: '2026-09-09T02:00:00Z', categories: [DISHES] });
  await createService(evening.ctx).dispatch();
  assert.strictEqual(evening.sent.length, 0);
});
