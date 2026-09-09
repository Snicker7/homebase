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
  // 21:05:11 MDT (Denver, UTC-6) on June 20 is 03:05:11Z on June 21.
  assert.strictEqual(rows[0].timestamp.toISOString(), '2026-06-21T03:05:11.000Z');
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
