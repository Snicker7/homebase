/**
 * Sleep Streak — reward engine (pure functions).
 *
 * No Apps Script or Node globals are used here, so this file is shared by:
 *   - the Node test suite (engine.test.js), and
 *   - the Apps Script backend (Code.gs includes this logic).
 *
 * All rules live here so there is exactly one source of truth.
 */

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * On-time payout for a given streak under a category's rules.
 * `minPayout` starts the curve (streak 1 pays it); each further step adds one
 * increment. Blank/0 means "start at the increment", i.e. the original curve.
 */
function payout(cat, streak) {
  if (streak <= 0) return 0;
  var start = cat.minPayout > 0 ? cat.minPayout : cat.rewardIncrement;
  return round2(Math.min(start + (streak - 1) * cat.rewardIncrement, cat.maxPerInstance));
}

/** ISO-8601 week string, e.g. "2026-W26", for a "YYYY-MM-DD" date. */
function isoWeek(dateStr) {
  var p = dateStr.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  var day = d.getUTCDay() || 7; // 1=Mon..7=Sun
  d.setUTCDate(d.getUTCDate() + 4 - day); // nearest Thursday
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + '-W' + ('0' + weekNo).slice(-2);
}

/** Record-cadence key used to dedupe entries within a period. */
function periodKeyFor(cadence, dateStr) {
  if (cadence === 'weekly') return isoWeek(dateStr);
  if (cadence === 'monthly') return String(dateStr).slice(0, 7);
  if (cadence === 'once') return 'once';
  return dateStr;
}

/** "YYYY-MM-DD" shifted by n days (UTC math, so DST can't skew it). */
function shiftDays(dateStr, n) {
  var p = String(dateStr).split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  // toISOString on an unparseable date throws a bare "Invalid time value",
  // which names neither the bad key nor the walk that used it — and this is the
  // one funnel every date walk in the app goes through.
  if (isNaN(d.getTime())) {
    throw new Error('shiftDays(' + JSON.stringify(String(dateStr)) + ', ' + n +
      '): expected a "YYYY-MM-DD" date');
  }
  return d.toISOString().slice(0, 10);
}

/**
 * The ISO Monday of the week containing `dateStr`, as "YYYY-MM-DD".
 *
 * Takes the day-of-week as an argument rather than subtracting 24-hour
 * multiples from a timestamp: an hour of DST shift is enough to push that
 * arithmetic onto the wrong calendar day, which silently starts a new freeze
 * period (and pays a second unused-freeze bonus).
 *
 * @param dateStr  "YYYY-MM-DD" in the app timezone
 * @param dow      ISO day-of-week for dateStr, 1=Mon..7=Sun
 */
function mondayOf(dateStr, dow) {
  return shiftDays(dateStr, -(dow - 1));
}

/** ISO day-of-week, 1=Mon..7=Sun, for "YYYY-MM-DD" (UTC math, DST-proof). */
function isoDow(dateStr) {
  var p = String(dateStr).split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  // `getUTCDay() || 7` turns NaN into 7, so an unreadable date used to pass
  // for Sunday and blow up one frame later inside shiftDays, with the caller's
  // value nowhere in the message.
  if (isNaN(d.getTime())) {
    throw new Error('isoDow(' + JSON.stringify(String(dateStr)) + '): expected a "YYYY-MM-DD" date');
  }
  return d.getUTCDay() || 7;
}

/**
 * Calendar date a period key sits on: a daily key is itself, a weekly key is
 * its ISO week's Monday. Gives replay a single axis to sort and bucket mixed
 * keys (a habit whose cadence was edited can hold both forms).
 */
function periodKeyDate(periodKey) {
  // A monthly chore key ("YYYY-MM") needs a calendar date too, so it sorts and
  // buckets on the same axis as daily/weekly keys instead of falling through
  // to the "return as-is" case below.
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(periodKey))) return periodKey + '-01';
  var m = /^(\d{4})-W(\d{2})$/.exec(String(periodKey));
  if (!m) return String(periodKey);
  // ISO week 1 is the week containing Jan 4.
  var jan4 = m[1] + '-01-04';
  var week1Monday = shiftDays(jan4, -(isoDow(jan4) - 1));
  return shiftDays(week1Monday, (Number(m[2]) - 1) * 7);
}

/** First day of the freeze period containing `dateStr`. */
function freezePeriodStart(freezeRefresh, dateStr) {
  if (freezeRefresh === 'daily') return dateStr;
  if (freezeRefresh === 'monthly') return dateStr.slice(0, 8) + '01';
  return mondayOf(dateStr, isoDow(dateStr));
}

/** Is `key` a real period key for this cadence? (Rejects 2026-02-31 and W53 in a 52-week year.) */
function validPeriodKey(cadence, key) {
  key = String(key || '');
  if (cadence === 'weekly') {
    if (!/^\d{4}-W\d{2}$/.test(key)) return false;
    return isoWeek(periodKeyDate(key)) === key;
  }
  if (cadence === 'monthly') {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(key);
  }
  if (cadence === 'once') return key === 'once';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  var p = key.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  return d.toISOString().slice(0, 10) === key;
}

/**
 * The period a chore claim targets RIGHT NOW. Chores are logged the day
 * they're done, so this is the current period — unlike habits, which record
 * the last closed one.
 */
function claimablePeriodKey(cat, dateStr) {
  return periodKeyFor(cat.cadence, dateStr);
}

/* ── house chores ──────────────────────────────────────────────────────── */
/** Can this cadence's date math read `key`? ("done" marks a settled one-time chore.) */
function choreKeyFitsCadence(cadence, key) {
  if (cadence === 'once') return key === 'once' || key === 'done';
  return validPeriodKey(cadence, key);
}

/**
 * Chore state whose keys this cadence can actually walk.
 *
 * A key stored under a different cadence — or by an older version of this code
 * — is unreadable to the current one, and every path that touches it (the
 * sweep, the dashboard, the reminder emails) hands it to date math that throws.
 * One such record takes down the dashboard AND every email at once. Restart
 * tracking at the current period instead, exactly as a cadence edit does.
 * Returns `state` itself when it is sound, so callers can tell whether there is
 * anything to save.
 */
function repairChoreState(cat, state, todayStr) {
  if (!state) return state;
  var fits = function (k) { return choreKeyFitsCadence(cat.cadence, k); };
  var charged = state.chargedThrough;
  var chargedOk = charged == null || validPeriodKey('daily', charged);
  if (fits(state.since) && fits(state.sweepFrom) && chargedOk) return state;
  var cur = claimablePeriodKey(cat, todayStr);
  var s = Object.assign({}, state);
  if (!fits(s.since)) s.since = cur;
  if (!fits(s.sweepFrom)) s.sweepFrom = cur;
  if (!chargedOk) s.chargedThrough = todayStr;
  return s;
}



/** One claim per period per CHORE, whoever made it. */
function isChoreClaimed(rows, categoryId, periodKey) {
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.type === 'claim' && String(r.category) === String(categoryId) &&
        String(r.periodKey) === String(periodKey)) return true;
  }
  return false;
}

/** What an unclaimed period has drained so far — the amount a late claim collects. */
function chorePotFor(rows, categoryId, periodKey) {
  var pot = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.type === 'penalty' && String(r.category) === String(categoryId) &&
        String(r.periodKey) === String(periodKey)) pot -= Number(r.amount) || 0;
  }
  return round2(pot);
}

/** Penalized periods still waiting for a doer, oldest first. */
function outstandingChorePeriods(rows, categoryId) {
  var seen = {};
  var keys = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.type !== 'penalty' || String(r.category) !== String(categoryId)) continue;
    var k = String(r.periodKey);
    if (!seen[k]) { seen[k] = true; keys.push(k); }
  }
  var out = [];
  keys.sort();
  for (var j = 0; j < keys.length; j++) {
    if (!isChoreClaimed(rows, categoryId, keys[j])) {
      out.push({ periodKey: keys[j], pot: chorePotFor(rows, categoryId, keys[j]) });
    }
  }
  return out;
}

/** The period after `key` — lets the sweep walk closed periods in order. */
function nextChorePeriodKey(cadence, key) {
  if (cadence === 'weekly') return isoWeek(shiftDays(periodKeyDate(key), 7));
  if (cadence === 'monthly') {
    var y = Number(key.slice(0, 4));
    var m = Number(key.slice(5, 7)) + 1;
    if (m > 12) { m = 1; y++; }
    return y + '-' + ('0' + m).slice(-2);
  }
  return shiftDays(key, 1);
}

var CHORE_DUE_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * Last day `periodKey` can still be done penalty-free. Weekly chores may pick
 * a due day inside the week (blank = Sunday); monthly chores run to month end;
 * a once-chore's is its optional dueDate.
 */
function choreDueDateFor(cat, periodKey) {
  if (cat.cadence === 'weekly') {
    var offset = CHORE_DUE_DAYS.indexOf(cat.dueDay);
    return shiftDays(periodKeyDate(periodKey), offset === -1 ? 6 : offset);
  }
  if (cat.cadence === 'monthly') {
    return shiftDays(nextChorePeriodKey('monthly', periodKey) + '-01', -1);
  }
  if (cat.cadence === 'once') return cat.dueDate || '';
  return periodKey;
}

/** Has `periodKey`'s due date passed? A once-chore with no due date never closes. */
function chorePeriodClosed(cat, periodKey, todayStr) {
  var due = choreDueDateFor(cat, periodKey);
  return !!due && todayStr > due;
}

/**
 * The most recently closed period as of `dayStr`, walking from `from` — or
 * null when nothing has closed yet. This is the only period that accrues (and
 * the only closed one still claimable): a chore can't be done twice, so when
 * a new period comes due the old debt is lost.
 */
function latestClosedPeriod(cat, from, dayStr) {
  if (!chorePeriodClosed(cat, from, dayStr)) return null;
  var key = from;
  var guard = 0;
  while (guard++ < 400) {
    var next = nextChorePeriodKey(cat.cadence, key);
    if (!chorePeriodClosed(cat, next, dayStr)) return key;
    key = next;
  }
  return key;
}

/**
 * First period at/after `sweepFrom` still open as of `resumeDate` — where the
 * sweep resumes after a pause, forgiving everything that closed during it.
 */
function resumeSweepFrom(cat, sweepFrom, resumeDate) {
  var key = sweepFrom;
  var guard = 0;
  while (chorePeriodClosed(cat, key, resumeDate) && guard++ < 400) {
    key = nextChorePeriodKey(cat.cadence, key);
  }
  return key;
}

// An overdue period drains once per DAY, not once total — but stops growing
// after this many drains so a forgotten chore can't crater a wallet.
var CHORE_ACCRUAL_CAP = 5;

/**
 * How many daily drains a period has taken. One drain writes one row per
 * affected wallet, so the busiest single wallet IS the count. Dividing the row
 * total by the chore's CURRENT sharing shape instead miscounts every row
 * written before an assignee change — a period drained while shared then read
 * as assigned counts double, and the drain cap trips at half the days.
 */
function choreDrainCount(rows, categoryId, periodKey) {
  var byActor = {};
  var max = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.type !== 'penalty' || String(r.category) !== String(categoryId) ||
        String(r.periodKey) !== String(periodKey)) continue;
    var a = String(r.actor || '');
    byActor[a] = (byActor[a] || 0) + 1;
    if (byActor[a] > max) max = byActor[a];
  }
  return max;
}

/**
 * Where a chore sits on the dashboard: 'today' (due now or carrying an
 * accruing pot), 'week' (weekly, due later this week), 'month' (do-whenever:
 * monthly, and once-chores whose due date hasn't arrived).
 */
function choreGroup(cat, todayStr, hasOutstanding) {
  if (hasOutstanding) return 'today';
  if (cat.cadence === 'daily') return 'today';
  if (cat.cadence === 'weekly') {
    return choreDueDateFor(cat, periodKeyFor('weekly', todayStr)) === todayStr ? 'today' : 'week';
  }
  if (cat.cadence === 'once') return cat.dueDate && cat.dueDate <= todayStr ? 'today' : 'month';
  return 'month';
}

/** The drain one unclaimed period costs: half each when shared, all on the assignee. */
function chorePenaltyAmounts(cat, allowlist) {
  if (cat.assignee) return [{ actor: cat.assignee, amount: -round2(cat.value) }];
  var half = -round2(cat.value / 2);
  return allowlist.map(function (a) { return { actor: a, amount: half }; });
}

/** A claim's worth: shared chores recover the pot, assigned ones never do. */
function chorePayout(cat, pot) {
  return cat.assignee ? round2(cat.value) : round2(cat.value + pot);
}

/** Sheet cells round-trip booleans as true/'TRUE'/'true' depending on path. */
function isTrueFlag(v) {
  return v === true || String(v).toLowerCase() === 'true';
}

/**
 * The most recently *closed* period — the one a record button may write.
 * Daily: yesterday. Weekly: the ISO week of the last Sunday.
 *
 * Weekly cannot just use yesterday: mid-week that still lands inside the
 * current, unfinished week, so tapping "Did it" on a Wednesday would credit a
 * week that hasn't happened yet (and then suppress Monday's check-up, which
 * skips any period already recorded).
 *
 * @param cadence  'daily' | 'weekly'
 * @param dateStr  today as "YYYY-MM-DD" in the app timezone
 * @param dow      ISO day-of-week for dateStr, 1=Mon..7=Sun
 */
function lastClosedPeriodKey(cadence, dateStr, dow) {
  if (cadence !== 'weekly') return shiftDays(dateStr, -1);
  return isoWeek(shiftDays(dateStr, -dow)); // dow days back is always a Sunday
}

/**
 * Email day-of-week gates (dow: 1=Mon..7=Sun, ISO).
 * Weekly categories get one reminder (Sunday, last day of the ISO week) and
 * one check-up (Monday, right after the week closes). Daily: every day.
 * Sending a weekly check-up mid-week would record the still-open week.
 */
function shouldSendReminder(cat, dow) {
  return cat.cadence !== 'weekly' || dow === 7;
}
function shouldSendCheckup(cat, dow) {
  return cat.cadence !== 'weekly' || dow === 1;
}

function initialCatState(cat, periodStart) {
  return {
    streak: 0,
    periodStart: periodStart || null,
    // The cadence `periodStart` was computed under. Without it, editing the
    // freeze-refresh dropdown looks exactly like a period ending.
    freezeRefresh: cat.freezeRefresh,
    freezesUsedThisPeriod: 0,
    lastRecordedKey: null,
    // Settlement began with this state; periods before it were never
    // settled, so bonus re-settlement must skip them.
    since: periodStart || null,
  };
}

/**
 * What this category's freeze period needs on this tick.
 *
 *   'none'    — still inside the same period
 *   'refresh' — the period ended: reset freezes, pay any unused-freeze bonus
 *   'rebase'  — the freeze-refresh *cadence* was edited, so the stored period
 *               start describes a rule that no longer applies. Move to the new
 *               one without paying: no time passed. Scoring this as a period
 *               ending let anyone mint the bonus by toggling week ⇄ month.
 */
function refreshAction(state, cat, newPeriodStart) {
  var was = state.freezeRefresh;
  if (was != null && was !== cat.freezeRefresh) return 'rebase';
  return state.periodStart === newPeriodStart ? 'none' : 'refresh';
}

/** Adopt the new cadence's period. Freezes already spent stay spent. */
function applyRebase(state, cat, newPeriodStart) {
  var s = Object.assign({}, state);
  s.periodStart = newPeriodStart;
  s.freezeRefresh = cat.freezeRefresh;
  return s;
}

/**
 * Begin a fresh freeze period without settling the one before it: full
 * allowance back, no unused-freeze bonus. For a category resuming after a
 * dormant stretch — the periods it sat out archived earned nothing, and
 * scoring the gap as one long period paid a bonus for weeks it wasn't running.
 * Streak and last-recorded key are history and are kept.
 */
function applyRestart(state, cat, newPeriodStart) {
  var s = Object.assign({}, state);
  s.freezesUsedThisPeriod = 0;
  s.periodStart = newPeriodStart;
  s.freezeRefresh = cat.freezeRefresh;
  // The pre-archive periods were never fully settled, so bonus re-settlement
  // must not reach back past the restart and pay for them now.
  s.since = newPeriodStart;
  return s;
}

/**
 * Freezes still available this period.
 *
 * Derived rather than stored: state records how many freezes were *spent*,
 * which is a fact about what happened, while the allowance lives on the
 * category and can be edited at any time. Storing the remainder instead made
 * an edit to `freezesPerPeriod` invisible until the next period rollover.
 */
function freezesLeft(cat, state) {
  var spent = Number(state.freezesUsedThisPeriod) || 0;
  return Math.max(0, (Number(cat.freezesPerPeriod) || 0) - spent);
}

/**
 * Bring a state blob written before freezes were derived up to the new shape.
 * The spent count is recovered from the stored remainder; exact unless the
 * category's allowance was edited during the period being migrated.
 */
function migrateCatState(cat, state) {
  if (state && state.freezesUsedThisPeriod != null && state.freezeRefresh != null && state.since != null) return state;
  var s = Object.assign({}, state);
  if (s.freezeRefresh == null) s.freezeRefresh = cat.freezeRefresh;
  // One-time amnesty for pre-existing habits: everything before the
  // migration-time period is exempt from re-settlement. A rare legitimately-
  // settled clawback/payback is forgone, but that's the safe direction.
  if (s.since == null) s.since = s.periodStart || null;
  if (s.freezesUsedThisPeriod != null) return s;
  var left = Number(s.freezeAvailable);
  s.freezesUsedThisPeriod = isNaN(left)
    ? 0
    : Math.max(0, (Number(cat.freezesPerPeriod) || 0) - left);
  delete s.freezeAvailable;
  delete s.freezeUsedThisPeriod;
  return s;
}

/**
 * Record one entry for a category. Credits the shared wallet `balance`.
 * @returns {{state:object, balance:number, event:object}}
 */
function applyEntry(state, balance, cat, input) {
  var periodKey = input.periodKey;
  var result = input.result;
  var actor = input.actor || '';
  if (!periodKey) throw new Error('periodKey is required');
  if (result !== 'on_time' && result !== 'missed') {
    throw new Error('result must be "on_time" or "missed"');
  }
  if (state.lastRecordedKey === periodKey) {
    throw new Error('period ' + periodKey + ' already recorded');
  }
  var s = Object.assign({}, state);
  var amount = 0;
  var freezeUsed = false;
  if (result === 'on_time') {
    s.streak = state.streak + 1;
    amount = payout(cat, s.streak);
    balance = round2(balance + amount);
  } else if (freezesLeft(cat, state) > 0) {
    s.freezesUsedThisPeriod = (Number(state.freezesUsedThisPeriod) || 0) + 1;
    freezeUsed = true;
  } else {
    // No freeze left: the penalty decides how much of the streak survives.
    var pct = cat.missPenaltyPercent == null ? 100 : cat.missPenaltyPercent;
    s.streak = Math.max(0, Math.round(state.streak * (1 - pct / 100)));
  }
  s.lastRecordedKey = periodKey;
  var event = {
    type: 'entry',
    category: cat.id,
    periodKey: periodKey,
    result: result,
    freezeUsed: freezeUsed,
    amount: amount,
    balanceAfter: balance,
    actor: actor,
  };
  return { state: s, balance: balance, event: event };
}

/**
 * Period rollover: award the unused-freeze bonus (if configured and earned),
 * then refresh freezes for the new period.
 *
 * `hadEntries` gates the bonus: a period nobody recorded shouldn't pay for
 * "not needing" a freeze — otherwise ignoring a habit for a month earns more
 * than doing it, and the bonus becomes an idleness allowance.
 *
 * @returns {{state:object, balance:number, event:(object|null)}}
 */
function applyRefresh(state, balance, cat, newPeriodStart, hadEntries) {
  var s = Object.assign({}, state);
  var event = null;
  if (cat.unusedFreezeBonus > 0 && hadEntries && !(Number(state.freezesUsedThisPeriod) || 0)) {
    balance = round2(balance + cat.unusedFreezeBonus);
    event = {
      type: 'bonus',
      category: cat.id,
      amount: cat.unusedFreezeBonus,
      note: 'Unused freeze bonus',
      actor: 'system',
      balanceAfter: balance,
    };
  }
  s.freezesUsedThisPeriod = 0;
  s.periodStart = newPeriodStart;
  s.freezeRefresh = cat.freezeRefresh;
  return { state: s, balance: balance, event: event };
}

function applySpend(balance, input) {
  var requested = round2(input.amount);
  if (!(requested > 0)) throw new Error('spend amount must be positive');
  var applied = round2(Math.min(requested, Math.max(0, balance)));
  var newBalance = round2(balance - applied);
  var event = {
    type: 'spend',
    amount: applied,
    note: input.note || '',
    actor: input.actor || '',
    balanceAfter: newBalance,
  };
  return { balance: newBalance, event: event };
}

function applyDeposit(balance, input) {
  var requested = round2(input.amount);
  if (!(requested > 0)) throw new Error('deposit amount must be positive');
  var newBalance = round2(balance + requested);
  var event = {
    type: 'deposit',
    amount: requested,
    note: input.note || '',
    actor: input.actor || '',
    balanceAfter: newBalance,
  };
  return { balance: newBalance, event: event };
}

/**
 * Has this actor already recorded this category's period?
 *
 * Answered from the ledger, which holds every entry ever written. State's
 * `lastRecordedKey` remembers only the most recent period, so a signed
 * check-up link for an older one sailed past it and credited a period that had
 * already been superseded. Deleting an entry row reopens its period, which is
 * what lets an answer be cleared and re-recorded.
 */
function isPeriodRecorded(rows, actor, categoryId, periodKey) {
  var a = String(actor || '').toLowerCase();
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.type !== 'entry') continue;
    if (String(r.actor || '').toLowerCase() !== a) continue;
    if (String(r.category) !== String(categoryId)) continue;
    if (String(r.periodKey) === String(periodKey)) return true;
  }
  return false;
}

/**
 * Rebuild one actor's history for one category from its ledger entry rows,
 * as if every answer had always been what the rows now say.
 *
 * Runs the same rules as applyEntry from streak 0 under the category's
 * CURRENT settings, re-deciding freeze usage from calendar freeze periods.
 * Unrecorded periods contribute nothing, matching live behavior. The freeze
 * period starting `currentPeriodStart` is still open — its spent count goes
 * into state for the live machinery; every earlier period is history.
 *
 * @param entries  one actor's entry rows for this category, any order; extra
 *                 fields (id, rowNumber, …) are preserved on the output copies
 * @returns {{entries: Array, state: {streak, freezesUsedThisPeriod, lastRecordedKey}}}
 */
function replayCategory(cat, entries, currentPeriodStart) {
  var sorted = entries.slice().sort(function (a, b) {
    var da = periodKeyDate(a.periodKey);
    var db = periodKeyDate(b.periodKey);
    return da < db ? -1 : da > db ? 1 : 0;
  });
  var streak = 0;
  var curStart = null;
  var used = 0;
  var out = [];
  for (var i = 0; i < sorted.length; i++) {
    var e = sorted[i];
    var fps = freezePeriodStart(cat.freezeRefresh, periodKeyDate(e.periodKey));
    if (fps !== curStart) { curStart = fps; used = 0; }
    var freezeUsed = false;
    var amount = 0;
    if (e.result === 'on_time') {
      streak += 1;
      amount = payout(cat, streak);
    } else if (used < (Number(cat.freezesPerPeriod) || 0)) {
      used += 1;
      freezeUsed = true;
    } else {
      var pct = cat.missPenaltyPercent == null ? 100 : cat.missPenaltyPercent;
      streak = Math.max(0, Math.round(streak * (1 - pct / 100)));
    }
    out.push(Object.assign({}, e, { freezeUsed: freezeUsed, amount: amount }));
  }
  return {
    entries: out,
    state: {
      streak: streak,
      freezesUsedThisPeriod: curStart === currentPeriodStart ? used : 0,
      lastRecordedKey: sorted.length ? String(sorted[sorted.length - 1].periodKey) : null,
    },
  };
}

/**
 * Is this period at or after the one an edit touched?
 *
 * Keys of either cadence land on the calendar first, so a habit whose cadence
 * was edited (and therefore holds both daily and weekly keys) still compares
 * on one axis.
 */
function inReplayWindow(periodKey, fromPeriodKey) {
  if (!fromPeriodKey) return true;
  return periodKeyDate(String(periodKey)) >= periodKeyDate(String(fromPeriodKey));
}

/**
 * replayCategory, narrowed to the rows an edit is allowed to rewrite.
 *
 * The streak still walks the ENTIRE history — that is the only way to know
 * what streak the edited period inherits — but only the edited period and
 * what follows it come back to be written. Everything earlier keeps the
 * amount it was paid.
 *
 * Without the window, any edit re-priced all of history at the category's
 * CURRENT settings, so a later change to minPayout, the cap, the increment or
 * the miss penalty cashed itself in retroactively the first time anyone fixed
 * a missed day — a wallet jumping by more than the edit could possibly be
 * worth. Rules change going forward; what was already banked stands.
 *
 * @param fromPeriodKey  the earliest period the caller changed; blank replays all
 */
function replayFrom(cat, entries, currentPeriodStart, fromPeriodKey) {
  var r = replayCategory(cat, entries, currentPeriodStart);
  return {
    entries: r.entries.filter(function (e) {
      return inReplayWindow(e.periodKey, fromPeriodKey);
    }),
    state: r.state,
  };
}

/** Does any entry fall inside the freeze period starting `periodStart`? */
function periodHasEntries(cat, entries, periodStart) {
  for (var i = 0; i < entries.length; i++) {
    if (freezePeriodStart(cat.freezeRefresh, periodKeyDate(entries[i].periodKey)) === periodStart) return true;
  }
  return false;
}

/**
 * Replay a single actor's ledger rows (in order), flooring spends at $0, and
 * attach the running balance to each. Non-spend rows add their amount.
 * @returns {Array} the actor's rows, each with a numeric balanceAfter.
 */
function runningBalanceRows(rows, actor) {
  var a = String(actor || '').toLowerCase();
  var bal = 0;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r.actor || '').toLowerCase() !== a) continue;
    var amt = Number(r.amount) || 0;
    bal = r.type === 'spend' ? round2(Math.max(0, bal - amt)) : round2(bal + amt);
    var copy = Object.assign({}, r);
    copy.balanceAfter = bal;
    out.push(copy);
  }
  return out;
}

/** Current wallet balance for an actor, derived from their ledger rows. */
function deriveWallet(rows, actor) {
  var rb = runningBalanceRows(rows, actor);
  return rb.length ? rb[rb.length - 1].balanceAfter : 0;
}

/** Neutralise markup for anything interpolated into an HTML email body. */
function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Task 4 helpers (not exported)
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function num(v, dflt) {
  var n = Number(v);
  return isNaN(n) ? dflt : n;
}

/** Whole-hour "HH:00" or "" (off). */
function isWholeHour(t) {
  return t === '' || /^([01]\d|2[0-3]):00$/.test(t);
}

function normalizeCategory(raw) {
  raw = raw || {};
  if (raw.kind === 'chore') {
    var cadence = raw.cadence === 'weekly' || raw.cadence === 'monthly' || raw.cadence === 'once'
      ? raw.cadence : (raw.cadence === 'daily' ? 'daily' : String(raw.cadence || ''));
    return {
      id: raw.id ? slugify(raw.id) : slugify(raw.name),
      name: String(raw.name || '').trim(),
      emoji: String(raw.emoji || '').trim(),
      kind: 'chore',
      cadence: cadence,
      value: num(raw.value, NaN),
      assignee: String(raw.assignee || '').trim().toLowerCase(),
      dueDate: String(raw.dueDate || '').trim(),
      dueDay: String(raw.dueDay || '').trim().toLowerCase(),
      notes: String(raw.notes || '').trim(),
      reminderTime: String(raw.reminderTime || '').trim(),
      active: raw.active !== false,
    };
  }
  return {
    id: raw.id ? slugify(raw.id) : slugify(raw.name),
    name: String(raw.name || '').trim(),
    emoji: String(raw.emoji || '').trim(),
    kind: 'habit',
    cadence: raw.cadence === 'weekly' ? 'weekly' : (raw.cadence === 'daily' ? 'daily' : String(raw.cadence || '')),
    rewardIncrement: num(raw.rewardIncrement, NaN),
    maxPerInstance: num(raw.maxPerInstance, NaN),
    freezesPerPeriod: num(raw.freezesPerPeriod, NaN),
    freezeRefresh: raw.freezeRefresh === 'daily' || raw.freezeRefresh === 'monthly' ? raw.freezeRefresh : 'weekly',
    unusedFreezeBonus: raw.unusedFreezeBonus === '' || raw.unusedFreezeBonus == null ? 0 : num(raw.unusedFreezeBonus, 0),
    missPenaltyPercent: raw.missPenaltyPercent === '' || raw.missPenaltyPercent == null ? 100 : num(raw.missPenaltyPercent, 100),
    minPayout: raw.minPayout === '' || raw.minPayout == null ? 0 : num(raw.minPayout, 0),
    notes: String(raw.notes || '').trim(),
    reminderTime: String(raw.reminderTime || '').trim(),
    checkupTime: String(raw.checkupTime || '').trim(),
    active: raw.active !== false,
  };
}

// Long enough for a ZWJ sequence like 👩‍👩‍👧 (11 code units), short enough that
// it can't take over an email subject line.
var MAX_EMOJI_LENGTH = 16;

var MAX_NOTES_LENGTH = 2000;

function validateCategory(cat) {
  var errs = [];
  if (cat.emoji.length > MAX_EMOJI_LENGTH) errs.push('Emoji must be a single symbol.');
  if (cat.notes && cat.notes.length > MAX_NOTES_LENGTH) errs.push('Notes must be ' + MAX_NOTES_LENGTH + ' characters or fewer.');
  if (!cat.id) errs.push('A name is required (used to build the id).');
  if (!cat.name) errs.push('Name is required.');
  if (cat.kind === 'chore') {
    if (cat.cadence !== 'daily' && cat.cadence !== 'weekly' && cat.cadence !== 'monthly' && cat.cadence !== 'once') {
      errs.push('Chore cadence must be daily, weekly, monthly, or once.');
    }
    if (!(cat.value > 0)) errs.push('Chore value must be a positive number.');
    if (cat.assignee && !/^[^@\s]+@[^@\s]+$/.test(cat.assignee)) errs.push('Assignee must be an email address, or blank for either of you.');
    if (cat.dueDate) {
      if (cat.cadence !== 'once') errs.push('A due date only applies to one-time chores.');
      else if (!validPeriodKey('daily', cat.dueDate)) errs.push('Due date must be a real date like 2026-09-30.');
    }
    if (cat.dueDay) {
      if (cat.cadence !== 'weekly') errs.push('A due day only applies to weekly chores.');
      else if (CHORE_DUE_DAYS.indexOf(cat.dueDay) === -1) errs.push('Due day must be a day like wed, or blank for end of week.');
    }
    if (!isWholeHour(cat.reminderTime)) errs.push('Reminder time must be a whole hour like 21:00, or blank.');
    return errs;
  }
  if (cat.cadence !== 'daily' && cat.cadence !== 'weekly') errs.push('Cadence must be daily or weekly.');
  if (!(cat.rewardIncrement > 0)) errs.push('Reward increment must be a positive number.');
  if (!(cat.maxPerInstance > 0)) errs.push('Max per instance must be a positive number.');
  if (!(cat.freezesPerPeriod >= 0) || cat.freezesPerPeriod % 1 !== 0) errs.push('Freezes per period must be a whole number (0 or more).');
  if (!(cat.unusedFreezeBonus >= 0)) errs.push('Unused-freeze bonus must be 0 or more.');
  if (!(cat.missPenaltyPercent >= 0 && cat.missPenaltyPercent <= 100)) errs.push('Miss penalty must be between 0 and 100 percent.');
  if (!(cat.minPayout >= 0)) errs.push('Minimum payout must be 0 or more.');
  else if (cat.minPayout > cat.maxPerInstance) errs.push('Minimum payout cannot exceed the max per instance.');
  if (!isWholeHour(cat.reminderTime)) errs.push('Reminder time must be a whole hour like 21:00, or blank.');
  if (!isWholeHour(cat.checkupTime)) errs.push('Check-up time must be a whole hour like 09:00, or blank.');
  return errs;
}

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
