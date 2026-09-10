// The transactions inbox. "To sort" lists what Plaid brought in that nobody
// has categorized; "Filed" lists what has been, so a wrong guess or a category
// invented later can be reassigned. Filing goes through the api function;
// "remember" turns the merchant into a rule for future syncs.
import { sb, api } from './api.js';
import { $, esc, money, banner } from './util.js';

let CATS = [];
let ACCOUNTS = {};
let MODE = 'unfiled'; // 'unfiled' | 'filed'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateLabel = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
  return m ? MONTHS[+m[2] - 1] + ' ' + Number(m[3]) : (d || '');
};
// Plaid's detailed category reads like GENERAL_MERCHANDISE_SUPERSTORES.
const hint = (c) => (c ? c.toLowerCase().replace(/_/g, ' ') : '');
const catById = (id) => CATS.find((c) => c.id === id);
const catLabel = (c) => (c.emoji ? c.emoji + ' ' : '') + c.name;

async function loadCategories() {
  const { data, error } = await sb.from('budget_categories').select('id,name,emoji,kind').order('name');
  if (error) throw new Error(error.message);
  CATS = data;
}

async function loadAccounts() {
  const { data } = await sb.from('accounts').select('id,name,mask');
  ACCOUNTS = Object.fromEntries((data || []).map((a) => [a.id, a]));
}

export async function refreshInboxCount() {
  if (!sb) return;
  const { count } = await sb.from('transactions').select('id', { count: 'exact', head: true }).is('category_id', null).is('removed_at', null);
  const pill = $('inboxCount');
  pill.textContent = count || '';
  pill.hidden = !count;
}

/* ── the category picker ─────────────────────────────────────────────────── */
// A searchable panel rather than a native select: the list keeps growing, and
// a phone renders a select as an OS wheel that cannot be typed into. One panel
// element moves to whichever row is open, so a hundred rows cost one panel.
const GROUPS = [
  { kind: 'spend', label: 'Spending' },
  { kind: 'income', label: 'Income' },
  { kind: 'wallet', label: 'Wallets' },
  { kind: 'transfer', label: 'Transfers' },
];

let panel = null;
let openRow = null; // { el, tx, field, busy }

function buildPanel() {
  panel = document.createElement('div');
  panel.className = 'cat-panel';
  panel.hidden = true;
  panel.innerHTML =
    '<input type="search" class="cat-search" placeholder="Search categories…" autocomplete="off" />' +
    '<div class="cat-results"></div>';
  const search = panel.querySelector('.cat-search');
  search.addEventListener('input', () => renderResults());
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); closePicker(); return; }
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    // Enter takes the top match, or creates what was typed when nothing matches.
    const first = panel.querySelector('.cat-results button');
    if (first) first.click();
  });
  $('inboxView').appendChild(panel);
}

const matches = (query) => {
  const q = query.trim().toLowerCase();
  return q ? CATS.filter((c) => c.name.toLowerCase().includes(q)) : CATS;
};

function renderResults() {
  const query = panel.querySelector('.cat-search').value;
  const found = matches(query);
  const box = panel.querySelector('.cat-results');
  if (!found.length) {
    const name = query.trim();
    box.innerHTML = '<p class="cat-none">No category matches.</p>' +
      (name
        ? '<div class="row cat-create"><button type="button" data-create>＋ Create "' + esc(name) + '"</button>' +
          '<select data-kind><option value="spend">Spending</option><option value="income">Income</option></select></div>'
        : '');
    const make = box.querySelector('[data-create]');
    if (make) make.addEventListener('click', () => createAndFile(name, box.querySelector('[data-kind]').value));
    return;
  }
  // Grouped while browsing; a flat ranked list once a query narrows it.
  box.innerHTML = query.trim()
    ? found.map(resultBtn).join('')
    : GROUPS.map((g) => {
      const list = found.filter((c) => c.kind === g.kind);
      return list.length ? '<p class="cat-group">' + esc(g.label) + '</p>' + list.map(resultBtn).join('') : '';
    }).join('');
  box.querySelectorAll('button[data-pick]').forEach((b) =>
    b.addEventListener('click', () => file(b.getAttribute('data-pick'))));
}

function resultBtn(c) {
  const on = openRow && openRow.tx.category_id === c.id;
  return '<button type="button" data-pick="' + esc(c.id) + '"' + (on ? ' class="cat-on"' : '') + '>' +
    esc(catLabel(c)) + (on ? ' ✓' : '') + '</button>';
}

function openPicker(ctx) {
  if (!panel) buildPanel();
  if (openRow && openRow.el === ctx.el) { closePicker(); return; }
  openRow = ctx;
  ctx.el.querySelector('.tx-pick').appendChild(panel);
  panel.hidden = false;
  ctx.field.setAttribute('aria-expanded', 'true');
  panel.querySelector('.cat-search').value = '';
  renderResults();
  panel.querySelector('.cat-search').focus({ preventScroll: true });
}

// The panel always returns to the view before hiding: a filed row gets removed
// from the page, and the panel must not go with it.
function closePicker() {
  if (!panel) return;
  panel.hidden = true;
  if (openRow) openRow.field.setAttribute('aria-expanded', 'false');
  $('inboxView').appendChild(panel);
  openRow = null;
}

document.addEventListener('click', (ev) => {
  if (!openRow || !panel || panel.hidden) return;
  if (panel.contains(ev.target) || openRow.field.contains(ev.target)) return;
  closePicker();
});

/* ── filing ──────────────────────────────────────────────────────────────── */
async function file(categoryId) {
  const ctx = openRow;
  if (!ctx) return;
  const { el, tx, field } = ctx;
  const err = (m) => { const e = el.querySelector('.inline-err'); e.textContent = m; e.hidden = !m; };
  err('');
  closePicker();
  field.disabled = true;
  try {
    const r = await api('categorize', { id: tx.id, categoryId, remember: el.querySelector('[data-remember]').checked });
    if (!r.ok) { err(r.error); return; }
    await refreshInboxCount();
    if (r.rule) banner('Filed, and "' + r.rule.pattern + '" will file itself next time.', false);
    if (MODE === 'filed') {
      // Reassignment: the row stays put so the change is visible.
      tx.category_id = categoryId;
      field.textContent = fieldLabel(tx);
      const n = el.querySelector('.tx-note');
      n.textContent = 'Moved.';
      n.hidden = false;
    } else {
      el.classList.add('tx-done');
      setTimeout(() => {
        el.remove();
        if (!$('inboxList').children.length) $('inboxEmpty').hidden = false;
      }, 250);
    }
  } catch (e) { err(e.message); } finally { field.disabled = false; }
}

async function createAndFile(name, kind) {
  const ctx = openRow;
  if (!ctx) return;
  const err = (m) => { const e = ctx.el.querySelector('.inline-err'); e.textContent = m; e.hidden = !m; };
  try {
    const r = await api('addBudgetCategory', { name, kind });
    if (!r.ok) { err(r.error); closePicker(); return; }
    await loadCategories();
    await file(r.category.id);
  } catch (e) { err(e.message); closePicker(); }
}

/* ── rendering ───────────────────────────────────────────────────────────── */
const fieldLabel = (tx) => {
  const c = tx.category_id && catById(tx.category_id);
  return c ? catLabel(c) : 'Choose a category…';
};

export async function renderInbox() {
  const list = $('inboxList');
  closePicker();
  list.innerHTML = '<p class="muted">Loading…</p>';
  $('inboxTabNew').className = MODE === 'unfiled' ? 'seg-on' : 'ghost';
  $('inboxTabFiled').className = MODE === 'filed' ? 'seg-on' : 'ghost';
  try {
    await Promise.all([loadCategories(), loadAccounts()]);
    let q = sb.from('transactions')
      .select('id,date,amount,merchant,pending,plaid_category,account_id,category_id')
      .is('removed_at', null)
      .order('date', { ascending: false }).limit(100);
    q = MODE === 'filed' ? q.not('category_id', 'is', null) : q.is('category_id', null);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    list.innerHTML = '';
    const empty = $('inboxEmpty');
    empty.hidden = data.length > 0;
    empty.textContent = MODE === 'filed' ? 'Nothing filed yet.' : 'Nothing to sort. 🎉';
    data.forEach((t) => list.appendChild(row(t)));
    if ($('inboxSearch').value.trim()) applyMerchantFilter();
    await refreshInboxCount();
  } catch (err) {
    list.innerHTML = '';
    banner(err.message, true);
  }
}

function row(tx) {
  const el = document.createElement('div');
  el.className = 'tx';
  el.dataset.merchant = String(tx.merchant || '').toLowerCase();
  const acct = ACCOUNTS[tx.account_id];
  el.innerHTML =
    '<div class="tx-head">' +
    '<div class="tx-main"><span class="tx-merchant">' + esc(tx.merchant || '(no merchant)') + '</span>' +
    '<span class="tx-sub">' + esc(dateLabel(tx.date)) + (acct ? ' · ' + esc(acct.name) + (acct.mask ? ' ' + esc(acct.mask) : '') : '') +
    (tx.pending ? ' · pending' : '') + '</span></div>' +
    '<span class="tx-amt ' + (tx.amount < 0 ? 'plus' : '') + '">' + (tx.amount < 0 ? '+' : '') + money(Math.abs(tx.amount)) + '</span>' +
    '</div>' +
    (tx.plaid_category && !tx.category_id ? '<p class="tx-hint">Plaid says: ' + esc(hint(tx.plaid_category)) + '</p>' : '') +
    '<div class="tx-pick"><button type="button" class="cat-field" aria-expanded="false"></button></div>' +
    '<label class="check"><input type="checkbox" data-remember /> Remember this merchant</label>' +
    '<p class="tx-note" hidden></p>' +
    '<p class="inline-err" hidden></p>';
  const field = el.querySelector('.cat-field');
  field.textContent = fieldLabel(tx);
  field.addEventListener('click', () => openPicker({ el, tx, field }));
  return el;
}

// Hiding rows beats refetching: the query is capped at 100 and the whole set
// is already in the page.
function applyMerchantFilter() {
  const q = $('inboxSearch').value.trim().toLowerCase();
  const rows = [...$('inboxList').children];
  if (!rows.length) return;
  // A hidden row would take the open picker with it.
  closePicker();
  let shown = 0;
  rows.forEach((el) => {
    const hit = !q || (el.dataset.merchant || '').includes(q);
    el.hidden = !hit;
    if (hit) shown++;
  });
  const empty = $('inboxEmpty');
  empty.hidden = shown > 0;
  if (!shown) empty.textContent = 'No merchant matches "' + q + '".';
}

let tabsWired = false;
export function wireInboxTabs() {
  if (tabsWired) return;
  tabsWired = true;
  const go = (mode) => { MODE = mode; $('inboxSearch').value = ''; renderInbox(); };
  $('inboxTabNew').addEventListener('click', () => go('unfiled'));
  $('inboxTabFiled').addEventListener('click', () => go('filed'));
  $('inboxSearch').addEventListener('input', applyMerchantFilter);
}
