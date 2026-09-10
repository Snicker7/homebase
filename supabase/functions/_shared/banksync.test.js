import test from 'node:test';
import assert from 'node:assert';
import { matchRule, txnRow, accountRow, planSync } from './banksync.js';

const RULES = [
  { id: 2, pattern: 'costco', category_id: 'groceries', priority: 100 },
  { id: 1, pattern: 'costco gas', category_id: 'fuel', priority: 10 },
  { id: 3, pattern: 'netflix', category_id: 'fun', priority: 100 },
];

test('matchRule: case-insensitive substring, lowest priority wins', () => {
  assert.strictEqual(matchRule('COSTCO GAS #123', RULES), 'fuel');
  assert.strictEqual(matchRule('Costco Wholesale', RULES), 'groceries');
  assert.strictEqual(matchRule('Trader Joe', RULES), null);
  assert.strictEqual(matchRule('', RULES), null);
});

const T = {
  transaction_id: 'tx1', account_id: 'acc1', date: '2026-09-08', amount: 42.5,
  merchant_name: 'Netflix', name: 'NETFLIX.COM', pending: false,
  personal_finance_category: { primary: 'ENTERTAINMENT', detailed: 'ENTERTAINMENT_TV_AND_MOVIES' },
};

test('txnRow: prefers merchant_name, falls back to name, keeps the detailed category', () => {
  assert.deepStrictEqual(txnRow(T), {
    id: 'tx1', account_id: 'acc1', date: '2026-09-08', amount: 42.5, merchant: 'Netflix',
    pending: false, plaid_category: 'ENTERTAINMENT_TV_AND_MOVIES',
  });
  const noMerchant = txnRow({ ...T, merchant_name: null, personal_finance_category: null });
  assert.strictEqual(noMerchant.merchant, 'NETFLIX.COM');
  assert.strictEqual(noMerchant.plaid_category, null);
});

test('txnRow: a non-numeric amount throws rather than writing NaN', () => {
  assert.throws(() => txnRow({ ...T, amount: 'oops' }), /transaction tx1 has a non-numeric amount/);
  assert.throws(() => txnRow({ ...T, amount: undefined }), /non-numeric amount/);
  assert.strictEqual(txnRow({ ...T, amount: '42.50' }).amount, 42.5);
  assert.strictEqual(txnRow({ ...T, amount: 0 }).amount, 0);
});

test('accountRow: flattens a Plaid account with its current balance', () => {
  const asOf = new Date('2026-09-08T16:00:00Z');
  const a = { account_id: 'acc1', name: 'Checking', official_name: 'Everyday Checking', type: 'depository', subtype: 'checking', mask: '1234', balances: { current: 1500.25, available: 1400 } };
  assert.deepStrictEqual(accountRow(a, 'item-1', asOf), {
    id: 'acc1', item_id: 'item-1', name: 'Checking', type: 'depository', subtype: 'checking', mask: '1234',
    current_balance: 1500.25, balance_as_of: asOf,
  });
  assert.strictEqual(accountRow({ ...a, balances: {} }, 'item-1', asOf).current_balance, null);
});

test('planSync: added rows get a rule category, modified rows never carry one, removed ids collect', () => {
  const pages = [
    { added: [T], modified: [], removed: [] },
    { added: [{ ...T, transaction_id: 'tx2', merchant_name: 'Trader Joe' }], modified: [{ ...T, transaction_id: 'tx3', amount: 9 }], removed: [{ transaction_id: 'tx4' }] },
  ];
  const plan = planSync(pages, RULES);
  assert.strictEqual(plan.inserts.length, 2);
  assert.strictEqual(plan.inserts[0].category_id, 'fun');
  assert.strictEqual(plan.inserts[0].categorized_by, 'rule');
  assert.strictEqual(plan.inserts[1].category_id, null);
  assert.strictEqual(plan.inserts[1].categorized_by, null);
  assert.deepStrictEqual(Object.keys(plan.updates[0]).sort(), ['account_id', 'amount', 'date', 'id', 'merchant', 'pending', 'plaid_category']);
  assert.deepStrictEqual(plan.removals, ['tx4']);
});


/* ── transfers Plaid can name for us ───────────────────────────────────── */
const pfc = (detailed) => ({ ...T, transaction_id: 'x1', personal_finance_category: { primary: detailed.split('_')[0], detailed } });

test('planSync: a credit card payment files itself as a transfer', () => {
  const plan = planSync([{ added: [pfc('LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')], modified: [], removed: [] }], [], { transferId: 'transfer' });
  assert.strictEqual(plan.inserts[0].category_id, 'transfer');
  assert.strictEqual(plan.inserts[0].categorized_by, 'rule');
});

test('planSync: account and savings transfers file themselves too, both directions', () => {
  const codes = ['TRANSFER_OUT_ACCOUNT_TRANSFER', 'TRANSFER_IN_ACCOUNT_TRANSFER', 'TRANSFER_OUT_SAVINGS', 'TRANSFER_IN_SAVINGS'];
  const plan = planSync([{ added: codes.map(pfc), modified: [], removed: [] }], [], { transferId: 'transfer' });
  assert.deepStrictEqual(plan.inserts.map((r) => r.category_id), codes.map(() => 'transfer'));
});

test('planSync: a real expense Plaid happens to file under loans is left alone', () => {
  const plan = planSync([{ added: [pfc('LOAN_PAYMENTS_CAR_PAYMENT'), pfc('TRANSFER_IN_CASH_ADVANCES_AND_LOANS')], modified: [], removed: [] }], [], { transferId: 'transfer' });
  assert.deepStrictEqual(plan.inserts.map((r) => r.category_id), [null, null]);
});

test('planSync: a merchant rule beats the transfer default, and no transfer category means no guess', () => {
  const row = pfc('LOAN_PAYMENTS_CREDIT_CARD_PAYMENT');
  const ruled = planSync([{ added: [row], modified: [], removed: [] }], [{ id: 1, pattern: 'netflix', category_id: 'fun', priority: 100 }], { transferId: 'transfer' });
  assert.strictEqual(ruled.inserts[0].category_id, 'fun');
  const bare = planSync([{ added: [row], modified: [], removed: [] }], [], {});
  assert.strictEqual(bare.inserts[0].category_id, null);
});
