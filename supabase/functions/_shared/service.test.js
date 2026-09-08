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
