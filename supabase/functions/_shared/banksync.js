// Pure planning for a transactions sync: Plaid pages in, row lists out.
// Nothing here touches the network or the database.

/** First rule whose pattern appears in the merchant, lowest priority number first. */
export function matchRule(merchant, rules) {
  const m = String(merchant || '').toLowerCase();
  if (!m) return null;
  const sorted = [...rules].sort((a, b) => (a.priority - b.priority) || (a.id - b.id));
  for (const r of sorted) {
    const p = String(r.pattern || '').toLowerCase();
    if (p && m.includes(p)) return r.category_id;
  }
  return null;
}

/** The columns a sync is allowed to write for a transaction. Never category_id or note. */
export function txnRow(t) {
  const pfc = t.personal_finance_category;
  // An amount that is not a number would land in the ledger as a wrong total.
  // Throw instead: the sync run's catch marks the item `error` and nothing applies.
  const amount = Number(t.amount);
  if (!Number.isFinite(amount)) throw new Error('transaction ' + t.transaction_id + ' has a non-numeric amount');
  return {
    id: t.transaction_id,
    account_id: t.account_id,
    date: t.date,
    amount,
    merchant: t.merchant_name || t.name || '',
    pending: t.pending === true,
    plaid_category: pfc && pfc.detailed ? pfc.detailed : null,
  };
}

export function accountRow(a, itemId, asOf) {
  const cur = a.balances && typeof a.balances.current === 'number' ? a.balances.current : null;
  return {
    id: a.account_id,
    item_id: itemId,
    name: a.name || a.official_name || '',
    type: a.type || '',
    subtype: a.subtype || '',
    mask: a.mask || '',
    current_balance: cur,
    balance_as_of: asOf,
  };
}

export function planSync(pages, rules) {
  const inserts = [];
  const updates = [];
  const removals = [];
  for (const page of pages) {
    for (const t of page.added || []) {
      const row = txnRow(t);
      const cat = matchRule(row.merchant, rules);
      inserts.push({ ...row, category_id: cat, categorized_by: cat ? 'rule' : null });
    }
    for (const t of page.modified || []) updates.push(txnRow(t));
    for (const r of page.removed || []) removals.push(r.transaction_id);
  }
  return { inserts, updates, removals };
}
