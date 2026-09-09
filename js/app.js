// ES module: the browser loads this with <script type="module">.
import { api, checkup, requestLogin, getSession, signOut, onAuthChange, configured } from './api.js';

/* ── tiny helpers ───────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const money = (n) => '$' + Number(n || 0).toFixed(2);
// Every innerHTML below interpolates values the two of you typed — category
// names (which render in each other's dashboard) and ledger notes.
const esc = (v) =>
  String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Mirrors the backend's slugify so the UI can detect duplicate category ids.
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/* Mirrors of backend period helpers (engine.js) — keep in sync. */
const shiftDays = (dateStr, n) => {
  const p = String(dateStr).split('-');
  const d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  // Bare "Invalid time value" in a banner names neither the value nor the walk.
  if (isNaN(d.getTime())) throw new Error('shiftDays("' + dateStr + '", ' + n + '): expected a YYYY-MM-DD date');
  return d.toISOString().slice(0, 10);
};
const isoWeek = (dateStr) => {
  const p = dateStr.split('-');
  const d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + '-W' + ('0' + weekNo).slice(-2);
};
const weekKeyMonday = (weekKey) => {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!m) return weekKey;
  const jan4 = m[1] + '-01-04';
  const dow = new Date(jan4 + 'T00:00:00Z').getUTCDay() || 7;
  return shiftDays(shiftDays(jan4, -(dow - 1)), (Number(m[2]) - 1) * 7);
};
// Shown when a category call returns ok but no categories array — the tell-tale
// of the frontend talking to an old/wrong backend deployment.
const STALE_BACKEND_MSG =
  '⚠️ The backend didn\'t return category data — the app may be pointed at an old deployment. Check SUPABASE_URL in js/config.js and redeploy.';

// A second tap while a save is in flight double-records the period, or surfaces
// the backend's raw "already recorded" error over a save that actually worked.
let inFlight = false;
const setBusy = (busy) => {
  inFlight = busy;
  document.querySelectorAll('#catCards button, #choreCards button, #ledger button').forEach((b) => { b.disabled = busy; });
};

function banner(msg, isError) {
  const b = $('banner');
  b.textContent = msg;
  b.className = 'banner' + (isError ? ' error' : ' ok');
  b.hidden = !msg;
}

function setView(name) {
  ['loginView', 'checkinView', 'dashView', 'adminView'].forEach((v) => ($(v).hidden = true));
  $({ login: 'loginView', checkin: 'checkinView', dash: 'dashView', admin: 'adminView' }[name]).hidden = false;
  $('logoutBtn').hidden = !SIGNED_IN;
}

// Last-rendered category list, so the admin form can guard against duplicate ids.
let CAT_LIST = [];
// Mirrors the Supabase session so setView can show/hide the logout button
// without an await.
let SIGNED_IN = false;

/* ── rendering ──────────────────────────────────────────────────────────────*/
function render(r) {
  $('whoami').textContent = r.name || r.user || '';
  $('wallet').textContent = money(r.wallet);
  $('manageBtn').hidden = false;
  renderPartner(r.partner);
  renderCatCards(r.cats || []);
  renderChoreCards(r.chores || [], r.pauseUntil || '');
  renderLedger(r.ledger || []);
}

function renderPartner(p) {
  const card = $('partnerCard');
  if (!p) { card.hidden = true; return; }
  card.hidden = false;
  $('partnerName').textContent = (p.name || 'Partner') + "'s wallet";
  $('partnerWallet').textContent = money(p.wallet);
}

function renderCatCards(cats) {
  const wrap = $('catCards');
  wrap.innerHTML = '';
  if (!cats.length) {
    wrap.innerHTML = '<div class="card"><p class="muted">No categories yet. Tap "Categories" to add one.</p></div>';
    return;
  }
  cats.forEach((c) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<h2>' + (c.emoji ? esc(c.emoji) + ' ' : '') + esc(c.name) + '</h2>' +
      '<div class="prow">' +
      '<div><span class="label">Streak</span><span class="pval">' + c.streak + '</span></div>' +
      '<div><span class="label">If you do it</span><span class="pval">' + money(c.potential) + '</span></div>' +
      '<div><span class="label">Freezes</span><span class="pval">' + c.freezeAvailable + '</span></div>' +
      '</div>' +
      '<div class="row main-actions" style="margin-top:8px">' +
      '<button class="ok" data-result="on_time">✅ Did it</button>' +
      '<button class="danger" data-result="missed">❌ Missed</button>' +
      '</div>' +
      '<p class="muted">' + (c.cadence === 'weekly' ? 'Weekly' : 'Daily') +
      ' • records ' + esc(c.nextPeriodKey || '—') + ' • last: ' + esc(c.lastRecordedKey || '—') + '</p>' +
      (c.notes
        ? '<details class="notes"><summary>📝 Notes</summary><p class="notes-text">' + esc(c.notes) + '</p></details>'
        : '') +
      '<details class="fix-past">' +
      '<summary>✏️ Fix a past ' + (c.cadence === 'weekly' ? 'week' : 'day') + '</summary>' +
      '<div class="row fix-row">' +
      (c.cadence === 'weekly'
        ? '<select class="fix-picker"></select>'
        : '<input class="fix-picker" type="date" value="' + esc(c.nextPeriodKey || '') +
          '" max="' + esc(c.nextPeriodKey || '') + '" />') +
      '<button class="ok" data-fix="on_time">✅ Did it</button>' +
      '<button class="danger" data-fix="missed">❌ Missed</button>' +
      '</div>' +
      '<p class="muted fix-current"></p>' +
      '</details>';
    wrap.appendChild(card);
    const label = (c.emoji ? c.emoji + ' ' : '') + c.name;
    card.querySelectorAll('.main-actions button[data-result]').forEach((b) =>
      b.addEventListener('click', () => onRecordClick(c, b.getAttribute('data-result'), label)));
    wireFixPast(card, c, label);
  });
}

const DUE_DAY_NAMES = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

function renderChoreCards(chores, pauseUntil) {
  const wrap = $('choreCards');
  wrap.innerHTML = '';
  if (chores.length || pauseUntil) renderChorePause(wrap, pauseUntil);
  // Only what needs attention today sits at the top; the rest of the week
  // collapses, and the do-whenever chores (monthly, undated one-timers) sink.
  const groups = { today: [], week: [], month: [] };
  chores.forEach((c) => { (groups[c.group] || groups.today).push(c); });
  groups.today.forEach((c) => wrap.appendChild(choreCard(c)));
  if (groups.week.length) {
    const det = document.createElement('details');
    det.className = 'chore-week';
    det.innerHTML = '<summary>📅 Later this week — ' + groups.week.length +
      ' chore' + (groups.week.length === 1 ? '' : 's') + '</summary>';
    groups.week.forEach((c) => det.appendChild(choreCard(c)));
    wrap.appendChild(det);
  }
  if (groups.month.length) {
    const h = document.createElement('p');
    h.className = 'muted chore-group-label';
    h.textContent = '🗓️ Any day this month';
    wrap.appendChild(h);
    groups.month.forEach((c) => wrap.appendChild(choreCard(c)));
  }
}

function choreCard(c) {
  const label = (c.emoji ? c.emoji + ' ' : '') + c.name;
  // The frontend ships before the backend (see README), so a card may arrive
  // from a deployment that predates these fields. Missing ones read as empty
  // rather than throwing and blanking every card on the page.
  const outstanding = Array.isArray(c.outstanding) ? c.outstanding : [];
  const who = c.assignee ? esc(c.assigneeName) : 'either of you';
  const cadence = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', once: 'One-time' }[c.cadence] || c.cadence;
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML =
    '<h2>' + (c.emoji ? esc(c.emoji) + ' ' : '🧹 ') + esc(c.name) + '</h2>' +
    '<div class="prow">' +
    '<div><span class="label">Worth</span><span class="pval">' + money(c.value) + '</span></div>' +
    '<div><span class="label">Who</span><span class="pval">' + who + '</span></div>' +
    (c.dueDate ? '<div><span class="label">Due</span><span class="pval">' + esc(c.dueDate) + '</span></div>' : '') +
    '</div>' +
    (c.claimedBy
      ? '<p class="chore-done">✓ ' + esc(c.claimedBy) + (c.cadence === 'daily' ? ', today' : '') + '</p>'
      : '<div class="row" style="margin-top:8px"><button class="ok" data-claim>✋ I did it</button></div>') +
    '<p class="muted">' + cadence +
    (c.cadence === 'weekly' && c.dueDay ? ' • due ' + (DUE_DAY_NAMES[c.dueDay] || esc(c.dueDay)) : '') +
    (c.cadence === 'once' ? '' : ' • this period: ' + esc(c.claimablePeriodKey)) + '</p>' +
    (c.notes
      ? '<details class="notes"><summary>📝 Notes</summary><p class="notes-text">' + esc(c.notes) + '</p></details>'
      : '') +
    // At most one period is ever catchable — older ones are gone for good.
    (outstanding.length
      ? '<details class="catch-up" open><summary>💰 Catch up — ' +
        money(outstanding[0].pot) + ' in the pot</summary>' +
        '<p class="muted catch-note">Last chance: this one is lost when ' +
        (c.cadence === 'once' ? 'it is archived' : 'the next one comes due') + '.</p>' +
        outstanding.map((o) =>
          '<div class="row catch-row"><span class="muted">' + esc(o.periodKey) + '</span>' +
          '<button class="ok" data-claim-past="' + esc(o.periodKey) + '">Claim ' +
          money(c.assignee ? c.value : c.value + o.pot) + '</button></div>').join('') +
        '</details>'
      : '');
  const claim = async (periodKey) => {
    if (inFlight) return;
    setBusy(true);
    banner('Saving…', false);
    try {
      const r = await api('claim', periodKey ? { categoryId: c.id, periodKey } : { categoryId: c.id });
      if (!r.ok) { banner(r.error || 'Could not claim', true); return; }
      if (typeof r.wallet === 'number') $('wallet').textContent = money(r.wallet);
      banner('🧹 ' + label + ' — +' + money(r.event.amount) +
        (r.event.pot > 0 ? ' (includes the ' + money(r.event.pot) + ' pot)' : '') + '.', false);
      await showDashboard(true);
    } catch (err) { banner(err.message, true); } finally { setBusy(false); }
  };
  const btn = card.querySelector('button[data-claim]');
  if (btn) btn.addEventListener('click', () => claim(null));
  card.querySelectorAll('button[data-claim-past]').forEach((b) =>
    b.addEventListener('click', () => claim(b.getAttribute('data-claim-past'))));
  return card;
}

// The vacation hold: one card that pauses every chore (no penalties, no
// reminder emails) until a chosen date, with an early-resume escape hatch.
function renderChorePause(wrap, pauseUntil) {
  const card = document.createElement('div');
  card.className = 'card';
  if (pauseUntil) {
    card.innerHTML =
      '<h2>⏸️ Chores paused</h2>' +
      '<p class="muted">No penalties or reminders until <b>' + esc(pauseUntil) +
      '</b> — everything that comes due while you\'re away is forgiven. Claims still pay if you do one anyway.</p>' +
      '<div class="row"><button data-resume>▶️ Resume now</button></div>';
  } else {
    card.innerHTML =
      '<details class="pause-chores"><summary>✈️ Going out of town?</summary>' +
      '<p class="muted">Pause every chore — no penalties, no reminder emails — until the day you\'re back. They restart that morning on their own.</p>' +
      '<div class="row"><input type="date" data-pause-until /> <button data-pause>⏸️ Pause chores</button></div>' +
      '</details>';
  }
  wrap.appendChild(card);
  const act = async (action, extra, doneMsg) => {
    if (inFlight) return;
    setBusy(true);
    banner('Saving…', false);
    try {
      const r = await api(action, extra);
      if (!r.ok) { banner(r.error || 'Could not update', true); return; }
      banner(doneMsg, false);
      await showDashboard(true);
    } catch (err) { banner(err.message, true); } finally { setBusy(false); }
  };
  const resume = card.querySelector('[data-resume]');
  if (resume) resume.addEventListener('click', () =>
    act('resumeChores', {}, '▶️ Chores are back on.'));
  const pause = card.querySelector('[data-pause]');
  if (pause) pause.addEventListener('click', () => {
    const until = card.querySelector('[data-pause-until]').value;
    if (!until) { banner('Pick the date you\'re back first.', true); return; }
    act('pauseChores', { until }, '⏸️ Chores paused until ' + until + '.');
  });
}

function describe(e) {
  if (e.type === 'spend') return '🛒 ' + esc(e.note || 'Spent');
  if (e.type === 'deposit') return '💵 ' + esc(e.note || 'Added money');
  const cat = e.categoryName || e.category;
  if (e.type === 'bonus') return '🎁 ' + esc(e.note || 'Bonus') + ' (' + esc(cat) + ')';
  if (e.type === 'claim') return '🧹 Did it: ' + esc(e.categoryName || e.category);
  if (e.type === 'penalty') return '⚠️ ' + esc(e.note || ('Unclaimed: ' + (e.categoryName || e.category)));
  if (e.type === 'entry') {
    const tag = cat ? ' (' + esc(cat) + ')' : '';
    if (e.result === 'on_time') return '✅ On time' + tag;
    if (e.freezeUsed) return '❄️ Freeze used' + tag;
    return '❌ Missed' + tag;
  }
  return e.type;
}
function amountCell(e) {
  if (e.type === 'spend') return '−' + money(e.amount);
  if (e.amount < 0) return '−' + money(-e.amount);
  if (e.amount > 0) return '+' + money(e.amount);
  return '';
}
function renderLedger(rows) {
  const body = $('ledger').querySelector('tbody');
  body.innerHTML = '';
  $('ledgerEmpty').hidden = rows.length > 0;
  rows.forEach((e) => {
    const tr = document.createElement('tr');
    const when = (e.periodKey || (e.timestamp || '').slice(0, 10) || '').toString();
    const canDelete = e.canDelete !== undefined
      ? e.canDelete
      : (e.type === 'spend' || e.type === 'deposit');
    const label = e.type === 'entry' ? 'Remove this answer' : 'Remove this entry';
    const del = canDelete && e.id
      ? '<button class="link-btn del" data-del="' + esc(e.id) + '" data-type="' + esc(e.type) +
        '" title="' + label + '" aria-label="' + label + '">✕</button>'
      : '';
    tr.innerHTML =
      '<td>' + esc(when) + '</td>' +
      '<td>' + describe(e) + '</td>' +
      '<td class="amt">' + amountCell(e) + '</td>' +
      '<td class="bal">' + money(e.balanceAfter) + '</td>' +
      '<td class="del-cell">' + del + '</td>';
    body.appendChild(tr);
  });
  body.querySelectorAll('button[data-del]').forEach((b) =>
    b.addEventListener('click', () => deleteEntry(b.getAttribute('data-del'), b.getAttribute('data-type'))));
}

async function deleteEntry(id, type) {
  if (inFlight) return;
  const isEntry = type === 'entry';
  const ask = isEntry
    ? 'Remove this answer? The period reopens, and your streak, freezes, and payouts are recomputed from the corrected history.'
    : 'Remove this entry? This updates your wallet total.';
  if (!window.confirm(ask)) return;
  setBusy(true);
  banner('Removing…', false);
  try {
    const r = await api('deleteEntry', { id });
    if (!r.ok) { banner(r.error || 'Could not remove', true); return; }
    if (typeof r.wallet === 'number') $('wallet').textContent = money(r.wallet);
    banner('Entry removed.', false);
    // Awaited inside the try so the in-flight lock outlives the re-render: the
    // buttons must not re-enable against stale card data.
    await showDashboard(true);
  } catch (err) {
    banner(err.message, true);
  } finally { setBusy(false); }
}

/* ── flows ──────────────────────────────────────────────────────────────────*/
async function showDashboard(keepBanner) {
  setView('dash');
  if (!keepBanner) banner('', false);
  // A dashboard that paints on the previous visit's data beats an empty card
  // while the round-trip runs.
  try {
    const cached = JSON.parse(localStorage.getItem('hb_state') || 'null');
    if (cached && !keepBanner) { render(cached); banner('Refreshing…', false); }
  } catch { /* ignore */ }
  try {
    const r = await api('state');
    if (!r.ok) {
      if (/authoriz/i.test(r.error || '')) {
        await signOut();
        // Otherwise the next person on a shared browser sees this person's
        // name, wallet, and ledger notes until the first round trip lands.
        try { localStorage.removeItem('hb_state'); } catch { /* ignore */ }
        SIGNED_IN = false;
        setView('login');
        banner('Your session expired — please log in again.', true);
        return;
      }
      banner(r.error || 'Could not load data', true);
      return;
    }
    try { localStorage.setItem('hb_state', JSON.stringify(r)); } catch { /* ignore */ }
    // Clears the cached path's "Refreshing…" once the fresh data is in hand.
    if (!keepBanner) banner('', false);
    render(r);
    // The admin views already flag an old deployment; the dashboard used to show
    // a friendly "No categories yet" instead. An empty list is a real [] — only
    // a missing one means the backend is older than this page.
    if (!Array.isArray(r.cats)) banner(STALE_BACKEND_MSG, true);
  } catch (err) {
    banner(err.message, true);
  }
}

async function recordCat(categoryId, result, label) {
  if (inFlight) return;
  if (result === 'missed' &&
      !window.confirm('Record a miss for "' + (label || 'this habit') + '"? ' +
        'A freeze is used automatically if you have one; otherwise your streak takes the hit.')) {
    return;
  }
  setBusy(true);
  banner('Saving…', false);
  try {
    const r = await api('record', { categoryId, result });
    if (!r.ok) { banner(r.error || 'Could not save', true); return; }
    if (typeof r.wallet === 'number') $('wallet').textContent = money(r.wallet);
    const e = r.event;
    if (e.result === 'on_time') banner('🎉 ' + (label || 'Done') + ' — earned ' + money(e.amount) + '.', false);
    else if (e.freezeUsed) banner('❄️ Freeze used — streak protected.', false);
    else banner('Streak reset. Fresh start 💪', false);
    // Awaited inside the try so the in-flight lock outlives the re-render:
    // otherwise a double-tap hits the backend's "already recorded" rejection.
    await showDashboard(true);
  } catch (err) {
    banner(err.message, true);
  } finally { setBusy(false); }
}

const prettyResult = (r) => (r === 'on_time' ? '✅ Did it' : '❌ Missed');

async function amend(categoryId, periodKey, result) {
  if (inFlight) return;
  setBusy(true);
  banner('Saving…', false);
  try {
    const r = await api('amend', { categoryId, periodKey, result });
    if (!r.ok) { banner(r.error || 'Could not save', true); return; }
    if (r.unchanged) { banner('Already recorded — nothing changed.', false); return; }
    if (typeof r.wallet === 'number') $('wallet').textContent = money(r.wallet);
    const n = (r.ripple && r.ripple.entriesChanged) || 0;
    banner('Changed ' + periodKey + ' to ' + (result === 'on_time' ? '✅' : '❌') +
      (n ? ' — ' + n + ' later ' + (n === 1 ? 'entry' : 'entries') + ' adjusted.' : '.'), false);
    // Awaited inside the try so the in-flight lock outlives the re-render: the
    // buttons must not re-enable against stale card data.
    await showDashboard(true);
  } catch (err) {
    banner(err.message, true);
  } finally { setBusy(false); }
}

function onRecordClick(c, result, label) {
  if (!c.recordedResult) { recordCat(c.id, result, label); return; }
  const period = c.cadence === 'weekly' ? 'last week' : 'last night';
  if (c.recordedResult === result) {
    banner('You already recorded ' + prettyResult(result) + ' for ' + period + ' — nothing to change.', false);
    return;
  }
  if (!window.confirm('You recorded ' + prettyResult(c.recordedResult) + ' for ' + period +
      ' (' + (c.nextPeriodKey || '') + '). Change it to ' + prettyResult(result) +
      '? Later entries adjust automatically.')) return;
  amend(c.id, c.nextPeriodKey, result);
}

function wireFixPast(card, c, label) {
  const det = card.querySelector('details.fix-past');
  const picker = det.querySelector('.fix-picker');
  const cur = det.querySelector('.fix-current');
  let history = null; // periodKey -> 'on_time' | 'missed'; null until first open

  if (c.cadence === 'weekly' && c.nextPeriodKey) {
    // "2026-W33" alone is unreadable; pair it with the dates it covers.
    const md = (dateStr) =>
      new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US',
        { month: 'short', day: 'numeric', timeZone: 'UTC' });
    let monday = weekKeyMonday(c.nextPeriodKey);
    for (let i = 0; i < 12; i++) {
      const key = isoWeek(monday);
      const sunday = shiftDays(monday, 6);
      // Drop the repeated month only when the week stays inside one.
      const span = md(monday) + '–' +
        (monday.slice(0, 7) === sunday.slice(0, 7) ? String(Number(sunday.slice(8, 10))) : md(sunday));
      picker.innerHTML +=
        '<option value="' + esc(key) + '">' + esc(key) + ' · ' + esc(span) + '</option>';
      monday = shiftDays(monday, -7);
    }
  }

  const refreshCurrent = () => {
    const k = picker.value;
    if (!k || history === null) { cur.textContent = ''; return; }
    const r = history[k];
    cur.textContent = r
      ? 'Currently recorded: ' + prettyResult(r)
      : 'Not recorded yet.';
  };

  det.addEventListener('toggle', async () => {
    if (!det.open || history !== null) return;
    try {
      const r = await api('catHistory', { categoryId: c.id });
      if (!r.ok) { banner(r.error || 'Could not load history', true); return; }
      history = {};
      (r.entries || []).forEach((e) => { history[e.periodKey] = e.result; });
      refreshCurrent();
    } catch (err) { banner(err.message, true); }
  });
  picker.addEventListener('change', refreshCurrent);

  det.querySelectorAll('button[data-fix]').forEach((b) =>
    b.addEventListener('click', () => {
      const key = picker.value;
      const result = b.getAttribute('data-fix');
      if (!key) {
        banner('Pick a ' + (c.cadence === 'weekly' ? 'week' : 'date') + ' first.', true);
        return;
      }
      const existing = history && history[key];
      if (existing === result) {
        banner(key + ' is already recorded as ' + prettyResult(result) + '.', false);
        return;
      }
      if (existing &&
          !window.confirm('You recorded ' + prettyResult(existing) + ' for ' + key +
            '. Change it to ' + prettyResult(result) + '? Later entries adjust automatically.')) return;
      if (!existing && result === 'missed' &&
          !window.confirm('Record a miss for "' + label + '" on ' + key + '? ' +
            'A freeze is used automatically if one was available; otherwise your streak takes the hit.')) return;
      amend(c.id, key, result);
    }));
}

async function checkinFlow(t) {
  setView('checkin');
  $('checkinTitle').textContent = 'Check-in';
  $('checkinBody').textContent = 'Recording your answer…';
  $('checkinResult').hidden = false;
  $('checkinResult').textContent = 'Saving…';
  try {
    const r = await checkup(t);
    const res = $('checkinResult');
    if (!r.ok) {
      res.textContent = /already recorded/i.test(r.error || '') ? '✅ Already recorded.' : '⚠️ ' + (r.error || 'Could not save');
    } else {
      const e = r.event;
      $('checkinTitle').textContent = 'Check-in: ' + e.periodKey;
      if (e.result === 'on_time') res.textContent = '🎉 Recorded! Earned ' + money(e.amount) + '. Wallet: ' + money(r.wallet) + '.';
      else if (e.freezeUsed) res.textContent = '❄️ Freeze used — streak protected.';
      else res.textContent = 'Streak reset. Fresh start 💪 Wallet: ' + money(r.wallet) + '.';
    }
  } catch (err) {
    $('checkinResult').textContent = '⚠️ ' + err.message;
  }
  $('checkinDoneBtn').hidden = false;
}

/* ── admin ──────────────────────────────────────────────────────────────────*/
function fillHourOptions(sel) {
  sel.innerHTML = '<option value="">off</option>';
  for (let h = 0; h < 24; h++) {
    const hh = ('0' + h).slice(-2) + ':00';
    sel.innerHTML += '<option value="' + hh + '">' + hh + '</option>';
  }
}

async function showAdmin() {
  setView('admin');
  fillHourOptions($('catReminder'));
  fillHourOptions($('catCheckup'));
  resetCatForm();
  try {
    const r = await api('listCategories');
    if (!r.ok) { banner(r.error || 'Could not load categories', true); return; }
    if (!Array.isArray(r.categories)) { banner(STALE_BACKEND_MSG, true); return; }
    renderCatList(r.categories);
    const asel = $('catAssignee');
    asel.innerHTML = '<option value="">Either of you</option>';
    (r.people || []).forEach((p) => {
      asel.innerHTML += '<option value="' + esc(p.email) + '">' + esc(p.name) + '</option>';
    });
  } catch (err) { banner(err.message, true); }
}

function renderCatList(cats) {
  CAT_LIST = cats;
  const body = $('catList').querySelector('tbody');
  body.innerHTML = '';
  cats.forEach((c) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + (c.emoji ? esc(c.emoji) + ' ' : '') + esc(c.name) +
        (c.active ? '' : ' (archived)') + '</td>' +
      '<td>' + esc(c.cadence) + '</td>' +
      '<td><button class="link-btn" data-edit="' + esc(c.id) + '">edit</button> ' +
      (c.active
        ? '<button class="link-btn" data-arch="' + esc(c.id) + '">archive</button>'
        : '<button class="link-btn" data-unarch="' + esc(c.id) + '">unarchive</button>') + '</td>';
    body.appendChild(tr);
  });
  body.querySelectorAll('button[data-edit]').forEach((b) =>
    b.addEventListener('click', () => editCat(cats.find((x) => x.id === b.getAttribute('data-edit')))));
  body.querySelectorAll('button[data-arch]').forEach((b) =>
    b.addEventListener('click', () => setCatActive(b.getAttribute('data-arch'), 'archiveCategory')));
  body.querySelectorAll('button[data-unarch]').forEach((b) =>
    b.addEventListener('click', () => setCatActive(b.getAttribute('data-unarch'), 'unarchiveCategory')));
}

function editCat(c) {
  $('catId').value = c.id; $('catName').value = c.name; $('catEmoji').value = c.emoji || '';
  $('catKind').value = c.kind === 'chore' ? 'chore' : 'habit';
  applyKindToForm($('catKind').value);
  $('catCadence').value = c.cadence;
  if (c.kind !== 'chore') {
    $('catRefresh').value = c.freezeRefresh;
    $('catIncrement').value = c.rewardIncrement; $('catMax').value = c.maxPerInstance;
    $('catFreezes').value = c.freezesPerPeriod; $('catBonus').value = c.unusedFreezeBonus;
    $('catMinPayout').value = c.minPayout || '';
    $('catMissPenalty').value = c.missPenaltyPercent == null ? '' : c.missPenaltyPercent;
    $('catCheckup').value = c.checkupTime || '';
  } else {
    $('catValue').value = c.value; $('catAssignee').value = c.assignee || '';
    $('catDueDate').value = c.dueDate || ''; $('catDueDay').value = c.dueDay || '';
  }
  $('catNotes').value = c.notes || '';
  $('catReminder').value = c.reminderTime || '';
  $('catFormMsg').hidden = true;
  $('catFormTitle').textContent = 'Editing: ' + c.name;
  $('cancelEditBtn').hidden = false;
  $('catForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Toggle habit/chore field groups so submit only validates the fields the
// picked kind actually uses; hidden habit inputs must not block a chore submit.
function applyKindToForm(kind) {
  const chore = kind === 'chore';
  $('habitFields').hidden = chore;
  $('choreFields').hidden = !chore;
  document.querySelectorAll('#catCadence option.chore-cadence').forEach((o) => { o.hidden = !chore; });
  if (!chore && ($('catCadence').value === 'monthly' || $('catCadence').value === 'once')) {
    $('catCadence').value = 'daily';
  }
  document.querySelectorAll('#habitFields input').forEach((i) => { i.required = !chore && i.dataset.req === '1'; });
}

// Return the form to "add a new category" mode.
function resetCatForm() {
  $('catForm').reset();
  $('catId').value = '';
  $('catFormTitle').textContent = 'Add a category';
  $('cancelEditBtn').hidden = true;
  $('catFormMsg').hidden = true;
  applyKindToForm($('catKind').value = 'habit');
}

async function setCatActive(id, action) { // 'archiveCategory' | 'unarchiveCategory'
  try {
    const r = await api(action, { categoryId: id });
    if (!r.ok) { banner(r.error || 'Could not update', true); return; }
    if (!Array.isArray(r.categories)) { banner(STALE_BACKEND_MSG, true); return; }
    renderCatList(r.categories);
  } catch (err) { banner(err.message, true); }
}

/* ── wiring ─────────────────────────────────────────────────────────────────*/
function wire() {
  $('loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = $('loginEmail').value.trim();
    if (!email) return;
    try {
      await requestLogin(email);
      $('loginMsg').hidden = false;
      $('loginMsg').textContent =
        'If that email is on the list, a login link is on its way. Check your inbox 📬';
    } catch (err) {
      banner(err.message, true);
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    await signOut();
    try { localStorage.removeItem('hb_state'); } catch { /* ignore */ }
    SIGNED_IN = false;
    setView('login');
    banner('Logged out.', false);
  });

  $('spendForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const amount = $('spendAmount').value, note = $('spendNote').value;
    banner('Saving…', false);
    try {
      const r = await api('spend', { amount, note });
      if (!r.ok) { banner(r.error || 'Could not save', true); return; }
      if (typeof r.wallet === 'number') $('wallet').textContent = money(r.wallet);
      $('spendAmount').value = ''; $('spendNote').value = '';
      // The backend floors a spend at the wallet balance, so report what
      // actually left rather than what was typed.
      const spent = r.event && typeof r.event.amount === 'number' ? r.event.amount : Number(amount);
      banner(spent < Number(amount)
        ? 'Spent ' + money(spent) + ' — that was everything in the wallet.'
        : 'Spent ' + money(spent) + '.', false);
      showDashboard(true);
    } catch (err) { banner(err.message, true); }
  });

  // The check-in path returns from boot before it looks at the session, so ask
  // for it here rather than trusting SIGNED_IN.
  $('checkinDoneBtn').addEventListener('click', async () => {
    SIGNED_IN = !!(await getSession());
    if (SIGNED_IN) showDashboard();
    else setView('login');
  });

  $('manageBtn').addEventListener('click', showAdmin);
  $('backToDashBtn').addEventListener('click', () => showDashboard());
  $('cancelEditBtn').addEventListener('click', resetCatForm);

  // Remember which habit inputs are required today so applyKindToForm can
  // restore that state after a chore selection clears it.
  document.querySelectorAll('#habitFields input[required]').forEach((i) => { i.dataset.req = '1'; });
  $('catKind').addEventListener('change', () => applyKindToForm($('catKind').value));

  $('catForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const kind = $('catKind').value;
    const category = kind === 'chore'
      ? {
          id: $('catId').value || undefined, kind: 'chore',
          name: $('catName').value, emoji: $('catEmoji').value,
          cadence: $('catCadence').value, value: $('catValue').value,
          assignee: $('catAssignee').value, dueDate: $('catDueDate').value,
          dueDay: $('catDueDay').value, notes: $('catNotes').value,
          reminderTime: $('catReminder').value,
        }
      : {
          id: $('catId').value || undefined,
          name: $('catName').value, emoji: $('catEmoji').value,
          cadence: $('catCadence').value, freezeRefresh: $('catRefresh').value,
          rewardIncrement: $('catIncrement').value, maxPerInstance: $('catMax').value,
          freezesPerPeriod: $('catFreezes').value, unusedFreezeBonus: $('catBonus').value,
          minPayout: $('catMinPayout').value, missPenaltyPercent: $('catMissPenalty').value,
          notes: $('catNotes').value,
          reminderTime: $('catReminder').value, checkupTime: $('catCheckup').value,
          // `active` is deliberately absent: archive/unarchive owns that flag, and
          // sending it here un-archived every category you edited.
        };
    $('catFormMsg').hidden = true;
    // Adding (no id) but a category with this name already exists → would silently
    // overwrite it. Stop and tell the user to edit it instead.
    if (!category.id && CAT_LIST.some((c) => c.id === slugify(category.name))) {
      $('catFormMsg').hidden = false;
      $('catFormMsg').textContent =
        '⚠️ A category named "' + category.name + '" already exists. Tap “edit” on it in the list above, or pick a different name.';
      return;
    }
    try {
      const r = await api('saveCategory', { category: JSON.stringify(category) });
      if (!r.ok) { $('catFormMsg').hidden = false; $('catFormMsg').textContent = '⚠️ ' + r.error; return; }
      if (!Array.isArray(r.categories)) { $('catFormMsg').hidden = false; $('catFormMsg').textContent = STALE_BACKEND_MSG; return; }
      renderCatList(r.categories);
      resetCatForm();
      banner('Category saved.', false);
    } catch (err) { banner(err.message, true); }
  });
}

/* ── boot ───────────────────────────────────────────────────────────────────*/
async function boot() {
  wire();
  if (!configured()) {
    banner('⚠️ Backend not set up yet — add SUPABASE_URL and SUPABASE_ANON_KEY to js/config.js.', true);
  }
  const qp = new URLSearchParams(location.search);
  const t = qp.get('t');
  if (t) {
    history.replaceState({}, '', location.origin + location.pathname);
    checkinFlow(t);
    return;
  }
  // Supabase puts the magic-link session in the URL hash; the client
  // consumes it and fires onAuthChange.
  const session = await getSession();
  SIGNED_IN = !!session;
  // supabase-js consumes the hash during getSession() and leaves a bare '#'
  // behind, so test the whole href rather than location.hash.
  if (location.href.includes('#')) history.replaceState({}, '', location.origin + location.pathname);
  if (SIGNED_IN) showDashboard(); else setView('login');
  onAuthChange((s) => {
    const was = SIGNED_IN;
    SIGNED_IN = !!s;
    if (SIGNED_IN && !was) showDashboard();
  });
}

document.addEventListener('DOMContentLoaded', boot);
