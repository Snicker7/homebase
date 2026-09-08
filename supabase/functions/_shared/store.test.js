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
  assert.strictEqual(s.partnerOf('A@X.com'), 'b@x.com');
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

test('journal() returns a deep clone, not aliased internals', () => {
  const s = createStore(snap());
  s.appendLedger({ type: 'spend', amount: 1, balanceAfter: 0, actor: 'a@x.com', note: 'coffee' });
  const entry = s.journal()[0];
  entry.row.amount = 999;
  assert.strictEqual(s.journal()[0].row.amount, 1);
  assert.ok(s.journal()[0].row.timestamp instanceof Date);
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
