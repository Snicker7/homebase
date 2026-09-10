// The transactions inbox: everything Plaid brought in that nobody has
// categorized yet. One tap files a row; "remember" turns the merchant into a rule.
import { sb, api } from './api.js';
import { $, esc, money, banner } from './util.js';

let CATS = [];
let ACCOUNTS = {};

const dateLabel = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
  if (!m) return d || '';
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1] + ' ' + Number(m[3]);
};
// Plaid's detailed category reads like GENERAL_MERCHANDISE_SUPERSTORES.
const hint = (c) => (c ? c.toLowerCase().replace(/_/g, ' ') : '');

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

export async function renderInbox() {
  const list = $('inboxList');
  list.innerHTML = '<p class="muted">Loading…</p>';
  try {
    await Promise.all([loadCategories(), loadAccounts()]);
    const { data, error } = await sb.from('transactions')
      .select('id,date,amount,merchant,pending,plaid_category,account_id')
      .is('category_id', null).is('removed_at', null)
      .order('date', { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    list.innerHTML = '';
    $('inboxEmpty').hidden = data.length > 0;
    data.forEach((t) => list.appendChild(row(t)));
    await refreshInboxCount();
  } catch (err) {
    list.innerHTML = '';
    banner(err.message, true);
  }
}

function row(t) {
  const el = document.createElement('div');
  el.className = 'tx';
  const acct = ACCOUNTS[t.account_id];
  el.innerHTML =
    '<div class="tx-head">' +
    '<div class="tx-main"><span class="tx-merchant">' + esc(t.merchant || '(no merchant)') + '</span>' +
    '<span class="tx-sub">' + esc(dateLabel(t.date)) + (acct ? ' · ' + esc(acct.name) + (acct.mask ? ' ' + esc(acct.mask) : '') : '') +
    (t.pending ? ' · pending' : '') + '</span></div>' +
    '<span class="tx-amt ' + (t.amount < 0 ? 'plus' : '') + '">' + (t.amount < 0 ? '+' : '') + money(Math.abs(t.amount)) + '</span>' +
    '</div>' +
    (t.plaid_category ? '<p class="tx-hint">Plaid says: ' + esc(hint(t.plaid_category)) + '</p>' : '') +
    '<div class="chips">' +
    CATS.map((c) => '<button class="chip" data-cat="' + esc(c.id) + '">' + esc(c.emoji ? c.emoji + ' ' : '') + esc(c.name) + '</button>').join('') +
    '<button class="chip chip-new" data-new>＋ New</button>' +
    '</div>' +
    '<label class="check"><input type="checkbox" data-remember /> Remember this merchant</label>' +
    '<div class="new-cat" hidden><input type="text" data-new-name placeholder="Category name" maxlength="40" />' +
    '<button data-new-save>Add</button></div>' +
    '<p class="inline-err" hidden></p>';
  const err = (m) => { const e = el.querySelector('.inline-err'); e.textContent = m; e.hidden = !m; };

  el.querySelectorAll('button[data-cat]').forEach((b) => b.addEventListener('click', async () => {
    b.classList.add('is-loading');
    el.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    try {
      const r = await api('categorize', { id: t.id, categoryId: b.getAttribute('data-cat'), remember: el.querySelector('[data-remember]').checked });
      if (!r.ok) { err(r.error); return; }
      el.classList.add('tx-done');
      setTimeout(() => { el.remove(); if (!$('inboxList').children.length) $('inboxEmpty').hidden = false; }, 250);
      await refreshInboxCount();
      if (r.rule) banner('Filed, and "' + r.rule.pattern + '" will file itself next time.', false);
    } catch (e) { err(e.message); } finally {
      b.classList.remove('is-loading');
      el.querySelectorAll('button').forEach((x) => { x.disabled = false; });
    }
  }));

  el.querySelector('[data-new]').addEventListener('click', () => {
    const box = el.querySelector('.new-cat');
    box.hidden = !box.hidden;
    if (!box.hidden) box.querySelector('input').focus();
  });
  el.querySelector('[data-new-save]').addEventListener('click', async () => {
    const name = el.querySelector('[data-new-name]').value.trim();
    if (!name) { err('Give the category a name.'); return; }
    try {
      const r = await api('addBudgetCategory', { name });
      if (!r.ok) { err(r.error); return; }
      await loadCategories();
      // Re-render every row so the new chip appears everywhere.
      await renderInbox();
    } catch (e) { err(e.message); }
  });
  return el;
}
