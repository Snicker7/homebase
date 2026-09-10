// One item's whole sync run, wired from injected parts so it can be exercised
// under Node with a fake Plaid and a fake database. The plaid function owns the
// real wiring; this file owns the order of operations.
import { planSync, accountRow } from './banksync.js';
import { PlaidError, itemStatusFor } from './plaid.js';

// Plaid pages 500 rows at a time. A cursor that never stops advancing is a bug
// on either side; stop rather than loop forever.
const MAX_PAGES = 50;

export function makeSyncItem({ sql, plaid, db, now = () => new Date() }) {
  // Pull every page, refresh balances, then apply rows and cursor as one unit.
  // Plaid asks that the cursor be saved only after a full run, so a failure
  // mid-pagination leaves the next run restarting from the old cursor.
  return async function syncItem(item) {
    const out = { id: item.id, status: 'ok', added: 0, modified: 0, removed: 0, error: '' };
    try {
      const token = await db.readAccessToken(sql, item.access_token_id);
      const pages = [];
      let cursor = item.cursor;
      for (let guard = 0; guard < MAX_PAGES; guard++) {
        const page = await plaid.syncPage(token, cursor);
        pages.push(page);
        cursor = page.next_cursor;
        if (!page.has_more) break;
      }
      const rules = await db.loadRules(sql);
      const plan = planSync(pages, rules);
      // transactions.account_id references accounts, so a fresh link would
      // otherwise fail its first sync: balances land before rows.
      const accounts = await plaid.accounts(token);
      await db.upsertAccounts(sql, accounts.map((a) => accountRow(a, item.id, now())));
      await db.applySync(sql, item.id, plan, cursor);
      out.added = plan.inserts.length;
      out.modified = plan.updates.length;
      out.removed = plan.removals.length;
    } catch (e) {
      out.status = e instanceof PlaidError ? itemStatusFor(e) : 'error';
      out.error = (e && e.message) || String(e);
      await db.failSync(sql, item.id, out.status, out.error);
    }
    return out;
  };
}
