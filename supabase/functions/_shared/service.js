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

  // ── mutations (main.gs 780-1226) ──

  // Dashboard path: the SERVER decides which period is being recorded (the
  // just-closed one, in TZ), so device clocks can't skew entries.
  function doRecord(p) {
    const person = requireUser(p);
    const cat = categoryById(p.categoryId);
    if (!cat) return { ok: false, error: 'unknown category' };
    return recordEntry(person, cat, recordablePeriodKey(cat), p.result);
  }
  // Signed-link path: the token carried a server-issued period key.
  function recordFor(person, categoryId, periodKey, result) {
    const cat = categoryById(categoryId);
    if (!cat) return { ok: false, error: 'unknown category' };
    person = String(person || '').trim().toLowerCase();
    if (store.allowlist().indexOf(person) === -1) return { ok: false, error: 'unknown person' };
    return recordEntry(person, cat, String(periodKey), result);
  }
  function recordEntry(person, cat, periodKey, result) {
    if (!isHabit(cat)) return { ok: false, error: 'chores are claimed, not answered — use its card on the dashboard' };
    // Archiving stops the prompting and the emails; a link sent before it was
    // archived must not still pay into the wallet.
    if (!cat.active) return { ok: false, error: 'that habit is archived' };
    if (result !== 'on_time' && result !== 'missed') {
      return { ok: false, error: 'result must be "on_time" or "missed"' };
    }
    maybeRefresh(cat); // a miss must spend this period's freezes, not last one's
    const rows = store.readLedgerRows(); // read after the refresh, so any bonus row is in it
    // The ledger, not state's most-recent key, decides whether this period is
    // already spoken for — otherwise an old signed check-up link credits a period
    // that a later entry has already superseded.
    if (E.isPeriodRecorded(rows, person, cat.id, periodKey)) {
      return { ok: false, error: 'period ' + periodKey + ' already recorded' };
    }
    const entryFps = E.freezePeriodStart(cat.freezeRefresh, E.periodKeyDate(periodKey));
    if (entryFps !== currentPeriodStart(cat)) {
      // A late answer: its freeze period already rolled over, so the live path
      // would spend the wrong period's freeze. Append and replay from this
      // period instead — the same route an amend gap-fill takes.
      const lateId = store.appendLedger({
        type: 'entry', category: cat.id, periodKey: periodKey, result: result,
        freezeUsed: false, amount: 0, balanceAfter: '', actor: person,
        timestamp: ctx.now(),
      });
      const late = replayAndSave(person, cat, periodKey, lateId);
      const le = late.entry || {};
      return {
        ok: true, user: person, wallet: late.wallet, cat: catPublic(person, cat),
        event: { type: 'entry', category: cat.id, periodKey: periodKey, result: result,
          freezeUsed: le.freezeUsed === true, amount: Number(le.amount) || 0 },
      };
    }
    const s = catStateOf(person, cat.id, cat);
    const out = E.applyEntry(s, E.deriveWallet(rows, person), cat, { periodKey: periodKey, result: result, actor: person });
    store.appendLedger({ ...out.event, timestamp: ctx.now() });
    saveCatState(person, cat.id, out.state);
    return { ok: true, user: person, wallet: out.balance, cat: catPublic(person, cat), event: out.event };
  }

  function doSpend(p) {
    const email = requireUser(p);
    const out = E.applySpend(walletOf(email), { amount: Number(p.amount), note: p.note || '', actor: email });
    store.appendLedger({ ...out.event, timestamp: ctx.now() });
    return { ok: true, wallet: out.balance, event: out.event };
  }

  function doDeleteEntry(p) {
    const email = requireUser(p);
    const id = p.id;
    if (!id) return { ok: false, error: 'missing id' };
    const rows = store.readLedgerRows();
    let match = null;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].id) === String(id)) { match = rows[i]; break; }
    }
    if (!match) return { ok: false, error: 'entry not found — reload and try again' };
    if (String(match.actor).toLowerCase() !== String(email).toLowerCase()) {
      return { ok: false, error: 'you can only remove your own entries' };
    }
    if (match.type === 'entry') {
      const cat = categoryById(match.category);
      if (!cat) return { ok: false, error: 'unknown category' };
      // Settle any pending rollover first — replaying against a stale period
      // start pays the closed week's bonus twice.
      maybeRefresh(cat);
      store.deleteLedgerRow(match.id);
      // replayAndSave re-reads the ledger, so it sees the deletion.
      const out = replayAndSave(email, cat, match.periodKey, null);
      return { ok: true, wallet: out.wallet, cat: catPublic(email, cat) };
    }
    if (match.type === 'claim') {
      const ccat = categoryById(match.category);
      store.deleteLedgerRow(match.id);
      // A once-chore was archived by its claim; taking the claim back reopens it.
      if (ccat && !isHabit(ccat) && ccat.cadence === 'once') {
        const clist = store.categoriesAll();
        for (let ci = 0; ci < clist.length; ci++) if (clist[ci].id === ccat.id) clist[ci].active = true;
        store.saveCategories(clist);
      }
      // No sweep state to rewind: both the accrual target and the catchable
      // period are derived as "the latest closed period", so an un-claimed row
      // resumes accruing on its own if it is still the latest — and stays lost
      // if a later period has already come due.
      return { ok: true, wallet: walletWithout(rows, email, match.id) };
    }
    if (match.type !== 'spend' && match.type !== 'deposit') {
      return { ok: false, error: 'that row can\'t be removed here' };
    }
    store.deleteLedgerRow(match.id);
    return { ok: true, wallet: walletWithout(rows, email, match.id) };
  }
  // The wallet as it stands once `id` is gone, computed from the rows we already
  // read. Wallets stay derived from the ledger — never cached — so the only thing
  // worth avoiding is reading the same ledger twice in one request.
  function walletWithout(rows, email, id) {
    return E.deriveWallet(rows.filter(function (r) { return String(r.id) !== String(id); }), email);
  }

  // Rewrite this actor's entry rows for `cat` from `fromPeriodKey` onward to the
  // replayed history and store the replayed state. Rows for earlier periods keep
  // the amounts they were paid: the streak walks all of history, but a rule
  // changed since those rows were written must not cash itself in retroactively
  // (see replayFrom). `excludeId` keeps the directly-changed row out of the
  // ripple count shown to the user. The caller has already written its mutation.
  function replayAndSave(email, cat, fromPeriodKey, excludeId) {
    const rows = store.readLedgerRows(); // post-mutation
    const mine = entryRowsFor(rows, email, cat.id);
    const curStart = currentPeriodStart(cat);
    const r = E.replayFrom(cat, mine, curStart, fromPeriodKey);
    const corrected = {};
    r.entries.forEach(function (e) { corrected[String(e.id)] = e; });
    let changed = 0;
    mine.forEach((row) => {
      const e = corrected[String(row.id)];
      if (!e) return; // before the edited period — never re-priced
      if (E.isTrueFlag(row.freezeUsed) === e.freezeUsed && (Number(row.amount) || 0) === e.amount) return;
      if (String(row.id) !== String(excludeId)) changed++;
      row.freezeUsed = e.freezeUsed;
      row.amount = e.amount;
      store.updateLedgerRow(row.id, { freezeUsed: e.freezeUsed, amount: e.amount });
    });
    // balanceAfter is cosmetic (the app re-derives) but keep rows readable.
    const a = String(email || '').toLowerCase();
    const myAll = rows.filter((x) => String(x.actor || '').toLowerCase() === a);
    const rb = E.runningBalanceRows(rows, email);
    for (let i = 0; i < rb.length; i++) {
      if (Number(myAll[i].balanceAfter) !== rb[i].balanceAfter) {
        myAll[i].balanceAfter = rb[i].balanceAfter;
        store.updateLedgerRow(myAll[i].id, { balanceAfter: rb[i].balanceAfter });
      }
    }
    const wallet = rb.length ? rb[rb.length - 1].balanceAfter : 0;
    // Unused-freeze bonuses are settled once, at the rollover that paid them, and
    // an edit leaves them alone in both directions. Re-settling them let a
    // back-filled answer mint a bonus for a period that had earned nothing.
    const s = catStateOf(email, cat.id, cat);
    saveCatState(email, cat.id, {
      streak: r.state.streak,
      periodStart: s.periodStart,
      freezeRefresh: s.freezeRefresh,
      freezesUsedThisPeriod: r.state.freezesUsedThisPeriod,
      lastRecordedKey: r.state.lastRecordedKey,
      since: s.since,
    });
    return {
      wallet: wallet, changed: changed,
      entry: excludeId != null ? corrected[String(excludeId)] || null : null,
    };
  }

  // Change or back-fill the answer for any closed period. Dashboard only —
  // signed email links stay single-purpose, and the same cap as doRecord's
  // (nothing open or future) means amend can't inflate a streak any further
  // than honest recording could.
  function doAmend(p) {
    const email = requireUser(p);
    const result = p.result;
    const periodKey = String(p.periodKey || '');
    const cat = categoryById(p.categoryId);
    if (!cat) return { ok: false, error: 'unknown category' };
    if (!isHabit(cat)) return { ok: false, error: 'chores are claimed, not answered — use its card on the dashboard' };
    if (!cat.active) return { ok: false, error: 'that habit is archived' };
    if (result !== 'on_time' && result !== 'missed') {
      return { ok: false, error: 'result must be "on_time" or "missed"' };
    }
    if (!E.validPeriodKey(cat.cadence, periodKey)) {
      return { ok: false, error: cat.cadence === 'weekly'
        ? 'pick a week like 2026-W33'
        : 'pick a real date (YYYY-MM-DD)' };
    }
    const latest = recordablePeriodKey(cat);
    if (E.periodKeyDate(periodKey) > E.periodKeyDate(latest)) {
      return { ok: false, error: 'that ' + (cat.cadence === 'weekly' ? 'week' : 'day') +
        ' isn\'t over yet — the latest you can record is ' + latest };
    }
    maybeRefresh(cat); // settle any pending rollover before touching history
    const rows = store.readLedgerRows();
    const before = entryRowsFor(rows, email, cat.id);
    let target = null;
    for (let i = 0; i < before.length; i++) {
      if (String(before[i].periodKey) === periodKey) { target = before[i]; break; }
    }
    if (target && String(target.result) === result) {
      return { ok: true, unchanged: true, wallet: E.deriveWallet(rows, email) };
    }
    let targetId;
    if (target) {
      store.updateLedgerRow(target.id, { result: result });
      targetId = target.id;
    } else {
      targetId = store.appendLedger({
        type: 'entry', category: cat.id, periodKey: periodKey, result: result,
        freezeUsed: false, amount: 0, balanceAfter: '', actor: email,
        timestamp: ctx.now(),
      });
    }
    const out = replayAndSave(email, cat, periodKey, targetId);
    const ae = out.entry || {};
    return {
      ok: true, wallet: out.wallet, cat: catPublic(email, cat),
      event: { periodKey: periodKey, result: result,
        freezeUsed: ae.freezeUsed === true, amount: Number(ae.amount) || 0 },
      ripple: { entriesChanged: out.changed },
    };
  }

  // Everything this person has recorded for one habit — the dashboard's 20-row
  // ledger window is not enough for the past-date picker.
  function doCatHistory(p) {
    const email = requireUser(p);
    const cat = categoryById(p.categoryId);
    if (!cat) return { ok: false, error: 'unknown category' };
    const mine = entryRowsFor(store.readLedgerRows(), email, cat.id);
    mine.sort(function (a, b) {
      const da = E.periodKeyDate(a.periodKey);
      const db = E.periodKeyDate(b.periodKey);
      return da < db ? 1 : da > db ? -1 : 0;
    });
    return {
      ok: true,
      entries: mine.map(function (r) {
        return { periodKey: String(r.periodKey), result: r.result, freezeUsed: E.isTrueFlag(r.freezeUsed) };
      }),
    };
  }

  // "I did it" — claim the current period, or back-claim a penalized past one.
  function doClaim(p) {
    const email = requireUser(p);
    const cat = categoryById(p.categoryId);
    if (!cat) return { ok: false, error: 'unknown chore' };
    if (isHabit(cat)) return { ok: false, error: 'that\'s a habit — record it with its ✅/❌ buttons' };
    if (!cat.active) return { ok: false, error: 'that chore is archived' };
    if (cat.assignee && cat.assignee !== email) {
      return { ok: false, error: 'that chore is assigned to ' + store.displayName(cat.assignee) };
    }
    const s = choreStateOf(cat);
    const current = E.claimablePeriodKey(cat, todayStr());
    const periodKey = p.periodKey ? String(p.periodKey) : current;
    if (!E.validPeriodKey(cat.cadence, periodKey)) {
      return { ok: false, error: 'that isn\'t a valid period for this chore' };
    }
    if (periodKey > current) return { ok: false, error: 'that period hasn\'t started yet' };
    if (cat.cadence !== 'once' && periodKey < s.since) {
      return { ok: false, error: 'this chore only started being tracked in ' + s.since };
    }
    let rows = null;
    const getRows = function () { if (rows === null) rows = store.readLedgerRows(); return rows; };
    sweepChores(getRows); // a back-claim's pot must be settled before it pays out
    // Only the open period and the one most recently closed can be claimed: once
    // a chore comes due again, the period before it is gone for good.
    if (periodKey !== current) {
      const catchable = catchablePeriod(cat, choreStateOf(cat), todayStr());
      if (periodKey !== catchable) {
        return { ok: false, error: periodKey + ' is gone — it came due again before anyone did it' };
      }
    }
    if (E.isChoreClaimed(getRows(), cat.id, periodKey)) {
      return { ok: false, error: 'already done — ' + periodKey + ' is claimed' };
    }
    const pot = E.chorePotFor(getRows(), cat.id, periodKey);
    const amount = E.chorePayout(cat, pot);
    const wallet = E.round2(E.deriveWallet(getRows(), email) + amount);
    store.appendLedger({
      type: 'claim', category: cat.id, periodKey: periodKey,
      amount: amount, actor: email, balanceAfter: wallet,
      timestamp: ctx.now(),
    });
    if (cat.cadence === 'once') {
      const list = store.categoriesAll();
      for (let i = 0; i < list.length; i++) if (list[i].id === cat.id) list[i].active = false;
      store.saveCategories(list); // done is done — the card disappears
    }
    return { ok: true, wallet: wallet, event: { periodKey: periodKey, amount: amount, pot: pot } };
  }

  function doListCategories(p) {
    requireUser(p);
    return {
      ok: true, categories: store.categoriesAll(),
      people: store.allowlist().map(function (e) { return { email: e, name: store.displayName(e) }; }),
    };
  }

  function doSaveCategory(p) {
    requireUser(p);
    const raw = p.category ? (typeof p.category === 'string' ? JSON.parse(p.category) : p.category) : p;
    const cat = E.normalizeCategory(raw);
    const errs = E.validateCategory(cat);
    if (errs.length) return { ok: false, error: errs.join(' ') };
    // The pure engine can't see the allowlist, so this check belongs to the
    // glue, not validateCategory.
    if (!isHabit(cat) && cat.assignee && store.allowlist().indexOf(cat.assignee) === -1) {
      return { ok: false, error: 'assignee must be one of the two of you' };
    }
    const list = store.categoriesAll();
    let idx = -1;
    for (let i = 0; i < list.length; i++) if (list[i].id === cat.id) idx = i;
    const oldCadence = idx >= 0 ? list[idx].cadence : null;
    if (idx >= 0) {
      // Each kind's state machinery (streak state vs. choreStates) replays
      // against the ledger under assumptions the other kind's rows would
      // corrupt — a category's kind is fixed for its lifetime.
      const oldKind = list[idx].kind === 'chore' ? 'chore' : 'habit';
      const newKind = isHabit(cat) ? 'habit' : 'chore';
      if (oldKind !== newKind) {
        return { ok: false, error: 'a category can\'t change between habit and chore — archive it and create a new one' };
      }
      // The admin form carries only the fields it renders. Anything it omits
      // keeps its stored value — otherwise every edit wiped the emoji and
      // un-archived an archived category.
      if (raw.emoji == null) cat.emoji = list[idx].emoji || '';
      if (raw.notes == null) cat.notes = list[idx].notes || '';
      if (raw.active == null) cat.active = list[idx].active !== false;
      // A period that has already ended must be settled under the cadence that
      // was in force when it ended. Without this the rebase below — which is
      // right to refuse payment for an *edit* — also swallows the real rollover.
      if (list[idx].active && cat.freezeRefresh !== list[idx].freezeRefresh) {
        maybeRefresh(list[idx]);
      }
      list[idx] = cat;
    } else {
      list.push(cat);
    }
    store.saveCategories(list);
    if (!isHabit(cat)) {
      const cm = store.choreStatesAll();
      if (oldCadence && oldCadence !== cat.cadence) {
        // The stored `since` is a period key in the OLD cadence's format
        // (e.g. a date vs. "YYYY-MM" vs. "YYYY-Www") — doClaim's lexicographic
        // `periodKey < since` floor and stateResponse's outstanding filter both
        // compare it against NEW-format keys, so preserving it silently
        // mismatches (a daily->monthly edit bricks claiming all month; a
        // daily->weekly edit disables the floor entirely). Restart both at the
        // current period instead.
        const cur = E.claimablePeriodKey(cat, todayStr());
        cm[cat.id] = { since: cur, sweepFrom: cur, chargedThrough: todayStr() };
        store.saveChoreStates(cm);
      } else if (!cm[cat.id]) {
        const cur2 = E.claimablePeriodKey(cat, todayStr());
        cm[cat.id] = { since: cur2, sweepFrom: cur2, chargedThrough: todayStr() };
        store.saveChoreStates(cm);
      }
    }
    return { ok: true, categories: list };
  }

  function doArchiveCategory(p) {
    requireUser(p);
    const id = p.categoryId;
    const list = store.categoriesAll();
    for (let i = 0; i < list.length; i++) if (list[i].id === id) list[i].active = false;
    store.saveCategories(list);
    return { ok: true, categories: list };
  }

  function doUnarchiveCategory(p) {
    requireUser(p);
    const id = p.categoryId;
    const list = store.categoriesAll();
    let cat = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) { list[i].active = true; cat = list[i]; }
    }
    store.saveCategories(list);
    // Archived categories are skipped by maybeRefresh, so the stored period start
    // is however old the archive is. Left alone, the next refresh reads that gap
    // as one period ending and pays an unused-freeze bonus for weeks the habit
    // wasn't running. Resume in the current period instead, unpaid.
    if (cat && isHabit(cat)) restartPeriod(cat);
    if (cat && !isHabit(cat) && cat.cadence !== 'once') {
      // The archived stretch owes nothing — resume sweeping at the current period.
      const cm = store.choreStatesAll();
      const s = cm[cat.id] || { since: E.claimablePeriodKey(cat, todayStr()) };
      s.sweepFrom = E.claimablePeriodKey(cat, todayStr());
      s.chargedThrough = todayStr(); // the daily clock skips the archived stretch too
      cm[cat.id] = s;
      store.saveChoreStates(cm);
    }
    return { ok: true, categories: list };
  }

  // Move everyone's state for this category into the current period without
  // settling the previous one.
  function restartPeriod(cat) {
    const newStart = currentPeriodStart(cat);
    store.allowlist().forEach(function (email) {
      const s = catStateOf(email, cat.id, cat);
      if (s.periodStart === newStart && s.freezeRefresh === cat.freezeRefresh) return;
      saveCatState(email, cat.id, E.applyRestart(s, cat, newStart));
    });
  }

  // ── emails and check-up links (main.gs 1224-1363) ──
  const money = (n) => '$' + Number(n).toFixed(2);

  // Runs hourly. Sends reminders + check-ups for categories scheduled this hour,
  // and performs freeze/bonus refresh when a category's period has rolled over.
  // Weekly categories are gated to one reminder (Sun) + one check-up (Mon) —
  // a mid-week check-up would record the still-open week.
  async function dispatch() {
    const hour = tzHourStr(ctx.now());
    const dow = currentDow();
    const cats = activeHabits();
    // Each step is isolated: a throw anywhere in here used to swallow every
    // remaining email for the hour, so one bad record meant a silent morning
    // with nothing to show for it. Failures are collected and returned, so the
    // mail still goes out AND the caller still sees the hour go red.
    const failures = [];
    const attempt = async (what, fn) => {
      try { await fn(); } catch (e) { failures.push(what + ' — ' + ((e && e.message) || e)); }
    };
    await attempt('refresh/sweep', async () => {
      cats.forEach(maybeRefresh);
      let rows = null;
      sweepChores(() => { if (rows === null) rows = store.readLedgerRows(); return rows; });
    });
    for (const cat of cats) {
      if (cat.reminderTime && cat.reminderTime === hour && E.shouldSendReminder(cat, dow)) {
        await attempt('reminder ' + cat.id, () => sendReminder(cat));
      }
      if (cat.checkupTime && cat.checkupTime === hour && E.shouldSendCheckup(cat, dow)) {
        await attempt('check-up ' + cat.id, () => sendCheckup(cat));
      }
    }
    // A pause silences the nags too — nobody needs "dishes on the line" emails
    // from a beach chair.
    if (!(chorePauseUntil() > todayStr())) {
      for (const cat of activeChores()) {
        if (cat.reminderTime && cat.reminderTime === hour) {
          await attempt('chore reminder ' + cat.id, () => sendChoreReminder(cat));
        }
      }
    }
    return { ok: failures.length === 0, failures };
  }

  async function sendReminder(cat) {
    for (const to of store.allowlist()) {
      const s = catStateOf(to, cat.id, cat);
      const potential = E.payout(cat, s.streak + 1);
      const subject = (cat.emoji || '🔥') + ' ' + cat.name + ' — ' + money(potential) + ' on the line';
      const heading = E.escapeHtml(cat.emoji || '🔥') + ' ' + E.escapeHtml(cat.name);
      const html =
        '<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">' +
        '<h2>' + heading + '</h2>' +
        '<p>Doing it earns <b>you</b> <b>' + money(potential) + '</b>.</p>' +
        '<ul><li>Streak: <b>' + s.streak + '</b></li>' +
        '<li>Freezes left: <b>' + E.freezesLeft(cat, s) + '</b></li></ul></div>';
      await ctx.mail.send({ to, subject, html });
    }
  }

  async function sendChoreReminder(cat) {
    const rows = store.readLedgerRows();
    const current = E.claimablePeriodKey(cat, todayStr());
    if (E.isChoreClaimed(rows, cat.id, current)) return; // done — no nag
    // Only the latest closed period can still be collected — a lost period's
    // pot is gone, so advertising it would promise money nobody can claim.
    const catchable = catchablePeriod(cat, choreStateOf(cat), todayStr());
    let pot = 0;
    E.outstandingChorePeriods(rows, cat.id).forEach(function (o) {
      if (o.periodKey === catchable) pot = E.round2(pot + o.pot);
    });
    const to = cat.assignee ? [cat.assignee] : store.allowlist();
    const subject = (cat.emoji || '🧹') + ' ' + cat.name + ' — ' + money(cat.value) + ' on the line';
    const html =
      '<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">' +
      '<h2>' + E.escapeHtml(cat.emoji || '🧹') + ' ' + E.escapeHtml(cat.name) + '</h2>' +
      '<p>Doing it pays <b>' + money(cat.value) + '</b>.' +
      (pot > 0 ? ' A pot of <b>' + money(pot) + '</b> is waiting from missed ' + (cat.cadence === 'once' ? 'time' : 'periods') + '.' : '') +
      (cat.dueDate ? '</p><p>Due by <b>' + E.escapeHtml(cat.dueDate) + '</b>.' : '') + '</p></div>';
    for (const addr of to) await ctx.mail.send({ to: addr, subject, html });
  }

  async function sendCheckup(cat) {
    // Ask about the period that just closed — the same one the dashboard buttons
    // write, so a check-up answer and a dashboard tap can't land on different keys.
    const periodKey = recordablePeriodKey(cat);
    const btn = 'display:inline-block;padding:14px 22px;margin:6px 0;border-radius:10px;font-size:18px;text-decoration:none;color:#fff';
    const rows = store.readLedgerRows();
    const exp = ctx.now().getTime() + CHECKUP_TTL_MS;
    for (const to of store.allowlist()) {
      if (E.isPeriodRecorded(rows, to, cat.id, periodKey)) continue; // already recorded — no nag
      const link = async (result) =>
        ctx.dashboardUrl + '?t=' + encodeURIComponent(await signToken({ person: to, categoryId: cat.id, periodKey, result, exp }, ctx.secret));
      const yesUrl = await link('on_time');
      const noUrl = await link('missed');
      const subject = 'Did you do ' + cat.name + '? ' + (cat.emoji || '');
      const html =
        '<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">' +
        '<h2>' + E.escapeHtml(cat.emoji || '☀️') + ' ' + E.escapeHtml(cat.name) +
        ' — ' + E.escapeHtml(periodKey) + '</h2>' +
        '<p><a href="' + yesUrl + '" style="' + btn + ';background:#2e7d32">✅ Yes</a></p>' +
        '<p><a href="' + noUrl + '" style="' + btn + ';background:#b00020">❌ No</a></p>' +
        '<p style="color:#666;font-size:13px">If you miss and still have a freeze, it\'s used automatically.</p></div>';
      await ctx.mail.send({ to, subject, html });
    }
  }

  // The token carried the person, category, period and answer; the caller has
  // already verified its signature and expiry.
  function checkup(payload) {
    return recordFor(payload.person, payload.categoryId, payload.periodKey, payload.result);
  }

  function route(p) {
    switch (p.action) {
      case 'state': return stateResponse(requireUser(p));
      case 'record': return doRecord(p);
      case 'spend': return doSpend(p);
      case 'deleteEntry': return doDeleteEntry(p);
      case 'amend': return doAmend(p);
      case 'catHistory': return doCatHistory(p);
      case 'claim': return doClaim(p);
      case 'pauseChores': return doPauseChores(p);
      case 'resumeChores': return doResumeChores(p);
      case 'listCategories': return doListCategories(p);
      case 'saveCategory': return doSaveCategory(p);
      case 'archiveCategory': return doArchiveCategory(p);
      case 'unarchiveCategory': return doUnarchiveCategory(p);
      default: return { ok: true, name: 'Homebase API' };
    }
  }

  return { route, recordFor, dispatch, checkup };
}
