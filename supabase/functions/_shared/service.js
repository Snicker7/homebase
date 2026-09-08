// supabase/functions/_shared/service.js
// Ported from the Apps Script glue (samsite/habits/backend/main.gs). Runs
// synchronously against a journaled store; the caller owns the transaction.
import * as E from './engine.js';
import { WEEKLY_ROLLOVER_HOUR, CHECKUP_TTL_MS } from './config.js';
import { tzDate, tzHour, tzHourStr, tzMonthStart, tzStamp } from './clock.js';
import { signToken } from './token.js';

export function createService(ctx) {
  const store = ctx.store;

  // ── date helpers (main.gs 62-98) ──
  const todayStr = () => tzDate(ctx.now());
  // ISO day-of-week in TZ: 1=Mon..7=Sun. Derived from the formatted date so
  // there is one date-format dependency, not two.
  const currentDow = () => E.isoDow(todayStr());
  const currentHourInt = () => tzHour(ctx.now());
  // The weekly freeze period in force right now — see WEEKLY_ROLLOVER_HOUR.
  function currentMondayStr() {
    const monday = E.mondayOf(todayStr(), currentDow());
    if (currentDow() === 1 && currentHourInt() < WEEKLY_ROLLOVER_HOUR) return E.shiftDays(monday, -7);
    return monday;
  }
  // The period a record button writes right now — see lastClosedPeriodKey.
  const recordablePeriodKey = (cat) => E.lastClosedPeriodKey(cat.cadence, todayStr(), currentDow());
  // First day of the current month, e.g. "2026-06-01" — stable across the month.
  const currentMonthStr = () => tzMonthStart(ctx.now());

  // ── storage helpers (main.gs 100-360) ──
  function choreStateOf(cat) {
    const m = store.choreStatesAll();
    let s = E.repairChoreState(cat, m[cat.id], todayStr());
    if (!s) {
      const cur = E.claimablePeriodKey(cat, todayStr());
      s = { since: cur, sweepFrom: cur, chargedThrough: todayStr() };
    }
    if (s !== m[cat.id]) {
      m[cat.id] = s;
      store.saveChoreStates(m);
    }
    return s;
  }
  // Vacation hold: while set (and still in the future) the sweep and the chore
  // reminder emails stand down; when it lapses — or is ended early — the paused
  // stretch is forgiven, not back-charged.
  const chorePauseUntil = () => store.getSetting('chorePauseUntil') || '';

  // Cheap pre-check so stateResponse doesn't do the sweep's work every load.
  function sweepNeeded() {
    const today = todayStr();
    const pu = chorePauseUntil();
    if (pu && today < pu) return false;
    if (pu) return true; // lapsed — the next sweep forgives the gap
    const chores = activeChores();
    if (!chores.length) return false;
    const m = store.choreStatesAll();
    for (let i = 0; i < chores.length; i++) {
      const cat = chores[i];
      const s = E.repairChoreState(cat, m[cat.id], today);
      if (!s) return true;
      if (s !== m[cat.id]) return true; // a repaired record must be written back
      if (s.chargedThrough && s.chargedThrough >= today) continue; // today's drain already ran
      if (cat.cadence === 'once') {
        if (cat.dueDate && today > cat.dueDate && s.sweepFrom !== 'done') return true;
      } else if (E.chorePeriodClosed(cat, s.sweepFrom, today)) {
        return true;
      }
    }
    return false;
  }

  // Charge the accrual owed since the last sweep. The penalty runs by the DAY,
  // not the period: each overdue day drains the value once more, landing on the
  // LATEST closed period — a chore can't be done twice, so once its next period
  // comes due the older one is lost (its pot dissolves, nobody can back-claim
  // it) and the new one starts its own clock. Each period stops draining at
  // CHORE_ACCRUAL_CAP, and one chore never drains twice in a day. `getRows` is
  // a lazy memoized reader (same pattern as maybeRefresh) — appended penalty
  // rows are also pushed into the memo so a claim that follows in the same
  // request sees its pot.
  function sweepChores(getRows) {
    const today = todayStr();
    const pu = chorePauseUntil();
    if (pu) {
      if (today < pu) return;
      endChorePause(pu);
    }
    const chores = activeChores();
    if (!chores.length) return;
    const m = store.choreStatesAll();
    let dirty = false;
    chores.forEach(function (cat) {
      let s = E.repairChoreState(cat, m[cat.id], today);
      if (s !== m[cat.id]) { m[cat.id] = s; dirty = true; } // keys this cadence can't walk
      if (!s) {
        const cur0 = E.claimablePeriodKey(cat, today);
        s = m[cat.id] = { since: cur0, sweepFrom: cur0, chargedThrough: today };
        dirty = true;
        return;
      }
      // States written before daily accrual existed: start the clock now, don't
      // back-charge the pre-feature past.
      if (!s.chargedThrough) { s.chargedThrough = E.shiftDays(today, -1); dirty = true; }
      if (s.sweepFrom === 'done') {
        if (s.chargedThrough !== today) { s.chargedThrough = today; dirty = true; }
        return;
      }
      let day = s.chargedThrough;
      let from = s.sweepFrom;
      let guard = 0;
      while (day < today && guard++ < 400) {
        day = E.shiftDays(day, 1);
        const target = accrualTarget(cat, from, day);
        if (!target) continue;
        from = target; // anything older is lost — never look back at it again
        if (store.isHoliday(day)) continue; // a holiday costs nothing, but the period still ages
        if (E.isChoreClaimed(getRows(), cat.id, target)) continue;
        if (E.choreDrainCount(getRows(), cat.id, target) >= E.CHORE_ACCRUAL_CAP) continue;
        applyChorePenalty(cat, target, getRows());
      }
      if (day !== s.chargedThrough) { s.chargedThrough = day; dirty = true; }
      if (from !== s.sweepFrom) { s.sweepFrom = from; dirty = true; }
    });
    if (dirty) store.saveChoreStates(m);
  }

  // The period one day's drain lands on: the latest period closed as of that
  // day, or null when nothing has closed yet.
  function accrualTarget(cat, from, dayStr) {
    if (cat.cadence === 'once') return E.chorePeriodClosed(cat, 'once', dayStr) ? 'once' : null;
    return E.latestClosedPeriod(cat, from, dayStr);
  }

  // The one closed period still catchable: the latest one. Older periods are
  // lost the moment their successor comes due. Derived rather than stored so an
  // un-claimed row can't resurrect a period the calendar has already passed.
  function catchablePeriod(cat, s, today) {
    if (cat.cadence === 'once') return E.chorePeriodClosed(cat, 'once', today) ? 'once' : null;
    const start = s.sweepFrom > s.since ? s.sweepFrom : s.since;
    return E.latestClosedPeriod(cat, start, today);
  }

  // The paused stretch owes nothing: jump each chore's sweep pointer past every
  // period that closed while paused. A once-chore whose due date fell inside the
  // pause is forgiven its single penalty but stays claimable at plain value.
  function endChorePause(resumeDate) {
    const m = store.choreStatesAll();
    let dirty = false;
    activeChores().forEach(function (cat) {
      const s = E.repairChoreState(cat, m[cat.id], resumeDate);
      if (!s) return;
      if (s !== m[cat.id]) { m[cat.id] = s; dirty = true; }
      if (cat.cadence === 'once') {
        if (cat.dueDate && E.chorePeriodClosed(cat, 'once', resumeDate) && s.sweepFrom !== 'done') {
          s.sweepFrom = 'done';
          dirty = true;
        }
      } else {
        const next = E.resumeSweepFrom(cat, s.sweepFrom, resumeDate);
        if (next !== s.sweepFrom) { s.sweepFrom = next; dirty = true; }
      }
      // The accrual clock skips the paused days too.
      if (!s.chargedThrough || s.chargedThrough < resumeDate) { s.chargedThrough = resumeDate; dirty = true; }
    });
    if (dirty) store.saveChoreStates(m);
    store.deleteSetting('chorePauseUntil');
  }

  function doPauseChores(p) {
    requireUser(p);
    const until = String(p.until || '').trim();
    if (!E.validPeriodKey('daily', until)) return { ok: false, error: 'Pick a real date like 2026-09-10.' };
    if (until <= todayStr()) return { ok: false, error: 'Pick a date after today — chores resume that morning.' };
    // Settle what was already owed before the break starts.
    let rows = null;
    sweepChores(function () { if (rows === null) rows = store.readLedgerRows(); return rows; });
    store.setSetting('chorePauseUntil', until);
    return { ok: true, pauseUntil: until };
  }

  function doResumeChores(p) {
    requireUser(p);
    const pu = chorePauseUntil();
    if (!pu) return { ok: false, error: 'chores aren\'t paused' };
    const today = todayStr();
    endChorePause(pu < today ? pu : today);
    return { ok: true, pauseUntil: '' };
  }

  // One period's drain: append the penalty rows and keep the in-memory ledger
  // in step so later pot math in this request is right.
  function applyChorePenalty(cat, periodKey, rows) {
    E.chorePenaltyAmounts(cat, store.allowlist()).forEach(function (p) {
      const ev = {
        type: 'penalty', category: cat.id, periodKey: periodKey,
        amount: p.amount, actor: p.actor,
        balanceAfter: E.round2(E.deriveWallet(rows, p.actor) + p.amount),
        note: 'Unclaimed: ' + cat.name,
      };
      const id = store.appendLedger({ ...ev, timestamp: ctx.now() });
      rows.push({ id: id, timestamp: ctx.now(), type: 'penalty', category: cat.id, periodKey: periodKey, result: '', freezeUsed: false, amount: p.amount, balanceAfter: ev.balanceAfter, actor: p.actor, note: ev.note });
    });
  }
  function walletOf(email) { return E.deriveWallet(store.readLedgerRows(), email); }
  function catStateOf(email, catId, cat) {
    const m = store.statesAll();
    if (!m[email]) m[email] = { cats: {} };
    if (!m[email].cats) m[email].cats = {};
    let s = m[email].cats[catId];
    if (s) {
      const migrated = E.migrateCatState(cat, s);
      if (migrated === s) return s;
      s = migrated;
    } else {
      s = E.initialCatState(cat, currentPeriodStart(cat));
    }
    m[email].cats[catId] = s;
    store.saveStatesAll(m);
    return s;
  }
  function saveCatState(email, catId, s) {
    const m = store.statesAll();
    if (!m[email]) m[email] = { cats: {} };
    if (!m[email].cats) m[email].cats = {};
    m[email].cats[catId] = s;
    store.saveStatesAll(m);
  }

  function categoryById(id) {
    const list = store.categoriesAll();
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function activeCategories() {
    return store.categoriesAll().filter(function (c) { return c.active; });
  }
  // A category written before chores existed has no kind — it is a habit.
  function isHabit(c) { return c.kind !== 'chore'; }
  function activeHabits() { return activeCategories().filter(isHabit); }
  function activeChores() { return activeCategories().filter(function (c) { return !isHabit(c); }); }
  // id -> display name, so history reads "Bedtime" after a rename instead of the
  // slug it was first created under.
  function categoryNames() {
    const m = {};
    store.categoriesAll().forEach(function (c) { m[c.id] = c.name; });
    return m;
  }
  // Period start for the category's freezeRefresh cadence (a "YYYY-MM-DD").
  function currentPeriodStart(cat) {
    if (cat.freezeRefresh === 'daily') return todayStr();
    if (cat.freezeRefresh === 'monthly') return currentMonthStr();
    return currentMondayStr();
  }

  // ── ledger helpers (main.gs 451-485) ──
  // A row whose timestamp is empty or unreadable shows no date rather than
  // taking the whole dashboard down with it.
  function formatTimestamp(v) {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return tzStamp(d);
  }
  // This actor's entry rows for one category, as references into `rows` so a
  // caller's in-place amount fixes feed straight into the balance re-derivation.
  function entryRowsFor(rows, email, categoryId) {
    const a = String(email || '').toLowerCase();
    return rows.filter(function (r) {
      return r.type === 'entry' &&
        String(r.actor || '').toLowerCase() === a &&
        String(r.category) === String(categoryId);
    });
  }
  // `mine` is one actor's rows from runningBalanceRows — already carrying the
  // correct balanceAfter. Taking them pre-scanned keeps stateResponse to a single
  // pass for the wallet and the panel together.
  function recentLedger(mine, n) {
    mine = mine.slice(Math.max(0, mine.length - n));
    const names = categoryNames();
    return mine.reverse().map(function (r) {
      return {
        id: r.id,
        // Deleting an entry row replays the habit's history, so any own row goes.
        canDelete: r.type === 'spend' || r.type === 'deposit' || r.type === 'entry' || r.type === 'claim',
        timestamp: formatTimestamp(r.timestamp),
        type: r.type, category: r.category,
        categoryName: names[r.category] || r.category,
        periodKey: r.periodKey, result: r.result,
        freezeUsed: r.freezeUsed, amount: r.amount, balanceAfter: r.balanceAfter,
        actor: r.actor, note: r.note,
      };
    });
  }

  // ── dashboard (main.gs 651-778) ──
  function requireUser(p) {
    const email = String(p.user || '').toLowerCase();
    if (!email || store.allowlist().indexOf(email) === -1) throw new Error('not authorized — please log in again');
    return email;
  }
  // Make sure m[email].cats has a state for every cat; returns true if it added any.
  function ensureCatStates(m, email, cats) {
    if (!m[email]) m[email] = { cats: {} };
    if (!m[email].cats) m[email].cats = {};
    let changed = false;
    cats.forEach(function (cat) {
      const s = m[email].cats[cat.id];
      if (!s) {
        m[email].cats[cat.id] = E.initialCatState(cat, currentPeriodStart(cat));
        changed = true;
        return;
      }
      const migrated = E.migrateCatState(cat, s);
      if (migrated !== s) {
        m[email].cats[cat.id] = migrated;
        changed = true;
      }
    });
    return changed;
  }

  // True when this user has a category whose period has rolled over, whose state
  // is missing, or whose state predates the derived-freeze shape — i.e. when
  // stateResponse must write.
  function refreshNeeded(email, cats) {
    const m = store.statesAll();
    for (let i = 0; i < cats.length; i++) {
      const s = m[email] && m[email].cats && m[email].cats[cats[i].id];
      if (!s || s.freezesUsedThisPeriod == null || s.freezeRefresh == null || s.since == null) return true;
      if (E.refreshAction(s, cats[i], currentPeriodStart(cats[i])) !== 'none') return true;
    }
    return false;
  }
  function catPublicFromState(cat, s, entryRows) {
    const next = recordablePeriodKey(cat);
    let recorded = null;
    (entryRows || []).forEach(function (r) {
      if (r.type === 'entry' && String(r.category) === String(cat.id) &&
          String(r.periodKey) === next) recorded = r.result;
    });
    return {
      id: cat.id, name: cat.name, emoji: cat.emoji, cadence: cat.cadence,
      notes: cat.notes || '',
      streak: s.streak, freezeAvailable: E.freezesLeft(cat, s),
      lastRecordedKey: s.lastRecordedKey,
      // The answer already on file for the recordable period — the card buttons
      // switch from "record" to "change your answer?" on this.
      recordedResult: recorded,
      potential: E.payout(cat, s.streak + 1),
      nextPeriodKey: next,
    };
  }
  function catPublic(email, cat) {
    return catPublicFromState(cat, catStateOf(email, cat.id, cat));
  }
  function stateResponse(email) {
    const active = activeHabits();
    // Freezes refresh at each category's period rollover. The hourly dispatch is
    // not the only thing allowed to do it: between a boundary and the next
    // dispatch run the dashboard would otherwise report — and a miss would spend —
    // the previous period's leftovers.
    if (refreshNeeded(email, active) || sweepNeeded()) {
      active.forEach(maybeRefresh);
      let rows0 = null;
      sweepChores(function () { if (rows0 === null) rows0 = store.readLedgerRows(); return rows0; });
      const mm = store.statesAll();
      if (ensureCatStates(mm, email, active)) store.saveStatesAll(mm);
    }
    const rows = store.readLedgerRows(); // ONE read serves both wallets + the ledger panel
    const myRows = E.runningBalanceRows(rows, email); // ...and ONE pass serves both of mine
    const myState = (store.statesAll()[email] || {}).cats || {};
    const cats = active.map(function (c) {
      return catPublicFromState(c, myState[c.id] || E.initialCatState(c, currentPeriodStart(c)), myRows);
    });
    const chores = activeChores().map(function (c) {
      const st = choreStateOf(c);
      const current = E.claimablePeriodKey(c, todayStr());
      let claimant = null;
      for (let i = 0; i < rows.length; i++) {
        const r0 = rows[i];
        if (r0.type === 'claim' && String(r0.category) === c.id && String(r0.periodKey) === current) {
          claimant = store.displayName(String(r0.actor || '').toLowerCase());
        }
      }
      // Only the latest closed period is still catchable — lost ones drop off
      // the card rather than sitting there as an uncollectable pot.
      const catchable = catchablePeriod(c, st, todayStr());
      const outstanding = E.outstandingChorePeriods(rows, c.id).filter(function (o) {
        return o.periodKey === catchable && (c.cadence === 'once' || o.periodKey >= st.since);
      });
      return {
        id: c.id, name: c.name, emoji: c.emoji, kind: 'chore', cadence: c.cadence,
        value: c.value, assignee: c.assignee, assigneeName: c.assignee ? store.displayName(c.assignee) : '',
        dueDate: c.dueDate || '', dueDay: c.dueDay || '', notes: c.notes || '',
        claimablePeriodKey: current,
        claimedBy: claimant, outstanding: outstanding,
        group: E.choreGroup(c, todayStr(), outstanding.length > 0),
      };
    });
    const resp = {
      ok: true, user: email, name: store.displayName(email),
      pauseUntil: chorePauseUntil(),
      wallet: myRows.length ? myRows[myRows.length - 1].balanceAfter : 0,
      cats: cats,
      chores: chores,
      ledger: recentLedger(myRows, 20),
    };
    const pe = store.partnerOf(email);
    if (pe) resp.partner = { name: store.displayName(pe), wallet: E.deriveWallet(rows, pe) };
    return resp;
  }

  // ── refresh (main.gs 1280-1301) ──
  // Refresh a category's freezes/bonus when its period boundary has passed.
  function maybeRefresh(cat) {
    const newStart = currentPeriodStart(cat);
    // One ledger read serves the whole loop: each actor's rows are independent,
    // so a bonus appended for one person can't change what the next one is owed.
    // Deferred because maybeRefresh runs on every record/amend/delete and only
    // an actual rollover needs the ledger at all.
    let rows = null;
    const getRows = function () { if (rows === null) rows = store.readLedgerRows(); return rows; };
    store.allowlist().forEach(function (email) {
      const s = catStateOf(email, cat.id, cat);
      const act = E.refreshAction(s, cat, newStart);
      if (act === 'none') return;
      if (act === 'rebase') {
        saveCatState(email, cat.id, E.applyRebase(s, cat, newStart));
        return;
      }
      const hadEntries = E.periodHasEntries(cat, entryRowsFor(getRows(), email, cat.id), s.periodStart);
      const out = E.applyRefresh(s, E.deriveWallet(getRows(), email), cat, newStart, hadEntries);
      saveCatState(email, cat.id, out.state);
      if (out.event) { out.event.actor = email; store.appendLedger({ ...out.event, timestamp: ctx.now() }); }
    });
  }

  // ── mutations (Task 6) ──

  // ── dispatch and check-up links (Task 7) ──

  function route(p) {
    switch (p.action) {
      case 'state': return stateResponse(requireUser(p));
      default: return { ok: true, name: 'Homebase API' };
    }
  }

  return { route };
}
