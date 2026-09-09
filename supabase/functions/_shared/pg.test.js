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
