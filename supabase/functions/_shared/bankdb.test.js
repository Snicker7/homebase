// Runs only against the local stack: DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test
import test from 'node:test';
import assert from 'node:assert';
import postgres from 'postgres';
import * as db from './bankdb.js';

const DB_URL = process.env.DB_URL;

test('bankdb: link, sync, categorize, remember', { skip: !DB_URL && 'set DB_URL' }, async () => {
  const sql = postgres(DB_URL);
  try {
    await sql`delete from category_rules`;
    await sql`delete from transactions`;
    await sql`delete from accounts`;
    await sql`delete from plaid_items`;
    await sql`delete from budget_categories where kind = 'spend'`;
    await sql`insert into people (email, name) values ('ann@x.com', 'Ann') on conflict do nothing`;

    const vaultId = await db.storeAccessToken(sql, 'item-1', 'access-sandbox-abc');
    assert.strictEqual(await db.readAccessToken(sql, vaultId), 'access-sandbox-abc');
    const vaultId2 = await db.storeAccessToken(sql, 'item-1', 'access-sandbox-second');
    assert.notStrictEqual(vaultId2, vaultId);
    assert.strictEqual(await db.readAccessToken(sql, vaultId2), 'access-sandbox-second');
    await db.insertItem(sql, { id: 'item-1', institution: 'First Bank', accessTokenId: vaultId, linkedBy: 'ann@x.com' });
    const items = await db.listItems(sql);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].status, 'ok');

    const asOf = new Date('2026-09-08T16:00:00Z');
    await db.upsertAccounts(sql, [{ id: 'acc1', item_id: 'item-1', name: 'Checking', type: 'depository', subtype: 'checking', mask: '1234', current_balance: 100, balance_as_of: asOf }]);
    await db.upsertAccounts(sql, [{ id: 'acc1', item_id: 'item-1', name: 'Checking', type: 'depository', subtype: 'checking', mask: '1234', current_balance: 90, balance_as_of: asOf }]);
    assert.strictEqual(Number((await sql`select current_balance from accounts where id = 'acc1'`)[0].current_balance), 90);

    await db.addCategory(sql, { id: 'groceries', name: 'Groceries', emoji: '🥕', kind: 'spend' });
    const tx = (id, merchant, amount) => ({ id, account_id: 'acc1', date: '2026-09-08', amount, merchant, pending: false, plaid_category: null });
    await db.applySync(sql, 'item-1', {
      inserts: [{ ...tx('tx1', 'Costco', 50), category_id: 'groceries', categorized_by: 'rule' }, { ...tx('tx2', 'Mystery', 5), category_id: null, categorized_by: null }],
      updates: [], removals: [],
    }, 'cursor-1');
    // A second sync modifies tx1's amount and removes tx2; the category on tx1 survives.
    await db.applySync(sql, 'item-1', { inserts: [], updates: [tx('tx1', 'Costco', 55)], removals: ['tx2'] }, 'cursor-2');
    const rows = await sql`select id, amount, category_id, removed_at from transactions order by id`;
    assert.strictEqual(Number(rows[0].amount), 55);
    assert.strictEqual(rows[0].category_id, 'groceries');
    assert.ok(rows[1].removed_at);
    const item = (await db.listItems(sql, 'item-1'))[0];
    assert.strictEqual(item.cursor, 'cursor-2');

    // Re-inserting an already-known id (Plaid re-sends after a cursor reset) keeps the user's category.
    await sql`update transactions set category_id = null, categorized_by = 'user', note = 'kept' where id = 'tx1'`;
    await db.applySync(sql, 'item-1', { inserts: [{ ...tx('tx1', 'Costco', 55), category_id: 'groceries', categorized_by: 'rule' }], updates: [], removals: [] }, 'cursor-3');
    const kept = (await sql`select category_id, note from transactions where id = 'tx1'`)[0];
    assert.strictEqual(kept.category_id, null);
    assert.strictEqual(kept.note, 'kept');

    const c = await db.categorize(sql, { id: 'tx1', categoryId: 'groceries', note: 'bulk' });
    assert.strictEqual(c.merchant, 'Costco');
    await db.addRule(sql, { pattern: c.merchant, categoryId: 'groceries' });
    const rules = await db.loadRules(sql);
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].pattern, 'Costco');

    await db.failSync(sql, 'item-1', 'login_required', 'the login details of this item have changed');
    assert.strictEqual((await db.listItems(sql, 'item-1'))[0].status, 'login_required');
  } finally {
    await sql.end();
  }
});
