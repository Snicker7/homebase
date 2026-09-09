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

// The wallet counts to its new value rather than jumping, so a payout reads
// as money arriving.
let walletShown = null; // null until the first render, which snaps
let walletAnim = 0;
function setWallet(n) {
  const el = $('wallet');
  const to = Number(n) || 0;
  const from = walletShown;
  cancelAnimationFrame(walletAnim);
  if (from === null || Math.abs(to - from) < 0.005 || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    walletShown = to; el.textContent = money(to); return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 450);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = money(from + (to - from) * eased);
    if (k < 1) walletAnim = requestAnimationFrame(step); else walletShown = to;
  };
  walletAnim = requestAnimationFrame(step);
}
// Cached state is on screen while the fresh copy loads: dim the wallet a touch.
function setUpdating(on) {
  const s = $('wallet').closest('.stat');
  if (s) s.classList.toggle('updating', !!on);
}

function setView(name) {
  ['loginView', 'checkinView', 'dashView', 'adminView'].forEach((v) => ($(v).hidden = true));
  $({ login: 'loginView', checkin: 'checkinView', dash: 'dashView', admin: 'adminView' }[name]).hidden = false;
  $('logoutBtn').hidden = !SIGNED_IN;
}

// Last-rendered category list, so the admin form can guard against duplicate ids.
let CAT_LIST = [];
// Named in the joint-claim banner.
let PARTNER_NAME = 'your partner';
// Mirrors the Supabase session so setView can show/hide the logout button
// without an await.
let SIGNED_IN = false;

/* ── rendering ──────────────────────────────────────────────────────────────*/
function render(r) {
  $('whoami').textContent = r.name || r.user || '';
  setWallet(r.wallet);
  $('manageBtn').hidden = false;
  renderPartner(r.partner);
  renderCatCards(r.cats || []);
  PARTNER_NAME = (r.partner && r.partner.name) || 'your partner';
  renderChoreCards(r.chores || [], r.pauseUntil || '', r.user);
  renderLedger(r.ledger || []);
}

function renderPartner(p) {
  const card = $('partnerCard');
  if (!p) { card.hidden = true; return; }
  card.hidden = false;
  $('partnerName').textContent = (p.name || 'Partner') + "'s wallet";
  $('partnerWallet').textContent = money(p.wallet);
}

/* ── habit cards ────────────────────────────────────────────────────────── */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const localToday = () => {
  const d = new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
};
// "2026-09-08" → "Mon, Sep 8"; "2026-W37" → "Week 37"; anything else unchanged.
function periodLabel(key) {
  const k = String(key || '');
  const w = /^(\d{4})-W(\d{2})$/.exec(k);
  if (w) return 'Week ' + Number(w[2]);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k);
  if (!m) return k;
  if (k === localToday()) return 'Today';
  if (k === shiftDays(localToday(), -1)) return 'Yesterday';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return DAYS[d.getUTCDay()] + ', ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
}

// One in-place question per card or feed row: the action row hides, the
// question shows, and Cancel puts things back. No browser dialogs.
function askInline(host, text, yesLabel, danger, onYes) {
  const ask = host.querySelector('.ask');
  const rows = host.querySelectorAll('.actions, .status');
  ask.querySelector('.ask-text').textContent = text;
  const yes = ask.querySelector('[data-yes]');
  yes.textContent = yesLabel;
  yes.className = danger ? 'danger' : 'ok';
  const close = () => { ask.hidden = true; rows.forEach((r) => { r.hidden = r.dataset.wasHidden === '1'; }); };
  rows.forEach((r) => { r.dataset.wasHidden = r.hidden ? '1' : '0'; r.hidden = true; });
  ask.hidden = false;
  yes.onclick = () => { close(); onYes(yes); };
  ask.querySelector('[data-no]').onclick = close;
}

// Surfaces a failure where the tap happened rather than at the top of the page.
function cardError(host, msg) {
  const el = host.querySelector('.inline-err');
  if (!el) { banner(msg, true); return; }
  el.textContent = msg;
  el.hidden = !msg;
}

function renderCatCards(cats) {
  const wrap = $('catCards');
  wrap.innerHTML = '';
  if (!cats.length) {
    wrap.innerHTML = '<div class="card"><p class="muted">No habits yet. Tap "Categories" to add one.</p></div>';
    return;
  }
  cats.forEach((c) => {
    const card = document.createElement('section');
    card.className = 'card habit';
    const label = (c.emoji ? c.emoji + ' ' : '') + c.name;
    const period = periodLabel(c.nextPeriodKey);
    const freezes = Number(c.freezeAvailable) || 0;
    const recorded = c.recordedResult;
    card.innerHTML =
      '<div class="habit-head">' +
      '<h2>' + (c.emoji ? '<span class="glyph">' + esc(c.emoji) + '</span>' : '') + esc(c.name) + '</h2>' +
      '<div class="streak" title="Current streak"><span class="flame">🔥</span>' + Number(c.streak || 0) + '</div>' +
      '</div>' +
      '<div class="hstrip">' +
      '<span class="hs"><b class="num">' + money(c.potential) + '</b> if you do it</span>' +
      '<span class="hs freezes" title="Freezes left this period">' +
      (freezes ? '❄️'.repeat(Math.min(freezes, 5)) + ' <span class="dim">' + freezes + ' left</span>' : '<span class="dim">no freezes left</span>') +
      '</span>' +
      '</div>' +
      '<div class="actions" data-mode="record"' + (recorded ? ' hidden' : '') + '>' +
      '<button class="ok" data-result="on_time">Did it</button>' +
      '<button class="danger" data-result="missed">Missed</button>' +
      '</div>' +
      '<div class="status ' + (recorded === 'on_time' ? 'good' : 'bad') + '"' + (recorded ? '' : ' hidden') + '>' +
      '<span class="status-text">' + (recorded === 'on_time' ? '✅ Done' : '❌ Missed') + ' · ' + esc(period) + '</span>' +
      '<button class="link-btn" data-change>Change</button>' +
      '</div>' +
      '<div class="ask" hidden><p class="ask-text"></p>' +
      '<div class="ask-btns"><button class="ghost" data-no>Cancel</button><button data-yes>Yes</button></div></div>' +
      '<p class="inline-err" hidden></p>' +
      '<p class="hmeta">' + (c.cadence === 'weekly' ? 'Weekly' : 'Nightly') + ' · recording ' + esc(period) +
      (c.lastRecordedKey ? ' · last ' + esc(periodLabel(c.lastRecordedKey)) : '') + '</p>' +
      '<details class="more"><summary>More</summary>' +
      (c.notes ? '<p class="notes-text">' + esc(c.notes) + '</p>' : '') +
      '<div class="fix-past">' +
      '<p class="fix-title">Fix a past ' + (c.cadence === 'weekly' ? 'week' : 'night') + '</p>' +
      '<div class="row fix-row">' +
      (c.cadence === 'weekly'
        ? '<select class="fix-picker"></select>'
        : '<input class="fix-picker" type="date" value="' + esc(c.nextPeriodKey || '') +
          '" max="' + esc(c.nextPeriodKey || '') + '" />') +
      '</div>' +
      '<div class="row fix-btns">' +
      '<button class="ok" data-fix="on_time">Did it</button>' +
      '<button class="danger" data-fix="missed">Missed</button>' +
      '</div>' +
      '<p class="muted fix-current"></p>' +
      '</div>' +
      '</details>';
    wrap.appendChild(card);

    card.querySelectorAll('.actions button[data-result]').forEach((b) =>
      b.addEventListener('click', () => onRecordClick(card, c, b.getAttribute('data-result'), label, b)));
    // "Change" reopens the buttons; a tap on the other answer then amends.
    card.querySelector('[data-change]').addEventListener('click', () => {
      card.querySelector('.status').hidden = true;
      card.querySelector('.actions').hidden = false;
      card.querySelector('.actions').dataset.mode = 'amend';
    });
    wireFixPast(card, c, label);
  });
}

// Marks the tapped button as working and freezes the rest of the page's
// actions until the round trip lands.
function startWork(btn) {
  setBusy(true);
  if (btn) btn.classList.add('is-loading');
}
function endWork(btn) {
  if (btn) btn.classList.remove('is-loading');
  setBusy(false);
}

function onRecordClick(card, c, result, label, btn) {
  cardError(card, '');
  if (!c.recordedResult) {
    if (result === 'missed') {
      const why = Number(c.freezeAvailable) > 0 ? 'A freeze covers it.' : 'Your streak resets.';
      askInline(card, 'Record a miss for ' + label + '? ' + why, 'Yes, missed', true, (b) => recordCat(card, c.id, result, label, b));
      return;
    }
    recordCat(card, c.id, result, label, btn);
    return;
  }
  if (c.recordedResult === result) {
    card.querySelector('.actions').hidden = true;
    card.querySelector('.status').hidden = false;
    return;
  }
  askInline(card, 'Change ' + periodLabel(c.nextPeriodKey) + ' to ' + prettyResult(result) + '? Later entries adjust.',
    'Change it', result === 'missed', (b) => amend(card, c.id, c.nextPeriodKey, result, b));
}

const DUE_DAY_NAMES = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
// The period a chore card is working in, in words: "today", "this week",
// "Sep 7 – Sep 20", "September".
function chorePeriodLabel(c) {
  const key = String(c.claimablePeriodKey || '');
  const md = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d); return m ? MONTHS[+m[2] - 1] + ' ' + Number(m[3]) : d; };
  if (c.cadence === 'daily') return 'today';
  if (c.cadence === 'weekly') return 'this week';
  if (c.cadence === 'biweekly') { const mon = weekKeyMonday(key); return md(mon) + ' – ' + md(shiftDays(mon, 13)); }
  if (c.cadence === 'monthly') { const m = /^(\d{4})-(\d{2})$/.exec(key); return m ? MONTHS[+m[2] - 1] : key; }
  return key;
}


function renderChoreCards(chores, pauseUntil, me) {
  const wrap = $('choreCards');
  wrap.innerHTML = '';
  if (chores.length || pauseUntil) renderChorePause(wrap, pauseUntil);
  // Only what needs attention today sits at the top; the rest of the week
  // collapses, and the do-whenever chores (monthly, undated one-timers) sink.
  const groups = { today: [], week: [], month: [] };
  chores.forEach((c) => { (groups[c.group] || groups.today).push(c); });
  groups.today.forEach((c) => wrap.appendChild(choreCard(c, me)));
  if (groups.week.length) {
    const det = document.createElement('details');
    det.className = 'chore-week';
    det.innerHTML = '<summary>📅 Coming up — ' + groups.week.length +
      ' chore' + (groups.week.length === 1 ? '' : 's') + '</summary>';
    groups.week.forEach((c) => det.appendChild(choreCard(c, me)));
    wrap.appendChild(det);
  }
  if (groups.month.length) {
    const h = document.createElement('p');
    h.className = 'muted chore-group-label';
    h.textContent = '🗓️ Any day this month';
    wrap.appendChild(h);
    groups.month.forEach((c) => wrap.appendChild(choreCard(c, me)));
  }
}

function choreCard(c, me) {
  const label = (c.emoji ? c.emoji + ' ' : '') + c.name;
  // The partner's chore is theirs to claim; this card only shows what it pays.
  const mine = !c.assignee || String(c.assignee).toLowerCase() === String(me || '').toLowerCase();
  // The frontend ships before the backend (see README), so a card may arrive
  // from a deployment that predates these fields. Missing ones read as empty
  // rather than throwing and blanking every card on the page.
  const outstanding = Array.isArray(c.outstanding) ? c.outstanding : [];
  const who = c.assignee ? esc(c.assigneeName) : 'Shared';
  const cadence = { daily: 'Daily', weekly: 'Weekly', biweekly: 'Every two weeks', monthly: 'Monthly', once: 'One-time' }[c.cadence] || c.cadence;
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
      : mine
        ? '<div class="actions" style="margin-top:8px"><button class="ok" data-claim>✋ I did it</button>' +
          (c.assignee ? '' : '<button class="ok-ghost" data-claim-together>🤝 We did it</button>') + '</div>'
        : '') +
    '<p class="muted">' + cadence +
    ((c.cadence === 'weekly' || c.cadence === 'biweekly') && c.dueDay ? ' • due ' + (DUE_DAY_NAMES[c.dueDay] || esc(c.dueDay)) : '') +
    (c.cadence === 'once' ? '' : ' • ' + esc(chorePeriodLabel(c))) + '</p>' +
    (c.notes
      ? '<details class="notes"><summary>📝 Notes</summary><p class="notes-text">' + esc(c.notes) + '</p></details>'
      : '') +
    // At most one period is ever catchable — older ones are gone for good.
    (outstanding.length && mine
      ? '<details class="catch-up" open><summary>💰 Catch up — ' +
        money(outstanding[0].pot) + ' in the pot</summary>' +
        '<p class="muted catch-note">Last chance: this one is lost when ' +
        (c.cadence === 'once' ? 'it is archived' : 'the next one comes due') + '.</p>' +
        outstanding.map((o) =>
          '<div class="row catch-row"><span class="muted">' + esc(periodLabel(o.periodKey)) + '</span>' +
          '<span class="catch-btns"><button class="ok" data-claim-past="' + esc(o.periodKey) + '">Claim ' +
          money(c.assignee ? c.value : c.value + o.pot) + '</button>' +
          (c.assignee ? '' : '<button class="ok-ghost" data-claim-past-together="' + esc(o.periodKey) + '">Together</button>') +
          '</span></div>').join('') +
        '</details>'
      : '');
  const claim = async (periodKey, together, btn) => {
    if (inFlight) return;
    startWork(btn);
    try {
      const body = { categoryId: c.id };
      if (periodKey) body.periodKey = periodKey;
      if (together) body.together = true;
      const r = await api('claim', body);
      if (!r.ok) { banner(r.error || 'Could not claim', true); return; }
      if (typeof r.wallet === 'number') setWallet(r.wallet);
      const e = r.event;
      banner('🧹 ' + label + (e.together
        ? ', together — +' + money(e.amount) + ' for you, +' + money(e.partnerAmount) + ' for ' + PARTNER_NAME
        : ' — +' + money(e.amount)) +
        (e.pot > 0 ? ' (includes the ' + money(e.pot) + ' pot)' : '') + '.', false);
      await showDashboard(true);
    } catch (err) { banner(err.message, true); } finally { endWork(btn); }
  };
  const wire = (sel, attr, together) => card.querySelectorAll(sel).forEach((b) =>
    b.addEventListener('click', () => claim(attr ? b.getAttribute(attr) : null, together, b)));
  wire('button[data-claim]', null, false);
  wire('button[data-claim-together]', null, true);
  wire('button[data-claim-past]', 'data-claim-past', false);
  wire('button[data-claim-past-together]', 'data-claim-past-together', true);
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


/* ── activity feed ──────────────────────────────────────────────────────── */
function describe(e) {
  const cat = e.categoryName || e.category;
  if (e.type === 'spend') return { icon: '🛒', text: e.note || 'Spent', sub: '' };
  if (e.type === 'deposit') return { icon: '💵', text: e.note || 'Added money', sub: '' };
  if (e.type === 'bonus') return { icon: '🎁', text: e.note || 'Bonus', sub: cat || '' };
  if (e.type === 'claim') return { icon: '🧹', text: 'Did it', sub: cat || '' };
  if (e.type === 'penalty') return { icon: '⚠️', text: e.note || 'Unclaimed', sub: cat || '' };
  if (e.type === 'entry') {
    if (e.result === 'on_time') return { icon: '✅', text: 'Done', sub: cat || '' };
    if (e.freezeUsed) return { icon: '❄️', text: 'Freeze used', sub: cat || '' };
    return { icon: '❌', text: 'Missed', sub: cat || '' };
  }
  return { icon: '•', text: e.type, sub: '' };
}
function amountCell(e) {
  const n = Number(e.amount) || 0;
  if (e.type === 'spend' || n < 0) return { text: '−' + money(Math.abs(n)), cls: 'minus' };
  if (n > 0) return { text: '+' + money(n), cls: 'plus' };
  return { text: '', cls: 'zero' };
}
function renderLedger(rows) {
  const feed = $('ledger');
  feed.innerHTML = '';
  $('ledgerEmpty').hidden = rows.length > 0;
  let lastDay = null;
  rows.forEach((e) => {
    const when = String(e.periodKey || (e.timestamp || '').slice(0, 10) || '');
    if (when !== lastDay) {
      const h = document.createElement('p');
      h.className = 'feed-day';
      h.textContent = periodLabel(when);
      feed.appendChild(h);
      lastDay = when;
    }
    const d = describe(e);
    const a = amountCell(e);
    const canDelete = e.canDelete !== undefined ? e.canDelete : (e.type === 'spend' || e.type === 'deposit');
    const isEntry = e.type === 'entry';
    const item = document.createElement('div');
    item.className = 'fe';
    item.innerHTML =
      '<div class="actions fe-row">' +
      '<span class="fe-ico">' + d.icon + '</span>' +
      '<div class="fe-main"><span class="fe-text">' + esc(d.text) + '</span>' +
      (d.sub ? '<span class="fe-sub">' + esc(d.sub) + '</span>' : '') + '</div>' +
      '<div class="fe-right"><span class="fe-amt ' + a.cls + '">' + a.text + '</span>' +
      '<span class="fe-bal">' + money(e.balanceAfter) + '</span></div>' +
      (canDelete && e.id
        ? '<button class="fe-del" data-del aria-label="' + (isEntry ? 'Remove this answer' : 'Remove this entry') + '">✕</button>'
        : '') +
      '</div>' +
      '<div class="ask" hidden><p class="ask-text"></p>' +
      '<div class="ask-btns"><button class="ghost" data-no>Cancel</button><button data-yes>Remove</button></div></div>' +
      '<p class="inline-err" hidden></p>';
    feed.appendChild(item);
    const del = item.querySelector('[data-del]');
    if (del) del.addEventListener('click', () => {
      if (inFlight) return;
      askInline(item,
        isEntry ? 'Remove this answer? The night reopens and streaks and payouts recompute.' : 'Remove this entry? Your wallet updates.',
        'Remove', true, (b) => deleteEntry(item, e.id, b));
    });
  });
}

async function deleteEntry(item, id, btn) {
  if (inFlight) return;
  startWork(btn);
  cardError(item, '');
  try {
    const r = await api('deleteEntry', { id });
    if (!r.ok) { cardError(item, r.error || 'Could not remove'); return; }
    if (typeof r.wallet === 'number') setWallet(r.wallet);
    banner('Entry removed.', false);
    // Awaited inside the try so the in-flight lock outlives the re-render: the
    // buttons must not re-enable against stale card data.
    await showDashboard(true);
  } catch (err) {
    cardError(item, err.message);
  } finally { endWork(btn); }
}

async function showDashboard(keepBanner) {
  setView('dash');
  if (!keepBanner) banner('', false);
  // A dashboard that paints on the previous visit's data beats an empty card
  // while the round-trip runs.
  try {
    const cached = JSON.parse(localStorage.getItem('hb_state') || 'null');
    if (cached && !keepBanner) { render(cached); setUpdating(true); }
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
    render(r);
    // The admin views already flag an old deployment; the dashboard used to show
    // a friendly "No categories yet" instead. An empty list is a real [] — only
    // a missing one means the backend is older than this page.
    if (!Array.isArray(r.cats)) banner(STALE_BACKEND_MSG, true);
  } catch (err) {
    banner(err.message, true);
  } finally { setUpdating(false); }
}

async function recordCat(card, categoryId, result, label, btn) {
  if (inFlight) return;
  startWork(btn);
  try {
    const r = await api('record', { categoryId, result });
    if (!r.ok) { cardError(card, r.error || 'Could not save'); return; }
    if (typeof r.wallet === 'number') setWallet(r.wallet);
    const e = r.event;
    if (e.result === 'on_time') banner('🎉 ' + (label || 'Done') + ' — earned ' + money(e.amount) + '.', false);
    else if (e.freezeUsed) banner('❄️ Freeze used — streak protected.', false);
    else banner('Streak reset. Fresh start 💪', false);
    // Awaited inside the try so the in-flight lock outlives the re-render:
    // otherwise a double-tap hits the backend's "already recorded" rejection.
    await showDashboard(true);
  } catch (err) {
    cardError(card, err.message);
  } finally { endWork(btn); }
}

const prettyResult = (r) => (r === 'on_time' ? 'Did it' : 'Missed');

async function amend(card, categoryId, periodKey, result, btn) {
  if (inFlight) return;
  startWork(btn);
  try {
    const r = await api('amend', { categoryId, periodKey, result });
    if (!r.ok) { cardError(card, r.error || 'Could not save'); return; }
    if (r.unchanged) { banner('Already recorded — nothing changed.', false); await showDashboard(true); return; }
    if (typeof r.wallet === 'number') setWallet(r.wallet);
    const n = (r.ripple && r.ripple.entriesChanged) || 0;
    banner('Changed ' + periodLabel(periodKey) + ' to ' + prettyResult(result) +
      (n ? ' — ' + n + ' later ' + (n === 1 ? 'entry' : 'entries') + ' adjusted.' : '.'), false);
    // Awaited inside the try so the in-flight lock outlives the re-render: the
    // buttons must not re-enable against stale card data.
    await showDashboard(true);
  } catch (err) {
    cardError(card, err.message);
  } finally { endWork(btn); }
}

function wireFixPast(card, c, label) {
  const det = card.querySelector('details.more');
  const picker = card.querySelector('.fix-picker');
  const cur = card.querySelector('.fix-current');
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
    cur.textContent = r ? 'Recorded: ' + prettyResult(r) : 'Not recorded yet.';
  };

  det.addEventListener('toggle', async () => {
    if (!det.open || history !== null) return;
    try {
      const r = await api('catHistory', { categoryId: c.id });
      if (!r.ok) { cardError(card, r.error || 'Could not load history'); return; }
      history = {};
      (r.entries || []).forEach((e) => { history[e.periodKey] = e.result; });
      refreshCurrent();
    } catch (err) { cardError(card, err.message); }
  });
  picker.addEventListener('change', refreshCurrent);

  card.querySelectorAll('button[data-fix]').forEach((b) =>
    b.addEventListener('click', () => {
      const key = picker.value;
      const result = b.getAttribute('data-fix');
      cardError(card, '');
      if (!key) { cardError(card, 'Pick a ' + (c.cadence === 'weekly' ? 'week' : 'date') + ' first.'); return; }
      const existing = history && history[key];
      if (existing === result) { cur.textContent = periodLabel(key) + ' is already ' + prettyResult(result) + '.'; return; }
      const go = (btn) => amend(card, c.id, key, result, btn);
      if (existing) {
        askInline(card, 'Change ' + periodLabel(key) + ' from ' + prettyResult(existing) + ' to ' + prettyResult(result) + '? Later entries adjust.',
          'Change it', result === 'missed', go);
        return;
      }
      if (result === 'missed') {
        askInline(card, 'Record a miss for ' + label + ', ' + periodLabel(key) + '? A freeze is used if one was available.',
          'Yes, missed', true, go);
        return;
      }
      go(b);
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
      '<td>' + esc({ biweekly: 'every 2 weeks' }[c.cadence] || c.cadence) + '</td>' +
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
  // Chores are covered by the morning digest, not a per-chore reminder hour.
  $('reminderField').hidden = chore;
  if (!chore && ['biweekly', 'monthly', 'once'].includes($('catCadence').value)) {
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
      if (typeof r.wallet === 'number') setWallet(r.wallet);
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
          reminderTime: '',
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
  // Show the login form before the session check: getSession() refreshes an
  // expired token over the network, and the page should not sit blank meanwhile.
  setView('login');
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
