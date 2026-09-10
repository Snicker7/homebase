// Linked banks: status per institution, balances per account, and the three
// actions that talk to Plaid — link, fix a broken login, sync now.
import { sb, bank } from './api.js';
import { $, esc, money, banner } from './util.js';

const LINK_JS = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
let linkLoaded = null;
function loadLink() {
  if (window.Plaid) return Promise.resolve();
  if (!linkLoaded) {
    linkLoaded = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LINK_JS;
      s.onload = resolve;
      s.onerror = () => { linkLoaded = null; reject(new Error('Could not load Plaid Link')); };
      document.head.appendChild(s);
    });
  }
  return linkLoaded;
}

// Plaid reports a credit card or loan balance as the amount owed, a positive
// number, so those accounts count against the total rather than toward it.
const LIABILITY = new Set(['credit', 'loan']);
const isDebt = (a) => LIABILITY.has(String(a.type || '').toLowerCase());
// What this account contributes to net worth.
const signed = (a) => (a.current_balance == null ? 0 : (isDebt(a) ? -1 : 1) * Number(a.current_balance));

const msg = (text, isError) => { const m = $('bankMsg'); m.textContent = text; m.hidden = !text; m.style.color = isError ? 'var(--danger)' : ''; };
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never');

// keepMsg leaves #bankMsg alone: a sync or a fresh link writes its result and
// then re-renders, and the render must not wipe what it just said.
export async function renderAccounts(keepMsg) {
  const list = $('bankList');
  list.innerHTML = '<p class="muted">Loading…</p>';
  if (!keepMsg) msg('');
  try {
    const [items, accounts] = await Promise.all([
      sb.from('bank_items').select('id,institution,status,error,last_synced_at').order('institution'),
      sb.from('accounts').select('id,item_id,name,type,subtype,mask,current_balance,balance_as_of').order('name'),
    ]);
    if (items.error) throw new Error(items.error.message);
    if (accounts.error) throw new Error(accounts.error.message);
    list.innerHTML = '';
    if (!items.data.length) list.innerHTML = '<p class="muted">No banks linked yet.</p>';
    items.data.forEach((it) => list.appendChild(itemCard(it, accounts.data.filter((a) => a.item_id === it.id))));
    if (accounts.data.length) list.appendChild(totals(accounts.data));
  } catch (err) {
    list.innerHTML = '';
    banner(err.message, true);
  }
  wireButtons();
}

// Cash, owed, and net. The breakdown only appears when something is owed,
// so a cash-only setup keeps the single line it had.
function totals(accounts) {
  const cash = accounts.filter((a) => !isDebt(a)).reduce((s, a) => s + signed(a), 0);
  const owed = accounts.filter(isDebt).reduce((s, a) => s + Number(a.current_balance || 0), 0);
  const p = document.createElement('p');
  p.className = 'bank-total';
  p.innerHTML = owed > 0
    ? '<span>Cash <b>' + money(cash) + '</b></span>' +
      '<span>Owed <b class="owed">' + money(-owed) + '</b></span>' +
      '<span>Net <b>' + money(cash - owed) + '</b></span>'
    : '<span>Net across accounts <b>' + money(cash) + '</b></span>';
  return p;
}

function itemCard(it, accounts) {
  const el = document.createElement('div');
  el.className = 'bank';
  const status = it.status === 'ok' ? '' :
    '<p class="bank-status">' + (it.status === 'login_required'
      ? '⚠️ Needs a fresh login. <button class="link-btn" data-fix="' + esc(it.id) + '">Fix login</button>'
      : '⚠️ Last sync failed: ' + esc(it.error || 'unknown error')) + '</p>';
  el.innerHTML =
    '<div class="bank-head"><b>' + esc(it.institution || 'Bank') + '</b><span class="muted">synced ' + esc(when(it.last_synced_at)) + '</span></div>' +
    status +
    accounts.map((a) =>
      '<div class="acct"><span>' + esc(a.name) + (a.mask ? ' <span class="muted">' + esc(a.mask) + '</span>' : '') + '</span>' +
      '<span class="acct-bal' + (isDebt(a) ? ' owed' : '') + '">' +
      (a.current_balance == null ? '—' : money(signed(a))) + '</span></div>').join('');
  return el;
}

// One Link session at a time. Two open handlers can each create an item, and
// the Trial plan allows ten for the account's lifetime.
let opening = false;

// Opens Plaid Link with a token from the function; update mode when itemId is given.
async function openLink(itemId) {
  if (opening) return;
  opening = true;
  msg('Opening Plaid…');
  try {
    await loadLink();
    const r = await bank('link_token', itemId ? { itemId } : {});
    if (!r.ok) { opening = false; msg(r.error, true); return; }
    const handler = window.Plaid.create({
      token: r.linkToken,
      onSuccess: async (publicToken, metadata) => {
        opening = false;
        const ins = (metadata && metadata.institution) || {};
        if (itemId) { msg('Login updated. Syncing…'); await syncNow(itemId); return; }
        msg('Linking…');
        const ex = await bank('exchange', { publicToken, institution: ins.name || '', institutionId: ins.institution_id || '' });
        // The item exists at Plaid the moment Link succeeds, so show it either
        // way; only the first sync failed.
        msg(ex.ok ? 'Linked. ' + ex.added + ' transactions pulled in.'
          : 'Linked, but the first sync failed — use Sync now.', !ex.ok);
        await renderAccounts(true);
      },
      onExit: (err) => {
        opening = false;
        if (err) msg(err.display_message || err.error_message || 'Plaid closed', true); else msg('');
      },
    });
    handler.open();
  } catch (e) { opening = false; msg(e.message, true); }
}

async function syncNow(itemId) {
  const btn = $('syncNowBtn');
  btn.classList.add('is-loading');
  try {
    const r = await bank('sync', itemId ? { itemId } : {});
    const added = (r.items || []).reduce((s, i) => s + (i.added || 0), 0);
    msg(r.ok ? 'Synced. ' + added + ' new transaction' + (added === 1 ? '' : 's') + '.' : 'Sync had trouble — see each bank below.', !r.ok);
    await renderAccounts(true);
  } catch (e) { msg(e.message, true); } finally { btn.classList.remove('is-loading'); }
}

let wired = false;
function wireButtons() {
  if (!wired) {
    wired = true;
    $('linkBankBtn').addEventListener('click', () => openLink(null));
    $('syncNowBtn').addEventListener('click', () => syncNow(null));
  }
  $('bankList').querySelectorAll('[data-fix]').forEach((b) => b.addEventListener('click', () => openLink(b.getAttribute('data-fix'))));
}
