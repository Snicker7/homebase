import test from 'node:test';
import assert from 'node:assert';
import * as E from './engine.js';

test('payout scales by increment and caps at maxPerInstance', () => {
  const cat = { rewardIncrement: 0.25, maxPerInstance: 5.0 };
  assert.strictEqual(E.payout(cat, 1), 0.25);
  assert.strictEqual(E.payout(cat, 4), 1.0);
  assert.strictEqual(E.payout(cat, 20), 5.0);
  assert.strictEqual(E.payout(cat, 40), 5.0);
});

test('payout honors a different increment/cap', () => {
  const cat = { rewardIncrement: 1.0, maxPerInstance: 3.0 };
  assert.strictEqual(E.payout(cat, 2), 2.0);
  assert.strictEqual(E.payout(cat, 5), 3.0);
});

test('periodKeyFor daily returns the date; weekly returns ISO week', () => {
  assert.strictEqual(E.periodKeyFor('daily', '2026-06-22'), '2026-06-22');
  // 2026-06-22 is a Monday → ISO week 26 of 2026
  assert.strictEqual(E.periodKeyFor('weekly', '2026-06-22'), '2026-W26');
  // 2026-06-21 is the Sunday of the prior ISO week (week 25)
  assert.strictEqual(E.periodKeyFor('weekly', '2026-06-21'), '2026-W25');
});

// Task 2: applyEntry + applyRefresh with integer freezes

const CAT = {
  id: 'sleep', rewardIncrement: 0.25, maxPerInstance: 5.0,
  freezesPerPeriod: 1, unusedFreezeBonus: 3.5,
};

test('on_time increments streak and credits the wallet', () => {
  const s0 = E.initialCatState(CAT, '2026-06-22');
  const r = E.applyEntry(s0, 0, CAT, { periodKey: '2026-06-22', result: 'on_time', actor: 'a' });
  assert.strictEqual(r.state.streak, 1);
  assert.strictEqual(r.balance, 0.25);
  assert.strictEqual(r.event.type, 'entry');
  assert.strictEqual(r.event.category, 'sleep');
  assert.strictEqual(r.event.amount, 0.25);
  assert.strictEqual(r.event.balanceAfter, 0.25);
});

test('missed with a freeze preserves streak, decrements freeze, pays nothing', () => {
  const s = { streak: 5, periodStart: '2026-06-22', freezesUsedThisPeriod: 0, lastRecordedKey: null };
  const r = E.applyEntry(s, 3.75, CAT, { periodKey: '2026-06-23', result: 'missed', actor: 'a' });
  assert.strictEqual(r.state.streak, 5);
  assert.strictEqual(E.freezesLeft(CAT, r.state), 0);
  assert.strictEqual(r.state.freezesUsedThisPeriod, 1);
  assert.strictEqual(r.balance, 3.75);
  assert.strictEqual(r.event.freezeUsed, true);
});

test('missed with no freeze resets streak to 0', () => {
  const s = { streak: 5, periodStart: '2026-06-22', freezesUsedThisPeriod: 1, lastRecordedKey: null };
  const r = E.applyEntry(s, 3.75, CAT, { periodKey: '2026-06-23', result: 'missed', actor: 'a' });
  assert.strictEqual(r.state.streak, 0);
  assert.strictEqual(r.balance, 3.75);
});

test('a category with 2 freezes absorbs two misses before resetting', () => {
  const cat2 = Object.assign({}, CAT, { freezesPerPeriod: 2 });
  // Start with a streak of 7 so we can prove freezes preserve it.
  let s = { streak: 7, periodStart: 'P', freezesUsedThisPeriod: 0, lastRecordedKey: null };
  s = E.applyEntry(s, 0, cat2, { periodKey: 'k1', result: 'missed' }).state;
  assert.strictEqual(s.streak, 7); // first freeze preserves streak
  assert.strictEqual(E.freezesLeft(cat2, s), 1);
  s = E.applyEntry(s, 0, cat2, { periodKey: 'k2', result: 'missed' }).state;
  assert.strictEqual(s.streak, 7); // second freeze preserves streak
  assert.strictEqual(E.freezesLeft(cat2, s), 0);
  const r = E.applyEntry(s, 0, cat2, { periodKey: 'k3', result: 'missed' });
  assert.strictEqual(r.state.streak, 0); // out of freezes -> reset
});

test('double-recording the same period is rejected', () => {
  const s = { streak: 1, periodStart: 'P', freezesUsedThisPeriod: 0, lastRecordedKey: '2026-06-22' };
  assert.throws(() => E.applyEntry(s, 0, CAT, { periodKey: '2026-06-22', result: 'on_time' }), /already recorded/);
});

test('refresh awards bonus when no freeze used and resets freezes', () => {
  const s = { streak: 3, periodStart: 'P1', freezesUsedThisPeriod: 0, lastRecordedKey: 'k' };
  const r = E.applyRefresh(s, 10, CAT, 'P2', true);
  assert.strictEqual(r.balance, 13.5);
  assert.strictEqual(r.event.type, 'bonus');
  assert.strictEqual(E.freezesLeft(CAT, r.state), 1);
  assert.strictEqual(r.state.periodStart, 'P2');
});

test('refresh gives no bonus (and no event) when a freeze was used', () => {
  const s = { streak: 3, periodStart: 'P1', freezesUsedThisPeriod: 1, lastRecordedKey: 'k' };
  const r = E.applyRefresh(s, 10, CAT, 'P2', true);
  assert.strictEqual(r.balance, 10);
  assert.strictEqual(r.event, null);
});

test('refresh gives no bonus when unusedFreezeBonus is 0', () => {
  const catNoBonus = Object.assign({}, CAT, { unusedFreezeBonus: 0 });
  const s = { streak: 3, periodStart: 'P1', freezesUsedThisPeriod: 0, lastRecordedKey: 'k' };
  const r = E.applyRefresh(s, 10, catNoBonus, 'P2', true);
  assert.strictEqual(r.balance, 10);
  assert.strictEqual(r.event, null);
});

test('refresh pays nothing for a period with no entries, but still resets freezes', () => {
  const s = { streak: 3, periodStart: 'P1', freezesUsedThisPeriod: 0, lastRecordedKey: 'k' };
  const r = E.applyRefresh(s, 10, CAT, 'P2', false);
  assert.strictEqual(r.balance, 10);
  assert.strictEqual(r.event, null);
  assert.strictEqual(r.state.freezesUsedThisPeriod, 0);
  assert.strictEqual(E.freezesLeft(CAT, r.state), 1);
  assert.strictEqual(r.state.periodStart, 'P2');
});

test('spend subtracts from the wallet and floors at 0', () => {
  assert.strictEqual(E.applySpend(10, { amount: 4 }).balance, 6);
  assert.strictEqual(E.applySpend(3, { amount: 5 }).balance, 0);
  assert.throws(() => E.applySpend(10, { amount: 0 }), /positive/);
  const ev = E.applySpend(10, { amount: 4, note: 'snack', actor: 'a' }).event;
  assert.strictEqual(ev.type, 'spend');
  assert.strictEqual(ev.balanceAfter, 6);
});

test('deposit adds to the wallet', () => {
  const r = E.applyDeposit(10, { amount: 20, note: 'allowance', actor: 'a' });
  assert.strictEqual(r.balance, 30);
  assert.strictEqual(r.event.type, 'deposit');
  assert.strictEqual(r.event.balanceAfter, 30);
  assert.throws(() => E.applyDeposit(10, { amount: -1 }), /positive/);
});

// Task 4: category validation + defaults

test('normalizeCategory slugifies id and coerces numbers', () => {
  const c = E.normalizeCategory({
    name: 'Morning Run!', emoji: '🏃', cadence: 'daily',
    rewardIncrement: '0.50', maxPerInstance: '4', freezesPerPeriod: '2',
    freezeRefresh: 'weekly', unusedFreezeBonus: '', reminderTime: '21:00',
    checkupTime: '', active: true,
  });
  assert.strictEqual(c.id, 'morning-run');
  assert.strictEqual(c.rewardIncrement, 0.5);
  assert.strictEqual(c.maxPerInstance, 4);
  assert.strictEqual(c.freezesPerPeriod, 2);
  assert.strictEqual(c.unusedFreezeBonus, 0); // blank -> 0 (no bonus)
  assert.strictEqual(c.reminderTime, '21:00');
  assert.strictEqual(c.checkupTime, '');
});

test('normalizeCategory keeps daily/weekly/monthly freezeRefresh, clamps the rest to weekly', () => {
  const base = { name: 'X', cadence: 'daily', rewardIncrement: '1', maxPerInstance: '1', freezesPerPeriod: '1' };
  assert.strictEqual(E.normalizeCategory(Object.assign({}, base, { freezeRefresh: 'daily' })).freezeRefresh, 'daily');
  assert.strictEqual(E.normalizeCategory(Object.assign({}, base, { freezeRefresh: 'weekly' })).freezeRefresh, 'weekly');
  assert.strictEqual(E.normalizeCategory(Object.assign({}, base, { freezeRefresh: 'monthly' })).freezeRefresh, 'monthly');
  assert.strictEqual(E.normalizeCategory(Object.assign({}, base, { freezeRefresh: 'yearly' })).freezeRefresh, 'weekly');
});

test('validateCategory flags bad input', () => {
  const bad = E.normalizeCategory({ name: '', cadence: 'monthly', rewardIncrement: '-1', maxPerInstance: '0', freezesPerPeriod: '-2', freezeRefresh: 'weekly', reminderTime: '9:30', checkupTime: '' });
  const errs = E.validateCategory(bad);
  assert.ok(errs.some((e) => /name/i.test(e)));
  assert.ok(errs.some((e) => /cadence/i.test(e)));
  assert.ok(errs.some((e) => /increment/i.test(e)));
  assert.ok(errs.some((e) => /max/i.test(e)));
  assert.ok(errs.some((e) => /freeze/i.test(e)));
  assert.ok(errs.some((e) => /time/i.test(e))); // 9:30 is not a whole hour
});

test('validateCategory passes a good category', () => {
  const good = E.normalizeCategory({ name: 'Sleep', emoji: '🌙', cadence: 'daily', rewardIncrement: '0.25', maxPerInstance: '5', freezesPerPeriod: '1', freezeRefresh: 'weekly', unusedFreezeBonus: '3.5', reminderTime: '21:00', checkupTime: '09:00', active: true });
  assert.deepStrictEqual(E.validateCategory(good), []);
});

test('deriveWallet sums deposits and bonuses, subtracts spends', () => {
  const rows = [
    { type: 'deposit', amount: 10, actor: 'a' },
    { type: 'bonus', amount: 3.5, actor: 'a' },
    { type: 'spend', amount: 4, actor: 'a' },
  ];
  assert.strictEqual(E.deriveWallet(rows, 'a'), 9.5);
});

test('deriveWallet adds on-time entry payouts and ignores zero-amount misses', () => {
  const rows = [
    { type: 'entry', amount: 0.25, actor: 'a', result: 'on_time' },
    { type: 'entry', amount: 0, actor: 'a', result: 'missed' },
  ];
  assert.strictEqual(E.deriveWallet(rows, 'a'), 0.25);
});

test('deriveWallet floors a spend that exceeds the balance at $0', () => {
  const rows = [
    { type: 'deposit', amount: 3, actor: 'a' },
    { type: 'spend', amount: 5, actor: 'a' },
    { type: 'deposit', amount: 2, actor: 'a' },
  ];
  // 3 -> max(0, 3-5)=0 -> 0+2 = 2  (floor matters: without it this is 0)
  assert.strictEqual(E.deriveWallet(rows, 'a'), 2);
});

test('deriveWallet isolates by actor, case-insensitively', () => {
  const rows = [
    { type: 'deposit', amount: 10, actor: 'A@x.com' },
    { type: 'deposit', amount: 99, actor: 'b@x.com' },
    { type: 'spend', amount: 4, actor: 'a@X.COM' },
  ];
  assert.strictEqual(E.deriveWallet(rows, 'a@x.com'), 6);
});

test('deriveWallet returns 0 for no matching rows', () => {
  assert.strictEqual(E.deriveWallet([], 'a'), 0);
  assert.strictEqual(E.deriveWallet([{ type: 'deposit', amount: 5, actor: 'b' }], 'a'), 0);
});

test('runningBalanceRows attaches cumulative balanceAfter for the actor only', () => {
  const rows = [
    { type: 'deposit', amount: 10, actor: 'a' },
    { type: 'deposit', amount: 99, actor: 'b' },
    { type: 'spend', amount: 4, actor: 'a' },
  ];
  const out = E.runningBalanceRows(rows, 'a');
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].balanceAfter, 10);
  assert.strictEqual(out[1].balanceAfter, 6);
});

test('applySpend caps the logged amount at the available balance on overspend', () => {
  const r = E.applySpend(3, { amount: 5 });
  assert.strictEqual(r.balance, 0);
  assert.strictEqual(r.event.amount, 3); // logs what was actually deducted, not the requested 5
});

test('applySpend logs the full amount for a normal spend', () => {
  const r = E.applySpend(10, { amount: 4 });
  assert.strictEqual(r.balance, 6);
  assert.strictEqual(r.event.amount, 4);
});

// shiftDays / lastClosedPeriodKey: which period a record button writes.

test('shiftDays moves a date string across month and year boundaries', () => {
  assert.strictEqual(E.shiftDays('2026-06-22', -1), '2026-06-21');
  assert.strictEqual(E.shiftDays('2026-07-01', -1), '2026-06-30');
  assert.strictEqual(E.shiftDays('2026-01-01', -1), '2025-12-31');
  assert.strictEqual(E.shiftDays('2026-03-04', -7), '2026-02-25');
  assert.strictEqual(E.shiftDays('2026-06-22', 0), '2026-06-22');
});

test('lastClosedPeriodKey for a daily category is yesterday', () => {
  // 2026-06-22 is a Monday (dow 1) … 2026-06-28 is a Sunday (dow 7).
  assert.strictEqual(E.lastClosedPeriodKey('daily', '2026-06-22', 1), '2026-06-21');
  assert.strictEqual(E.lastClosedPeriodKey('daily', '2026-06-25', 4), '2026-06-24');
  assert.strictEqual(E.lastClosedPeriodKey('daily', '2026-06-28', 7), '2026-06-27');
});

// The bug this fixes: "yesterday" mid-week still falls inside the CURRENT ISO
// week, so a Wednesday tap on a weekly card credited a week that hadn't ended.
test('lastClosedPeriodKey for a weekly category is always the previous ISO week', () => {
  // Every day of the week of 2026-06-22 (week 26) must resolve to week 25.
  const week26 = [
    ['2026-06-22', 1], ['2026-06-23', 2], ['2026-06-24', 3], ['2026-06-25', 4],
    ['2026-06-26', 5], ['2026-06-27', 6], ['2026-06-28', 7],
  ];
  week26.forEach(([date, dow]) => {
    assert.strictEqual(E.lastClosedPeriodKey('weekly', date, dow), '2026-W25');
  });
  // …and the next week rolls over to 26.
  assert.strictEqual(E.lastClosedPeriodKey('weekly', '2026-06-29', 1), '2026-W26');
});

// Review fix: weekly categories were emailed every day, and a mid-week
// check-up recorded the still-open week. Gates: reminder Sunday, checkup Monday.

test('daily categories send reminders and checkups every day', () => {
  const daily = { cadence: 'daily' };
  for (let dow = 1; dow <= 7; dow++) {
    assert.strictEqual(E.shouldSendReminder(daily, dow), true);
    assert.strictEqual(E.shouldSendCheckup(daily, dow), true);
  }
});

test('weekly categories: reminder only on Sunday (7), checkup only on Monday (1)', () => {
  const weekly = { cadence: 'weekly' };
  for (let dow = 1; dow <= 7; dow++) {
    assert.strictEqual(E.shouldSendReminder(weekly, dow), dow === 7);
    assert.strictEqual(E.shouldSendCheckup(weekly, dow), dow === 1);
  }
});

// The signed-email path passes `result` straight through from a URL, so a
// junk value must be rejected rather than silently treated as a miss.
test('applyEntry rejects a result that is neither on_time nor missed', () => {
  const s0 = E.initialCatState(CAT, '2026-06-22');
  assert.throws(
    () => E.applyEntry(s0, 0, CAT, { periodKey: '2026-06-22', result: 'maybe', actor: 'a' }),
    /result must be "on_time" or "missed"/
  );
  assert.throws(
    () => E.applyEntry(s0, 0, CAT, { periodKey: '2026-06-22', actor: 'a' }),
    /result must be "on_time" or "missed"/
  );
});

// Configurable miss penalty & payout floor (spec 2026-07-08)

test('payout starts the curve at minPayout and grows by the increment', () => {
  const cat = { rewardIncrement: 0.25, maxPerInstance: 5.0, minPayout: 1.0 };
  assert.strictEqual(E.payout(cat, 0), 0);
  assert.strictEqual(E.payout(cat, 1), 1.0);
  assert.strictEqual(E.payout(cat, 2), 1.25);
  assert.strictEqual(E.payout(cat, 3), 1.5);
  assert.strictEqual(E.payout(cat, 100), 5.0); // cap still wins
});

test('payout with no minPayout keeps the increment-only curve', () => {
  const cat = { rewardIncrement: 0.25, maxPerInstance: 5.0, minPayout: 0 };
  assert.strictEqual(E.payout(cat, 1), 0.25);
  assert.strictEqual(E.payout(cat, 4), 1.0);
});

test('missed with no freeze applies missPenaltyPercent to the streak', () => {
  const s = { streak: 10, periodStart: '2026-06-22', freezesUsedThisPeriod: 1, lastRecordedKey: null };
  const at = (pct) => E.applyEntry(s, 0, Object.assign({}, CAT, { missPenaltyPercent: pct }),
    { periodKey: '2026-06-23', result: 'missed', actor: 'a' }).state.streak;
  assert.strictEqual(at(100), 0);
  assert.strictEqual(at(50), 5);
  assert.strictEqual(at(0), 10);
});

test('miss penalty rounds an odd streak up to the larger half', () => {
  const s = { streak: 5, periodStart: '2026-06-22', freezesUsedThisPeriod: 1, lastRecordedKey: null };
  const r = E.applyEntry(s, 0, Object.assign({}, CAT, { missPenaltyPercent: 50 }),
    { periodKey: '2026-06-23', result: 'missed', actor: 'a' });
  assert.strictEqual(r.state.streak, 3);
});

test('a freeze preserves the streak whatever the miss penalty is', () => {
  const s = { streak: 7, periodStart: '2026-06-22', freezesUsedThisPeriod: 0, lastRecordedKey: null };
  const r = E.applyEntry(s, 0, Object.assign({}, CAT, { missPenaltyPercent: 50 }),
    { periodKey: '2026-06-23', result: 'missed', actor: 'a' });
  assert.strictEqual(r.state.streak, 7);
  assert.strictEqual(r.event.freezeUsed, true);
});

test('normalizeCategory defaults missPenaltyPercent to 100 and minPayout to 0', () => {
  const c = E.normalizeCategory({ name: 'Sleep', cadence: 'daily', rewardIncrement: '0.25', maxPerInstance: '5', freezesPerPeriod: '1' });
  assert.strictEqual(c.missPenaltyPercent, 100);
  assert.strictEqual(c.minPayout, 0);
  const set = E.normalizeCategory({ name: 'Sleep', cadence: 'daily', rewardIncrement: '0.25', maxPerInstance: '5', freezesPerPeriod: '1', missPenaltyPercent: '50', minPayout: '1.00' });
  assert.strictEqual(set.missPenaltyPercent, 50);
  assert.strictEqual(set.minPayout, 1);
});

test('validateCategory rejects an out-of-range penalty and a floor above the cap', () => {
  const base = { name: 'Sleep', cadence: 'daily', rewardIncrement: '0.25', maxPerInstance: '5', freezesPerPeriod: '1', reminderTime: '', checkupTime: '' };
  const errsOf = (extra) => E.validateCategory(E.normalizeCategory(Object.assign({}, base, extra)));
  assert.strictEqual(errsOf({}).length, 0);
  assert.strictEqual(errsOf({ missPenaltyPercent: '', minPayout: '' }).length, 0);
  assert.ok(errsOf({ missPenaltyPercent: '101' }).some((e) => /penalty/i.test(e)));
  assert.ok(errsOf({ missPenaltyPercent: '-1' }).some((e) => /penalty/i.test(e)));
  assert.ok(errsOf({ minPayout: '-1' }).some((e) => /minimum payout/i.test(e)));
  assert.ok(errsOf({ minPayout: '6' }).some((e) => /minimum payout/i.test(e)));
});

// Freezes derived from the category, not cached in per-user state

test('freezesLeft follows the category when freezesPerPeriod is edited', () => {
  const s = { streak: 3, periodStart: 'P', freezesUsedThisPeriod: 1, lastRecordedKey: null };
  assert.strictEqual(E.freezesLeft(Object.assign({}, CAT, { freezesPerPeriod: 1 }), s), 0);
  assert.strictEqual(E.freezesLeft(Object.assign({}, CAT, { freezesPerPeriod: 5 }), s), 4);
  // Lowering the allowance below what's already spent can't go negative.
  assert.strictEqual(E.freezesLeft(Object.assign({}, CAT, { freezesPerPeriod: 0 }), s), 0);
});

test('raising freezesPerPeriod mid-period immediately protects the next miss', () => {
  const cat1 = Object.assign({}, CAT, { freezesPerPeriod: 1 });
  let s = E.initialCatState(cat1, 'P');
  s = E.applyEntry(s, 0, cat1, { periodKey: 'k1', result: 'missed' }).state; // burns the only freeze
  assert.strictEqual(E.freezesLeft(cat1, s), 0);
  // Owner edits the category to allow 3 freezes — no rollover in between.
  const cat3 = Object.assign({}, CAT, { freezesPerPeriod: 3 });
  assert.strictEqual(E.freezesLeft(cat3, s), 2);
  const r = E.applyEntry(Object.assign({}, s, { streak: 4 }), 0, cat3, { periodKey: 'k2', result: 'missed' });
  assert.strictEqual(r.event.freezeUsed, true);
  assert.strictEqual(r.state.streak, 4);
});

test('lowering freezesPerPeriod below the spent count breaks the next miss', () => {
  const cat2 = Object.assign({}, CAT, { freezesPerPeriod: 2 });
  let s = E.initialCatState(cat2, 'P');
  s = E.applyEntry(s, 0, cat2, { periodKey: 'k1', result: 'missed' }).state;
  s = E.applyEntry(s, 0, cat2, { periodKey: 'k2', result: 'missed' }).state;
  const cat1 = Object.assign({}, CAT, { freezesPerPeriod: 1 });
  assert.strictEqual(E.freezesLeft(cat1, s), 0);
  const r = E.applyEntry(Object.assign({}, s, { streak: 6 }), 0, cat1, { periodKey: 'k3', result: 'missed' });
  assert.strictEqual(r.event.freezeUsed, false);
  assert.strictEqual(r.state.streak, 0);
});

test('applyEntry counts freezes spent and applyRefresh clears the count', () => {
  const cat2 = Object.assign({}, CAT, { freezesPerPeriod: 2 });
  let s = E.initialCatState(cat2, 'P1');
  assert.strictEqual(s.freezesUsedThisPeriod, 0);
  s = E.applyEntry(s, 0, cat2, { periodKey: 'k1', result: 'missed' }).state;
  assert.strictEqual(s.freezesUsedThisPeriod, 1);
  s = E.applyEntry(s, 0, cat2, { periodKey: 'k2', result: 'missed' }).state;
  assert.strictEqual(s.freezesUsedThisPeriod, 2);
  const r = E.applyRefresh(s, 10, cat2, 'P2', true);
  assert.strictEqual(r.state.freezesUsedThisPeriod, 0);
  assert.strictEqual(r.event, null); // a freeze was used — no bonus
});

test('migrateCatState converts a legacy freezeAvailable state to a spent count', () => {
  const cat2 = Object.assign({}, CAT, { freezesPerPeriod: 2 });
  const legacy = { streak: 4, periodStart: 'P', freezeAvailable: 1, freezeUsedThisPeriod: true, lastRecordedKey: 'k' };
  const s = E.migrateCatState(cat2, legacy);
  assert.strictEqual(s.freezesUsedThisPeriod, 1);
  assert.strictEqual(s.streak, 4);
  assert.strictEqual(s.lastRecordedKey, 'k');
  assert.strictEqual(E.freezesLeft(cat2, s), 1);
  // A state that never touched a freeze migrates to 0 spent.
  assert.strictEqual(E.migrateCatState(cat2, { streak: 0, periodStart: 'P', freezeAvailable: 2, freezeUsedThisPeriod: false, lastRecordedKey: null }).freezesUsedThisPeriod, 0);
  // Already migrated → untouched.
  assert.strictEqual(E.migrateCatState(cat2, { streak: 1, freezesUsedThisPeriod: 2 }).freezesUsedThisPeriod, 2);
});

test('mondayOf returns the ISO Monday of a date without clock arithmetic', () => {
  assert.strictEqual(E.mondayOf('2026-08-19', 3), '2026-08-17');
  assert.strictEqual(E.mondayOf('2026-08-17', 1), '2026-08-17');
  assert.strictEqual(E.mondayOf('2026-08-23', 7), '2026-08-17');
  // The 2026 fall-back Sunday, where 24h-multiple math slipped a day.
  assert.strictEqual(E.mondayOf('2026-11-01', 7), '2026-10-26');
  assert.strictEqual(E.mondayOf('2026-03-01', 7), '2026-02-23'); // crosses a month
  assert.strictEqual(E.mondayOf('2026-01-03', 6), '2025-12-29'); // crosses a year
});

// Recorded periods come from the ledger, not from a single remembered key

test('isPeriodRecorded finds any past entry for that actor + category + period', () => {
  const rows = [
    { type: 'entry', actor: 'a@x.com', category: 'sleep', periodKey: '2026-08-16', result: 'on_time' },
    { type: 'entry', actor: 'a@x.com', category: 'sleep', periodKey: '2026-08-18', result: 'missed' },
    { type: 'entry', actor: 'b@x.com', category: 'sleep', periodKey: '2026-08-17', result: 'on_time' },
    { type: 'entry', actor: 'a@x.com', category: 'chores', periodKey: '2026-08-17', result: 'on_time' },
    { type: 'bonus', actor: 'a@x.com', category: 'sleep', periodKey: '2026-08-17', amount: 3.5 },
  ];
  // The superseded period an old check-up link used to sail straight past.
  assert.strictEqual(E.isPeriodRecorded(rows, 'a@x.com', 'sleep', '2026-08-16'), true);
  assert.strictEqual(E.isPeriodRecorded(rows, 'a@x.com', 'sleep', '2026-08-18'), true);
  // Never recorded by this person, for this category.
  assert.strictEqual(E.isPeriodRecorded(rows, 'a@x.com', 'sleep', '2026-08-17'), false);
  assert.strictEqual(E.isPeriodRecorded(rows, 'b@x.com', 'sleep', '2026-08-16'), false);
  assert.strictEqual(E.isPeriodRecorded(rows, 'a@x.com', 'chores', '2026-08-16'), false);
  // Case-insensitive on the actor, like every other ledger lookup.
  assert.strictEqual(E.isPeriodRecorded(rows, 'A@X.com', 'sleep', '2026-08-16'), true);
});

test('isPeriodRecorded reopens a period once its entry row is removed', () => {
  const rows = [{ type: 'entry', actor: 'a', category: 'sleep', periodKey: '2026-08-16' }];
  assert.strictEqual(E.isPeriodRecorded(rows, 'a', 'sleep', '2026-08-16'), true);
  assert.strictEqual(E.isPeriodRecorded([], 'a', 'sleep', '2026-08-16'), false);
});

// Emoji is a real, settable field — it heads every reminder and check-up email

test('normalizeCategory keeps a trimmed emoji and validateCategory caps its length', () => {
  const base = { name: 'Sleep', cadence: 'daily', rewardIncrement: '0.25', maxPerInstance: '5',
    freezesPerPeriod: '1', reminderTime: '', checkupTime: '' };
  const withEmoji = (e) => E.normalizeCategory(Object.assign({}, base, { emoji: e }));
  assert.strictEqual(withEmoji('  🌙 ').emoji, '🌙');
  assert.strictEqual(withEmoji('').emoji, '');       // cleared on purpose
  assert.strictEqual(withEmoji(undefined).emoji, '');
  // A ZWJ sequence is several code units and must still pass.
  assert.strictEqual(E.validateCategory(withEmoji('👩‍👩‍👧')).length, 0);
  assert.strictEqual(E.validateCategory(withEmoji('🌙')).length, 0);
  assert.strictEqual(E.validateCategory(withEmoji('')).length, 0);
  assert.ok(E.validateCategory(withEmoji('not an emoji, an essay')).some((e) => /emoji/i.test(e)));
});

// Editing the freeze-refresh cadence is not a period ending

test('refreshAction separates a real rollover from an edited cadence', () => {
  const weekly = Object.assign({}, CAT, { freezeRefresh: 'weekly' });
  const s = { streak: 3, periodStart: '2026-08-17', freezesUsedThisPeriod: 0, freezeRefresh: 'weekly' };
  assert.strictEqual(E.refreshAction(s, weekly, '2026-08-17'), 'none');
  assert.strictEqual(E.refreshAction(s, weekly, '2026-08-24'), 'refresh');
  // Same instant, different dropdown: the calendar didn't move, the rule did.
  const monthly = Object.assign({}, CAT, { freezeRefresh: 'monthly' });
  assert.strictEqual(E.refreshAction(s, monthly, '2026-08-01'), 'rebase');
  // ...and back again, which used to pay a second time.
  const rebased = E.applyRebase(s, monthly, '2026-08-01');
  assert.strictEqual(E.refreshAction(rebased, weekly, '2026-08-17'), 'rebase');
  // A state written before the cadence was tracked adopts it without payout.
  const legacy = { streak: 3, periodStart: '2026-08-17', freezesUsedThisPeriod: 0 };
  assert.strictEqual(E.refreshAction(legacy, weekly, '2026-08-17'), 'none');
});

test('applyRebase moves the period without refreshing freezes or paying a bonus', () => {
  const monthly = Object.assign({}, CAT, { freezeRefresh: 'monthly', freezesPerPeriod: 2 });
  const s = { streak: 3, periodStart: '2026-08-17', freezesUsedThisPeriod: 2, freezeRefresh: 'weekly',
    lastRecordedKey: '2026-08-18' };
  const r = E.applyRebase(s, monthly, '2026-08-01');
  assert.strictEqual(r.periodStart, '2026-08-01');
  assert.strictEqual(r.freezeRefresh, 'monthly');
  assert.strictEqual(r.freezesUsedThisPeriod, 2); // spent stays spent — no free freezes
  assert.strictEqual(E.freezesLeft(monthly, r), 0);
  assert.strictEqual(r.streak, 3);
  assert.strictEqual(r.lastRecordedKey, '2026-08-18');
});

test('initialCatState, applyRefresh and migrateCatState all stamp the cadence', () => {
  const weekly = Object.assign({}, CAT, { freezeRefresh: 'weekly' });
  assert.strictEqual(E.initialCatState(weekly, 'P').freezeRefresh, 'weekly');
  assert.strictEqual(E.applyRefresh(E.initialCatState(weekly, 'P'), 0, weekly, 'P2', true).state.freezeRefresh, 'weekly');
  assert.strictEqual(E.migrateCatState(weekly, { streak: 1, freezeAvailable: 1 }).freezeRefresh, 'weekly');
});

test('escapeHtml neutralises markup for the email bodies', () => {
  assert.strictEqual(E.escapeHtml('Sleep <img src=x onerror=alert(1)>'),
    'Sleep &lt;img src=x onerror=alert(1)&gt;');
  assert.strictEqual(E.escapeHtml('Tom & Jerry'), 'Tom &amp; Jerry');
  assert.strictEqual(E.escapeHtml('a"b\'c'), 'a&quot;b&#39;c');
  assert.strictEqual(E.escapeHtml('🌙'), '🌙');
  assert.strictEqual(E.escapeHtml(null), '');
  assert.strictEqual(E.escapeHtml(undefined), '');
});

// Resuming a dormant category is a fresh start, not a period ending

test('applyRestart gives a full allowance without paying the bonus', () => {
  const cat = Object.assign({}, CAT, { freezesPerPeriod: 2, unusedFreezeBonus: 3.5, freezeRefresh: 'weekly' });
  const s = { streak: 12, periodStart: '2026-08-17', freezesUsedThisPeriod: 2,
    freezeRefresh: 'weekly', lastRecordedKey: '2026-08-18' };
  const r = E.applyRestart(s, cat, '2026-12-01');
  assert.strictEqual(r.periodStart, '2026-12-01');
  assert.strictEqual(r.freezesUsedThisPeriod, 0);      // full allowance back
  assert.strictEqual(E.freezesLeft(cat, r), 2);
  assert.strictEqual(r.freezeRefresh, 'weekly');
  assert.strictEqual(r.streak, 12);                     // history is kept
  assert.strictEqual(r.lastRecordedKey, '2026-08-18');
  // Unlike applyRefresh, it returns a bare state — there is no bonus event.
  assert.strictEqual(r.event, undefined);
});

test('applyRestart advances since to the restart period', () => {
  const cat = Object.assign({}, CAT, { freezesPerPeriod: 2, freezeRefresh: 'weekly' });
  const s = { streak: 12, periodStart: '2026-08-17', freezesUsedThisPeriod: 2,
    freezeRefresh: 'weekly', lastRecordedKey: '2026-08-18', since: '2026-01-05' };
  // The archived stretch was never settled, so re-settlement must not reach it.
  assert.strictEqual(E.applyRestart(s, cat, '2026-12-01').since, '2026-12-01');
});

test('applyRestart and applyRebase differ on the spent count', () => {
  const weekly = Object.assign({}, CAT, { freezesPerPeriod: 2, freezeRefresh: 'weekly' });
  const monthly = Object.assign({}, weekly, { freezeRefresh: 'monthly' });
  const s = { streak: 3, periodStart: '2026-08-17', freezesUsedThisPeriod: 1, freezeRefresh: 'weekly' };
  // Cadence edit: same period, new rule — what you spent, you spent.
  assert.strictEqual(E.applyRebase(s, monthly, '2026-08-01').freezesUsedThisPeriod, 1);
  // Resuming after a dormant stretch: a genuinely new period.
  assert.strictEqual(E.applyRestart(s, weekly, '2026-12-01').freezesUsedThisPeriod, 0);
});

// Amend-past-answers: period/key helpers

test('periodKeyDate maps weekly keys to their ISO Monday and passes dates through', () => {
  assert.strictEqual(E.periodKeyDate('2026-06-22'), '2026-06-22');
  // 2026-06-22 is the Monday of ISO week 26 (see periodKeyFor test above)
  assert.strictEqual(E.periodKeyDate('2026-W26'), '2026-06-22');
  // ISO week 1 of 2026 starts in December 2025
  assert.strictEqual(E.periodKeyDate('2026-W01'), '2025-12-29');
});

test('periodKeyDate maps a monthly key to its first day', () => {
  assert.strictEqual(E.periodKeyDate('2026-08'), '2026-08-01');
});

test('periodKeyDate round-trips with isoWeek', () => {
  assert.strictEqual(E.isoWeek(E.periodKeyDate('2026-W26')), '2026-W26');
  assert.strictEqual(E.isoWeek(E.periodKeyDate('2026-W01')), '2026-W01');
});

test('freezePeriodStart buckets a date by refresh cadence', () => {
  assert.strictEqual(E.freezePeriodStart('daily', '2026-06-24'), '2026-06-24');
  assert.strictEqual(E.freezePeriodStart('weekly', '2026-06-24'), '2026-06-22'); // Wed -> Mon
  assert.strictEqual(E.freezePeriodStart('weekly', '2026-06-22'), '2026-06-22'); // Mon -> itself
  assert.strictEqual(E.freezePeriodStart('monthly', '2026-06-24'), '2026-06-01');
});

test('validPeriodKey accepts real keys and rejects malformed or impossible ones', () => {
  assert.strictEqual(E.validPeriodKey('daily', '2026-02-28'), true);
  assert.strictEqual(E.validPeriodKey('daily', '2026-02-31'), false); // not a real date
  assert.strictEqual(E.validPeriodKey('daily', '2026-W10'), false);   // wrong shape for cadence
  assert.strictEqual(E.validPeriodKey('weekly', '2026-W26'), true);
  assert.strictEqual(E.validPeriodKey('weekly', '2026-06-22'), false);
  assert.strictEqual(E.validPeriodKey('weekly', '2026-W53'), true);   // 2026 has 53 ISO weeks
  assert.strictEqual(E.validPeriodKey('weekly', '2025-W53'), false);  // 2025 has 52
});

test('isTrueFlag survives the sheet round-trip of booleans', () => {
  assert.strictEqual(E.isTrueFlag(true), true);
  assert.strictEqual(E.isTrueFlag('TRUE'), true);
  assert.strictEqual(E.isTrueFlag('true'), true);
  assert.strictEqual(E.isTrueFlag(false), false);
  assert.strictEqual(E.isTrueFlag(''), false);
  assert.strictEqual(E.isTrueFlag(undefined), false);
});

// Amend-past-answers: replayCategory

// Daily habit, weekly freeze refresh, 1 freeze, full miss penalty.
const RCAT = {
  id: 'sleep', cadence: 'daily', freezeRefresh: 'weekly',
  rewardIncrement: 0.25, maxPerInstance: 5.0, minPayout: 0,
  freezesPerPeriod: 1, unusedFreezeBonus: 3.5, missPenaltyPercent: 100,
};
const entry = (periodKey, result) => ({ id: 'id-' + periodKey, periodKey, result });

test('replayCategory rebuilds a straight streak with growing payouts', () => {
  // Mon..Wed of ISO week 26
  const r = E.replayCategory(RCAT,
    [entry('2026-06-22', 'on_time'), entry('2026-06-23', 'on_time'), entry('2026-06-24', 'on_time')],
    '2026-06-22');
  assert.deepStrictEqual(r.entries.map((e) => e.amount), [0.25, 0.5, 0.75]);
  assert.strictEqual(r.state.streak, 3);
  assert.strictEqual(r.state.lastRecordedKey, '2026-06-24');
  assert.strictEqual(r.state.freezesUsedThisPeriod, 0);
});

test('replayCategory spends one freeze then penalizes the second miss', () => {
  const r = E.replayCategory(RCAT, [
    entry('2026-06-22', 'on_time'),
    entry('2026-06-23', 'missed'),
    entry('2026-06-24', 'missed'),
    entry('2026-06-25', 'on_time'),
  ], '2026-06-22');
  assert.deepStrictEqual(r.entries.map((e) => e.freezeUsed), [false, true, false, false]);
  assert.deepStrictEqual(r.entries.map((e) => e.amount), [0.25, 0, 0, 0.25]);
  assert.strictEqual(r.state.streak, 1);
  assert.strictEqual(r.state.freezesUsedThisPeriod, 1);
});

test('replayCategory: flipping one answer cascades freezes and payouts', () => {
  // Same history as above but Tuesday corrected to on_time: Wednesday's miss
  // now gets the freeze, so Thursday continues the streak at step 3.
  const r = E.replayCategory(RCAT, [
    entry('2026-06-22', 'on_time'),
    entry('2026-06-23', 'on_time'),
    entry('2026-06-24', 'missed'),
    entry('2026-06-25', 'on_time'),
  ], '2026-06-22');
  assert.deepStrictEqual(r.entries.map((e) => e.freezeUsed), [false, false, true, false]);
  assert.deepStrictEqual(r.entries.map((e) => e.amount), [0.25, 0.5, 0, 0.75]);
  assert.strictEqual(r.state.streak, 3);
});

test('replayCategory sorts input and slots a gap-fill into place', () => {
  const r = E.replayCategory(RCAT,
    [entry('2026-06-24', 'on_time'), entry('2026-06-22', 'on_time'), entry('2026-06-23', 'on_time')],
    '2026-06-22');
  assert.deepStrictEqual(r.entries.map((e) => e.periodKey),
    ['2026-06-22', '2026-06-23', '2026-06-24']);
  assert.deepStrictEqual(r.entries.map((e) => e.amount), [0.25, 0.5, 0.75]);
});

test('replayCategory refreshes freezes at each freeze-period boundary', () => {
  // A miss in week 25 and a miss in week 26 each get their own freeze.
  const r = E.replayCategory(RCAT, [
    entry('2026-06-18', 'missed'),  // Thu, week 25
    entry('2026-06-23', 'missed'),  // Tue, week 26
  ], '2026-06-22');
  assert.deepStrictEqual(r.entries.map((e) => e.freezeUsed), [true, true]);
  assert.strictEqual(r.state.streak, 0);
  // Only the current period's spend is live state.
  assert.strictEqual(r.state.freezesUsedThisPeriod, 1);
});

test('replayCategory counts no live freezes when the last entries are in a closed period', () => {
  const r = E.replayCategory(RCAT, [entry('2026-06-18', 'missed')], '2026-06-22');
  assert.strictEqual(r.state.freezesUsedThisPeriod, 0);
});

test('replayCategory orders mixed weekly and daily keys on one calendar', () => {
  const r = E.replayCategory(RCAT,
    [entry('2026-06-22', 'on_time'), entry('2026-W25', 'on_time')],
    '2026-06-22');
  // Week 25's Monday (June 15) sorts before June 22.
  assert.deepStrictEqual(r.entries.map((e) => e.periodKey), ['2026-W25', '2026-06-22']);
  assert.strictEqual(r.state.streak, 2);
});

test('replayCategory applies missPenaltyPercent and preserves extra fields', () => {
  const half = Object.assign({}, RCAT, { missPenaltyPercent: 50, freezesPerPeriod: 0 });
  const rows = [
    { id: 'a', rowNumber: 7, periodKey: '2026-06-22', result: 'on_time' },
    { id: 'b', rowNumber: 8, periodKey: '2026-06-23', result: 'on_time' },
    { id: 'c', rowNumber: 9, periodKey: '2026-06-24', result: 'missed' },
  ];
  const r = E.replayCategory(half, rows, '2026-06-22');
  assert.strictEqual(r.state.streak, 1); // round(2 * 0.5)
  assert.strictEqual(r.entries[2].id, 'c');
  assert.strictEqual(r.entries[2].rowNumber, 9);
});

test('replayCategory of no entries is an empty state', () => {
  const r = E.replayCategory(RCAT, [], '2026-06-22');
  assert.deepStrictEqual(r.entries, []);
  assert.strictEqual(r.state.streak, 0);
  assert.strictEqual(r.state.lastRecordedKey, null);
  assert.strictEqual(r.state.freezesUsedThisPeriod, 0);
});

// Amend-past-answers: the replay window

const fentry = (periodKey, result, freezeUsed) => ({ periodKey, result, freezeUsed });

test('inReplayWindow admits the edited period and everything after it', () => {
  assert.strictEqual(E.inReplayWindow('2026-06-21', '2026-06-22'), false);
  assert.strictEqual(E.inReplayWindow('2026-06-22', '2026-06-22'), true);
  assert.strictEqual(E.inReplayWindow('2026-06-23', '2026-06-22'), true);
});

test('inReplayWindow compares mixed cadence keys on the calendar', () => {
  // 2026-W26 starts Monday 2026-06-22, so that Sunday is outside the window.
  assert.strictEqual(E.inReplayWindow('2026-W25', '2026-W26'), false);
  assert.strictEqual(E.inReplayWindow('2026-W26', '2026-W26'), true);
  assert.strictEqual(E.inReplayWindow('2026-06-21', '2026-W26'), false);
  assert.strictEqual(E.inReplayWindow('2026-06-22', '2026-W26'), true);
});

test('inReplayWindow admits everything when no period was edited', () => {
  assert.strictEqual(E.inReplayWindow('2026-06-01', null), true);
  assert.strictEqual(E.inReplayWindow('2026-06-01', ''), true);
});

test('replayFrom returns only the edited period onward, but a streak carried through the whole history', () => {
  const rows = [
    { id: 'a', periodKey: '2026-06-22', result: 'on_time' },
    { id: 'b', periodKey: '2026-06-23', result: 'on_time' },
    { id: 'c', periodKey: '2026-06-24', result: 'on_time' },
  ];
  const r = E.replayFrom(RCAT, rows, '2026-06-22', '2026-06-24');
  assert.deepStrictEqual(r.entries.map((e) => e.id), ['c']);
  // Streak counts a and b even though their rows are out of the window.
  assert.strictEqual(r.state.streak, 3);
  assert.strictEqual(r.entries[0].amount, E.payout(RCAT, 3));
});

test('replayFrom leaves earlier rows alone when a setting changed since they were written', () => {
  // The whole point: raising minPayout must not re-price history that a later
  // edit happens to replay past.
  const raised = Object.assign({}, RCAT, { minPayout: 2 });
  const rows = [
    { id: 'a', periodKey: '2026-06-22', result: 'on_time', amount: 0.25 },
    { id: 'b', periodKey: '2026-06-23', result: 'on_time', amount: 0.5 },
  ];
  const r = E.replayFrom(raised, rows, '2026-06-22', '2026-06-23');
  assert.deepStrictEqual(r.entries.map((e) => e.id), ['b']);
  assert.strictEqual(r.entries[0].amount, 2.25); // minPayout 2 + one increment
});

test('replayFrom with no window is replayCategory', () => {
  const rows = [{ id: 'a', periodKey: '2026-06-22', result: 'on_time' }];
  assert.deepStrictEqual(
    E.replayFrom(RCAT, rows, '2026-06-22', null),
    E.replayCategory(RCAT, rows, '2026-06-22'));
});

test('periodHasEntries sees only entries inside the given freeze period', () => {
  const entries = [fentry('2026-06-18', 'on_time', false), fentry('2026-06-23', 'missed', true)];
  assert.strictEqual(E.periodHasEntries(RCAT, entries, '2026-06-15'), true);
  assert.strictEqual(E.periodHasEntries(RCAT, entries, '2026-06-22'), true);
  assert.strictEqual(E.periodHasEntries(RCAT, entries, '2026-06-08'), false);
  assert.strictEqual(E.periodHasEntries(RCAT, [], '2026-06-15'), false);
});

test('periodHasEntries buckets weekly keys and honours a monthly freeze cadence', () => {
  assert.strictEqual(E.periodHasEntries(RCAT, [fentry('2026-W25', 'on_time', false)], '2026-06-15'), true);
  const monthly = Object.assign({}, RCAT, { freezeRefresh: 'monthly' });
  assert.strictEqual(E.periodHasEntries(monthly, [fentry('2026-06-18', 'on_time', false)], '2026-06-01'), true);
  assert.strictEqual(E.periodHasEntries(monthly, [fentry('2026-06-18', 'on_time', false)], '2026-07-01'), false);
});

// Amend-past-answers: `since` on per-user state

test('initialCatState carries since as the periodStart it was created with', () => {
  const s = E.initialCatState(CAT, '2026-06-22');
  assert.strictEqual(s.since, '2026-06-22');
});

test('migrateCatState backfills since from periodStart on an old-shape state, and leaves an existing since alone', () => {
  const cat2 = Object.assign({}, CAT, { freezesPerPeriod: 2 });
  const legacy = { streak: 3, periodStart: '2026-06-22', freezeAvailable: 1 };
  const s = E.migrateCatState(cat2, legacy);
  assert.strictEqual(s.since, '2026-06-22');

  const withSince = { streak: 3, periodStart: '2026-06-22', freezeAvailable: 1, since: '2026-01-05' };
  assert.strictEqual(E.migrateCatState(cat2, withSince).since, '2026-01-05');
});

// House chores: cadences and category model

test('periodKeyFor handles monthly and once', () => {
  assert.strictEqual(E.periodKeyFor('monthly', '2026-08-25'), '2026-08');
  assert.strictEqual(E.periodKeyFor('once', '2026-08-25'), 'once');
});

test('validPeriodKey handles monthly and once', () => {
  assert.strictEqual(E.validPeriodKey('monthly', '2026-08'), true);
  assert.strictEqual(E.validPeriodKey('monthly', '2026-13'), false);
  assert.strictEqual(E.validPeriodKey('monthly', '2026-08-25'), false);
  assert.strictEqual(E.validPeriodKey('once', 'once'), true);
  assert.strictEqual(E.validPeriodKey('once', '2026-08-25'), false);
});

test('claimablePeriodKey is the CURRENT period per cadence', () => {
  assert.strictEqual(E.claimablePeriodKey({ cadence: 'daily' }, '2026-08-25'), '2026-08-25');
  assert.strictEqual(E.claimablePeriodKey({ cadence: 'weekly' }, '2026-06-24'), '2026-W26');
  assert.strictEqual(E.claimablePeriodKey({ cadence: 'monthly' }, '2026-08-25'), '2026-08');
  assert.strictEqual(E.claimablePeriodKey({ cadence: 'once' }, '2026-08-25'), 'once');
});

test('normalizeCategory builds a chore shape and defaults habits to kind habit', () => {
  const chore = E.normalizeCategory({
    kind: 'chore', name: 'Dishes', emoji: '🧹', cadence: 'daily',
    value: '2', assignee: 'SNIC9004@GMAIL.COM', dueDate: '',
    reminderTime: '19:00',
  });
  assert.strictEqual(chore.kind, 'chore');
  assert.strictEqual(chore.id, 'dishes');
  assert.strictEqual(chore.value, 2);
  assert.strictEqual(chore.assignee, 'snic9004@gmail.com');
  assert.strictEqual(chore.dueDate, '');
  assert.strictEqual(chore.active, true);
  assert.strictEqual(chore.rewardIncrement, undefined);

  const habit = E.normalizeCategory({ name: 'Sleep', cadence: 'daily', rewardIncrement: 0.25, maxPerInstance: 5, freezesPerPeriod: 1 });
  assert.strictEqual(habit.kind, 'habit');
  assert.strictEqual(habit.rewardIncrement, 0.25);
});

test('validateCategory: chore rules', () => {
  const base = { id: 'shed', name: 'Shed', emoji: '', kind: 'chore', cadence: 'once', value: 5, assignee: '', dueDate: '2026-09-30', reminderTime: '' };
  assert.deepStrictEqual(E.validateCategory(base), []);
  assert.ok(E.validateCategory(Object.assign({}, base, { value: 0 })).some((e) => /value/i.test(e)));
  assert.ok(E.validateCategory(Object.assign({}, base, { cadence: 'yearly' })).some((e) => /cadence/i.test(e)));
  assert.ok(E.validateCategory(Object.assign({}, base, { dueDate: '2026-02-31' })).some((e) => /due date/i.test(e)));
  // A due date only makes sense for once-cadence
  assert.ok(E.validateCategory(Object.assign({}, base, { cadence: 'daily', dueDate: '2026-09-30' })).some((e) => /due date/i.test(e)));
  assert.ok(E.validateCategory(Object.assign({}, base, { assignee: 'not-an-email' })).some((e) => /assignee/i.test(e)));
  // Habit validation unchanged
  assert.ok(E.validateCategory(E.normalizeCategory({ name: 'x', cadence: 'daily' })).some((e) => /increment/i.test(e)));
});

// House chores: claim/pot/sweep helpers

const CHORE = { id: 'dishes', name: 'Dishes', kind: 'chore', cadence: 'daily', value: 2, assignee: '', dueDate: '', active: true };
const ACHORE = Object.assign({}, CHORE, { id: 'trash', assignee: 'a@x.com' });
const crow = (type, periodKey, actor, amount) => ({ type, category: 'dishes', periodKey, actor, amount });

test('isChoreClaimed sees any actor and only claim rows', () => {
  const rows = [crow('claim', '2026-08-24', 'b@x.com', 2), crow('penalty', '2026-08-23', 'a@x.com', -1)];
  assert.strictEqual(E.isChoreClaimed(rows, 'dishes', '2026-08-24'), true);
  assert.strictEqual(E.isChoreClaimed(rows, 'dishes', '2026-08-23'), false);
  assert.strictEqual(E.isChoreClaimed(rows, 'other', '2026-08-24'), false);
});

test('chorePotFor sums penalties, outstandingChorePeriods lists unclaimed penalized periods', () => {
  const rows = [
    crow('penalty', '2026-08-22', 'a@x.com', -1), crow('penalty', '2026-08-22', 'b@x.com', -1),
    crow('penalty', '2026-08-23', 'a@x.com', -1), crow('penalty', '2026-08-23', 'b@x.com', -1),
    crow('claim', '2026-08-23', 'b@x.com', 4),
  ];
  assert.strictEqual(E.chorePotFor(rows, 'dishes', '2026-08-22'), 2);
  assert.strictEqual(E.chorePotFor(rows, 'dishes', '2026-08-21'), 0);
  assert.deepStrictEqual(E.outstandingChorePeriods(rows, 'dishes'), [{ periodKey: '2026-08-22', pot: 2 }]);
});

test('nextChorePeriodKey steps each cadence', () => {
  assert.strictEqual(E.nextChorePeriodKey('daily', '2026-08-31'), '2026-09-01');
  assert.strictEqual(E.nextChorePeriodKey('weekly', '2026-W26'), '2026-W27');
  assert.strictEqual(E.nextChorePeriodKey('weekly', '2026-W53'), '2027-W01');
  assert.strictEqual(E.nextChorePeriodKey('monthly', '2026-12'), '2027-01');
});

test('chorePenaltyAmounts: shared halves, assigned full', () => {
  assert.deepStrictEqual(E.chorePenaltyAmounts(CHORE, ['a@x.com', 'b@x.com']),
    [{ actor: 'a@x.com', amount: -1 }, { actor: 'b@x.com', amount: -1 }]);
  assert.deepStrictEqual(E.chorePenaltyAmounts(ACHORE, ['a@x.com', 'b@x.com']),
    [{ actor: 'a@x.com', amount: -2 }]);
});

test('chorePayout: shared collects the pot, assigned only the value', () => {
  assert.strictEqual(E.chorePayout(CHORE, 2), 4);
  assert.strictEqual(E.chorePayout(CHORE, 0), 2);
  assert.strictEqual(E.chorePayout(ACHORE, 2), 2);
});

// Weekly due days + pause resume

test('normalizeCategory keeps a chore dueDay, lowercased; defaults blank', () => {
  const c = E.normalizeCategory({ kind: 'chore', name: 'Trash', cadence: 'weekly', value: 2, dueDay: 'Wed' });
  assert.strictEqual(c.dueDay, 'wed');
  const d = E.normalizeCategory({ kind: 'chore', name: 'Dishes', cadence: 'daily', value: 2 });
  assert.strictEqual(d.dueDay, '');
});

test('validateCategory allows dueDay only on weekly chores', () => {
  const base = { kind: 'chore', name: 'Trash', cadence: 'weekly', value: 2 };
  const ok = E.normalizeCategory(Object.assign({}, base, { dueDay: 'wed' }));
  assert.deepStrictEqual(E.validateCategory(ok), []);
  const blank = E.normalizeCategory(base);
  assert.deepStrictEqual(E.validateCategory(blank), []);
  const daily = E.normalizeCategory(Object.assign({}, base, { cadence: 'daily', dueDay: 'wed' }));
  assert.ok(E.validateCategory(daily).length > 0, 'dueDay on a daily chore must be rejected');
  const junk = E.normalizeCategory(Object.assign({}, base, { dueDay: 'someday' }));
  assert.ok(E.validateCategory(junk).length > 0, 'unknown day name must be rejected');
});

test('choreDueDateFor: daily is the day, weekly honors dueDay, monthly is month end', () => {
  assert.strictEqual(E.choreDueDateFor({ cadence: 'daily' }, '2026-06-22'), '2026-06-22');
  // 2026-W26 runs Mon 2026-06-22 .. Sun 2026-06-28
  assert.strictEqual(E.choreDueDateFor({ cadence: 'weekly', dueDay: '' }, '2026-W26'), '2026-06-28');
  assert.strictEqual(E.choreDueDateFor({ cadence: 'weekly', dueDay: 'wed' }, '2026-W26'), '2026-06-24');
  assert.strictEqual(E.choreDueDateFor({ cadence: 'monthly' }, '2026-02'), '2026-02-28');
  assert.strictEqual(E.choreDueDateFor({ cadence: 'monthly' }, '2028-02'), '2028-02-29');
});

test('chorePeriodClosed: a period closes the day after its due date', () => {
  const wed = { cadence: 'weekly', dueDay: 'wed' };
  assert.strictEqual(E.chorePeriodClosed(wed, '2026-W26', '2026-06-24'), false);
  assert.strictEqual(E.chorePeriodClosed(wed, '2026-W26', '2026-06-25'), true);
  const plain = { cadence: 'weekly', dueDay: '' };
  assert.strictEqual(E.chorePeriodClosed(plain, '2026-W26', '2026-06-28'), false);
  assert.strictEqual(E.chorePeriodClosed(plain, '2026-W26', '2026-06-29'), true);
  assert.strictEqual(E.chorePeriodClosed({ cadence: 'daily' }, '2026-06-22', '2026-06-22'), false);
  assert.strictEqual(E.chorePeriodClosed({ cadence: 'daily' }, '2026-06-22', '2026-06-23'), true);
  assert.strictEqual(E.chorePeriodClosed({ cadence: 'monthly' }, '2026-06', '2026-06-30'), false);
  assert.strictEqual(E.chorePeriodClosed({ cadence: 'monthly' }, '2026-06', '2026-07-01'), true);
});

test('resumeSweepFrom skips periods that closed during a pause, without penalizing', () => {
  assert.strictEqual(E.resumeSweepFrom({ cadence: 'daily' }, '2026-06-20', '2026-06-25'), '2026-06-25');
  // Thu 2026-06-25 is past W26's Wednesday due day → W25 and W26 both forgiven
  assert.strictEqual(E.resumeSweepFrom({ cadence: 'weekly', dueDay: 'wed' }, '2026-W25', '2026-06-25'), '2026-W27');
  // On the due day itself the week is still open
  assert.strictEqual(E.resumeSweepFrom({ cadence: 'weekly', dueDay: 'wed' }, '2026-W25', '2026-06-24'), '2026-W26');
  // Already-open sweepFrom is untouched
  assert.strictEqual(E.resumeSweepFrom({ cadence: 'daily' }, '2026-06-25', '2026-06-25'), '2026-06-25');
});

// Notes, per-day penalty accrual, dashboard grouping

test('normalizeCategory keeps notes on both kinds; validateCategory caps their length', () => {
  const h = E.normalizeCategory({ name: 'Sleep', cadence: 'daily', rewardIncrement: 1, maxPerInstance: 5, freezesPerPeriod: 0, notes: '  wind down by 9  ' });
  assert.strictEqual(h.notes, 'wind down by 9');
  const c = E.normalizeCategory({ kind: 'chore', name: 'Trash', cadence: 'weekly', value: 2, notes: 'bins + recycling' });
  assert.strictEqual(c.notes, 'bins + recycling');
  const none = E.normalizeCategory({ kind: 'chore', name: 'Trash', cadence: 'weekly', value: 2 });
  assert.strictEqual(none.notes, '');
  const long = E.normalizeCategory({ kind: 'chore', name: 'Trash', cadence: 'weekly', value: 2, notes: 'x'.repeat(2001) });
  assert.ok(E.validateCategory(long).length > 0, 'notes over 2000 chars must be rejected');
  assert.deepStrictEqual(E.validateCategory(c), []);
});

test('choreDrainCount counts drains, not rows: shared chores charge two wallets per drain', () => {
  const rows = [
    { type: 'penalty', category: 'trash', periodKey: '2026-W26', actor: 'a@x.com', amount: -1 },
    { type: 'penalty', category: 'trash', periodKey: '2026-W26', actor: 'b@x.com', amount: -1 },
    { type: 'penalty', category: 'trash', periodKey: '2026-W26', actor: 'a@x.com', amount: -1 },
    { type: 'penalty', category: 'trash', periodKey: '2026-W26', actor: 'b@x.com', amount: -1 },
    { type: 'penalty', category: 'office', periodKey: '2026-06', actor: 'a@x.com', amount: -3 },
  ];
  assert.strictEqual(E.choreDrainCount(rows, 'trash', '2026-W26'), 2);
  assert.strictEqual(E.choreDrainCount(rows, 'trash', '2026-W25'), 0);
  assert.strictEqual(E.choreDrainCount(rows, 'office', '2026-06'), 1);
  // The count must not depend on how the chore is shared TODAY: rows written
  // while it was shared would otherwise read as one drain per wallet the moment
  // it gains an assignee, tripping the cap at half the days.
  const nowAssigned = [
    { type: 'penalty', category: 'trash', periodKey: '2026-W27', actor: 'a@x.com', amount: -1 },
    { type: 'penalty', category: 'trash', periodKey: '2026-W27', actor: 'b@x.com', amount: -1 },
    { type: 'penalty', category: 'trash', periodKey: '2026-W27', actor: 'a@x.com', amount: -2 },
  ];
  assert.strictEqual(E.choreDrainCount(nowAssigned, 'trash', '2026-W27'), 2,
    'two drains: one shared, one after the chore was assigned');
});

test('shiftDays names the value it could not read', () => {
  assert.throws(() => E.shiftDays('once', 1), /shiftDays\("once", 1\)/);
  assert.throws(() => E.shiftDays('2026-09', 1), /YYYY-MM-DD/);
  assert.throws(() => E.shiftDays('2026-09-01', NaN), /shiftDays/);
  assert.strictEqual(E.shiftDays('2026-09-01', 1), '2026-09-02');
});

test('choreKeyFitsCadence: a key is only usable by the cadence that wrote it', () => {
  assert.strictEqual(E.choreKeyFitsCadence('daily', '2026-09-01'), true);
  assert.strictEqual(E.choreKeyFitsCadence('daily', '2026-09'), false);
  assert.strictEqual(E.choreKeyFitsCadence('weekly', '2026-W36'), true);
  assert.strictEqual(E.choreKeyFitsCadence('weekly', 'done'), false);
  assert.strictEqual(E.choreKeyFitsCadence('monthly', '2026-09'), true);
  assert.strictEqual(E.choreKeyFitsCadence('monthly', '2026-W36'), false);
  assert.strictEqual(E.choreKeyFitsCadence('once', 'once'), true);
  assert.strictEqual(E.choreKeyFitsCadence('once', 'done'), true, 'the settled sentinel is legal');
  assert.strictEqual(E.choreKeyFitsCadence('once', '2026-09-01'), false);
});

test('repairChoreState restarts tracking when a stored key predates the cadence', () => {
  const weekly = { id: 'trash', cadence: 'weekly' };
  const sound = { since: '2026-W26', sweepFrom: '2026-W26', chargedThrough: '2026-06-24' };
  assert.strictEqual(E.repairChoreState(weekly, sound, '2026-06-24'), sound,
    'a sound state is returned untouched, so nothing is written back');
  // A once-chore's sentinels left behind by an older deployment: every date walk
  // this cadence runs would throw on them.
  const stale = E.repairChoreState(weekly, { since: 'once', sweepFrom: 'done', chargedThrough: 'x' }, '2026-06-24');
  assert.deepStrictEqual(stale, { since: '2026-W26', sweepFrom: '2026-W26', chargedThrough: '2026-06-24' });
  assert.doesNotThrow(() => E.latestClosedPeriod(weekly, stale.sweepFrom, '2026-07-02'));
  // Only the unusable fields are rewritten.
  const half = E.repairChoreState({ id: 'd', cadence: 'daily' },
    { since: '2026-06-01', sweepFrom: '2026-06', chargedThrough: '2026-06-20' }, '2026-06-24');
  assert.deepStrictEqual(half, { since: '2026-06-01', sweepFrom: '2026-06-24', chargedThrough: '2026-06-20' });
  assert.strictEqual(E.repairChoreState(weekly, null, '2026-06-24'), null, 'nothing stored stays nothing');
  // A state written before daily accrual has no clock at all — that is not a fault.
  const noClock = { since: '2026-W26', sweepFrom: '2026-W26' };
  assert.strictEqual(E.repairChoreState(weekly, noClock, '2026-06-24'), noClock);
});

test('CHORE_ACCRUAL_CAP bounds how many days one period keeps draining', () => {
  assert.strictEqual(E.CHORE_ACCRUAL_CAP, 5);
});

test('choreGroup: overdue and daily land today, weekly waits for its due day, monthly sinks', () => {
  // 2026-06-24 is the Wednesday of 2026-W26
  const wed = { cadence: 'weekly', dueDay: 'wed' };
  assert.strictEqual(E.choreGroup(wed, '2026-06-24', false), 'today');
  assert.strictEqual(E.choreGroup(wed, '2026-06-23', false), 'week');
  assert.strictEqual(E.choreGroup(wed, '2026-06-23', true), 'today', 'an accruing pot needs attention now');
  assert.strictEqual(E.choreGroup({ cadence: 'daily' }, '2026-06-24', false), 'today');
  assert.strictEqual(E.choreGroup({ cadence: 'monthly' }, '2026-06-24', false), 'month');
  assert.strictEqual(E.choreGroup({ cadence: 'monthly' }, '2026-06-24', true), 'today');
  assert.strictEqual(E.choreGroup({ cadence: 'once', dueDate: '2026-06-24' }, '2026-06-24', false), 'today');
  assert.strictEqual(E.choreGroup({ cadence: 'once', dueDate: '2026-07-01' }, '2026-06-24', false), 'month');
  assert.strictEqual(E.choreGroup({ cadence: 'once', dueDate: '' }, '2026-06-24', false), 'month');
});

test('latestClosedPeriod finds the newest period past its due date', () => {
  const wed = { cadence: 'weekly', dueDay: 'wed' };
  // 2026-W26: Mon 06-22, due Wed 06-24. W27 due 07-01, W28 due 07-08.
  assert.strictEqual(E.latestClosedPeriod(wed, '2026-W26', '2026-06-24'), null, 'nothing closed yet');
  assert.strictEqual(E.latestClosedPeriod(wed, '2026-W26', '2026-06-25'), '2026-W26');
  assert.strictEqual(E.latestClosedPeriod(wed, '2026-W26', '2026-07-02'), '2026-W27', 'older weeks are superseded');
  assert.strictEqual(E.latestClosedPeriod({ cadence: 'daily' }, '2026-06-22', '2026-06-28'), '2026-06-27');
  assert.strictEqual(E.latestClosedPeriod({ cadence: 'monthly' }, '2026-06', '2026-08-15'), '2026-07');
});

test('isoDow rejects what it cannot read instead of passing for Sunday', () => {
  assert.strictEqual(E.isoDow('2026-09-01'), 2, 'Tuesday');
  assert.strictEqual(E.isoDow('2026-09-06'), 7, 'Sunday');
  // A Date-typed sheet cell stringifies to this; it used to read as Sunday and
  // then throw a contextless "Invalid time value" inside shiftDays.
  assert.throws(() => E.isoDow('Tue Sep 01 2026 00:00:00 GMT-0600 (MDT)'), /isoDow\(/);
  assert.throws(() => E.isoDow(''), /YYYY-MM-DD/);
  assert.throws(() => E.freezePeriodStart('weekly', ''), /isoDow\(/);
});

/* ── fortnightly chores ────────────────────────────────────────────────── */
const FORTNIGHT = { id: 'bins', kind: 'chore', name: 'Bins', cadence: 'biweekly', value: 4, assignee: '', dueDay: '', dueDate: '' };

test('biweekly: a date keys to the ISO week its fortnight starts on', () => {
  assert.strictEqual(E.periodKeyFor('biweekly', '2026-09-07'), '2026-W37');
  assert.strictEqual(E.periodKeyFor('biweekly', '2026-09-20'), '2026-W37');
  assert.strictEqual(E.periodKeyFor('biweekly', '2026-09-21'), '2026-W39');
  // The grid keeps counting by 14 days across a 53-week year.
  assert.strictEqual(E.periodKeyFor('biweekly', '2027-01-05'), '2026-W53');
});

test('biweekly: the next period is two weeks on', () => {
  assert.strictEqual(E.nextChorePeriodKey('biweekly', '2026-W37'), '2026-W39');
  assert.strictEqual(E.nextChorePeriodKey('biweekly', '2026-W53'), '2027-W02');
});

test('biweekly: only fortnight-start weeks are valid keys', () => {
  assert.strictEqual(E.validPeriodKey('biweekly', '2026-W37'), true);
  assert.strictEqual(E.validPeriodKey('biweekly', '2026-W38'), false);
  assert.strictEqual(E.validPeriodKey('biweekly', '2026-09-07'), false);
});

test('biweekly: due on the second Sunday, or the due day of the second week', () => {
  assert.strictEqual(E.choreDueDateFor(FORTNIGHT, '2026-W37'), '2026-09-20');
  assert.strictEqual(E.choreDueDateFor(Object.assign({}, FORTNIGHT, { dueDay: 'wed' }), '2026-W37'), '2026-09-16');
});

test('biweekly: grouped as today on the due day, otherwise coming up', () => {
  assert.strictEqual(E.choreGroup(FORTNIGHT, '2026-09-09', false), 'week');
  assert.strictEqual(E.choreGroup(FORTNIGHT, '2026-09-20', false), 'today');
});

test('biweekly: normalize keeps the cadence and validate accepts a due day', () => {
  const cat = E.normalizeCategory(Object.assign({}, FORTNIGHT, { dueDay: 'sat' }));
  assert.strictEqual(cat.cadence, 'biweekly');
  assert.deepStrictEqual(E.validateCategory(cat), []);
});
