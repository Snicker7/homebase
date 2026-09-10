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
// One select beats a chip per category: the list keeps growing, and a row of
// forty buttons is unusable on a phone.
const GROUPS = [
  { kind: 'spend', label: 'Spending' },
  { kind: 'income', label: 'Income' },
  { kind: 'wallet', label: 'Wallets' },
  { kind: 'transfer', label: 'Transfers' },
];
const NEW_VALUE = '__new';

function pickerOptions(selected) {
  let html = '<option value="">Choose a category…</option>';
  GROUPS.forEach((g) => {
    const list = CATS.filter((c) => c.kind === g.kind);
    if (!list.length) return;
    html += '<optgroup label="' + esc(g.label) + '">' +
      list.map((c) => '<option value="' + esc(c.id) + '"' + (c.id === selected ? ' selected' : '') + '>' +
        esc((c.emoji ? c.emoji + ' ' : '') + c.name) + '</option>').join('') +
      '</optgroup>';
  });
  return html + '<option value="' + NEW_VALUE + '">＋ New category…</option>';
}

// Adding a category must not throw away what every other row has selected.
function refreshAllPickers() {
  $('inboxList').querySelectorAll('select.tx-cat').forEach((sel) => {
    const keep = sel.value === NEW_VALUE ? '' : sel.value;
    sel.innerHTML = pickerOptions(keep);
    sel.value = keep;
  });
}

/* ── rendering ───────────────────────────────────────────────────────────── */
export async function renderInbox() {
  const list = $('inboxList');
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
    (t.plaid_category && !t.category_id ? '<p class="tx-hint">Plaid says: ' + esc(hint(t.plaid_category)) + '</p>' : '') +
    '<div class="row tx-pick"><select class="tx-cat">' + pickerOptions(t.category_id) + '</select></div>' +
    '<label class="check"><input type="checkbox" data-remember /> Remember this merchant</label>' +
    '<div class="new-cat" hidden>' +
    '<input type="text" data-new-name placeholder="Category name" maxlength="40" />' +
    '<select data-new-kind><option value="spend">Spending</option><option value="income">Income</option></select>' +
    '<button type="button" data-new-save>Add</button></div>' +
    '<p class="tx-note" hidden></p>' +
    '<p class="inline-err" hidden></p>';

  const err = (m) => { const e = el.querySelector('.inline-err'); e.textContent = m; e.hidden = !m; };
  const note = (m) => { const n = el.querySelector('.tx-note'); n.textContent = m; n.hidden = !m; };
  const sel = el.querySelector('select.tx-cat');
  const box = el.querySelector('.new-cat');
  const busy = (on) => el.querySelectorAll('select, button, input').forEach((x) => { x.disabled = on; });

  sel.addEventListener('change', async () => {
    err('');
    if (sel.value === NEW_VALUE) {
      box.hidden = false;
      box.querySelector('input').focus();
      return;
    }
    box.hidden = true;
    if (!sel.value) return;
    busy(true);
    try {
      const r = await api('categorize', { id: t.id, categoryId: sel.value, remember: el.querySelector('[data-remember]').checked });
      if (!r.ok) { err(r.error); return; }
      await refreshInboxCount();
      if (r.rule) banner('Filed, and "' + r.rule.pattern + '" will file itself next time.', false);
      if (MODE === 'filed') {
        // Reassignment: the row stays put so the change is visible.
        t.category_id = sel.value;
        note('Moved.');
      } else {
        el.classList.add('tx-done');
        setTimeout(() => {
          el.remove();
          if (!$('inboxList').children.length) $('inboxEmpty').hidden = false;
        }, 250);
      }
    } catch (e) { err(e.message); } finally { busy(false); }
  });

  el.querySelector('[data-new-save]').addEventListener('click', async () => {
    const name = el.querySelector('[data-new-name]').value.trim();
    const kind = el.querySelector('[data-new-kind]').value;
    if (!name) { err('Give the category a name.'); return; }
    busy(true);
    try {
      const r = await api('addBudgetCategory', { name, kind });
      if (!r.ok) { err(r.error); return; }
      await loadCategories();
      refreshAllPickers();
      box.hidden = true;
      el.querySelector('[data-new-name]').value = '';
      // Select what was just created so one more tap is not needed.
      sel.value = r.category.id;
      sel.dispatchEvent(new Event('change'));
    } catch (e) { err(e.message); } finally { busy(false); }
  });
  return el;
}

let tabsWired = false;
export function wireInboxTabs() {
  if (tabsWired) return;
  tabsWired = true;
  const go = (mode) => { MODE = mode; renderInbox(); };
  $('inboxTabNew').addEventListener('click', () => go('unfiled'));
  $('inboxTabFiled').addEventListener('click', () => go('filed'));
}
