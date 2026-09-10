import test from 'node:test';
import assert from 'node:assert';
import { makeSyncItem } from './banksyncrun.js';
import { PlaidError } from './plaid.js';

const ITEM = { id: 'item-1', access_token_id: 'vault-1', cursor: 'c0' };
const txn = (id) => ({
  transaction_id: id, account_id: 'acc1', date: '2026-09-08', amount: 10,
  merchant_name: 'Costco', pending: false, personal_finance_category: null,
});
const ACCOUNT = { account_id: 'acc1', name: 'Checking', type: 'depository', subtype: 'checking', mask: '1234', balances: { current: 100 } };

// Records every call in order so a test can assert what ran and in what order.
function fakeDb() {
  const calls = [];
  return {
    calls,
    async readAccessToken() { calls.push(['readAccessToken']); return 'access-1'; },
    async loadRules() { calls.push(['loadRules']); return []; },
    async upsertAccounts(_sql, rows) { calls.push(['upsertAccounts', rows]); },
    async applySync(_sql, itemId, plan, cursor) { calls.push(['applySync', itemId, plan, cursor]); },
    async failSync(_sql, itemId, status, message) { calls.push(['failSync', itemId, status, message]); },
  };
}
function fakePlaid(pages, accounts = [ACCOUNT]) {
  const queue = [...pages];
  return {
    async syncPage() {
      const next = queue.shift();
      if (typeof next === 'function') return next();
      return next;
    },
    async accounts() { return accounts; },
  };
}
const names = (db) => db.calls.map((c) => c[0]);
const find = (db, name) => db.calls.find((c) => c[0] === name);

test('a two-page run applies both pages and saves the second page cursor', async () => {
  const db = fakeDb();
  const plaid = fakePlaid([
    { added: [txn('tx1')], modified: [], removed: [], next_cursor: 'c1', has_more: true },
    { added: [txn('tx2')], modified: [], removed: [], next_cursor: 'c2', has_more: false },
  ]);
  const out = await makeSyncItem({ sql: null, plaid, db })(ITEM);
  const [, itemId, plan, cursor] = find(db, 'applySync');
  assert.strictEqual(itemId, 'item-1');
  assert.deepStrictEqual(plan.inserts.map((r) => r.id), ['tx1', 'tx2']);
  assert.strictEqual(cursor, 'c2');
  assert.deepStrictEqual(out, { id: 'item-1', status: 'ok', added: 2, modified: 0, removed: 0, error: '' });
});

test('a throw on page two leaves applySync uncalled and fails the item', async () => {
  const db = fakeDb();
  const plaid = fakePlaid([
    { added: [txn('tx1')], modified: [], removed: [], next_cursor: 'c1', has_more: true },
    () => { throw new Error('network is down'); },
  ]);
  const out = await makeSyncItem({ sql: null, plaid, db })(ITEM);
  assert.strictEqual(find(db, 'applySync'), undefined);
  assert.deepStrictEqual(find(db, 'failSync'), ['failSync', 'item-1', 'error', 'network is down']);
  assert.strictEqual(out.status, 'error');
  assert.strictEqual(out.added, 0);
});

test('a login-required Plaid error marks the item login_required', async () => {
  const db = fakeDb();
  const plaid = fakePlaid([() => {
    throw new PlaidError({ error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed' }, 400);
  }]);
  const out = await makeSyncItem({ sql: null, plaid, db })(ITEM);
  assert.strictEqual(out.status, 'login_required');
  assert.strictEqual(find(db, 'failSync')[2], 'login_required');
});

test('balances land before rows, because transactions reference accounts', async () => {
  const db = fakeDb();
  const plaid = fakePlaid([{ added: [txn('tx1')], modified: [], removed: [], next_cursor: 'c1', has_more: false }]);
  const asOf = new Date('2026-09-08T16:00:00Z');
  await makeSyncItem({ sql: null, plaid, db, now: () => asOf })(ITEM);
  const order = names(db);
  assert.ok(order.indexOf('upsertAccounts') < order.indexOf('applySync'));
  assert.deepStrictEqual(find(db, 'upsertAccounts')[1], [{
    id: 'acc1', item_id: 'item-1', name: 'Checking', type: 'depository', subtype: 'checking',
    mask: '1234', current_balance: 100, balance_as_of: asOf,
  }]);
});
