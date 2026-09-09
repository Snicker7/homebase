import postgres from 'postgres';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { readEnv } from '../_shared/env.js';
import { corsHeaders, json } from '../_shared/cors.js';
import { createPlaid, PlaidError, itemStatusFor } from '../_shared/plaid.js';
import { planSync, accountRow } from '../_shared/banksync.js';
import * as db from '../_shared/bankdb.js';

const env = readEnv();
const sql = postgres(env.dbUrl, { max: 2, prepare: false });
const plaid = createPlaid({ clientId: env.plaidClientId, secret: env.plaidSecret, env: env.plaidEnv, fetchImpl: fetch });

type Item = { id: string; institution: string; access_token_id: string; cursor: string | null; status: string; linked_by: string };
type ItemResult = { id: string; status: string; added: number; modified: number; removed: number; error: string };
// plaid.js is untyped JS; its call() helper infers an empty-object return, so
// the sync page shape is asserted here rather than edited into the shared module.
type SyncPage = { added: unknown[]; modified: unknown[]; removed: unknown[]; next_cursor: string | null; has_more: boolean };

// Pull every page, apply them as one unit, then refresh balances. Plaid asks
// that the cursor be saved only after a full run, so a mutation mid-pagination
// throws and the next run restarts from the old cursor.
async function syncItem(item: Item): Promise<ItemResult> {
  const out: ItemResult = { id: item.id, status: 'ok', added: 0, modified: 0, removed: 0, error: '' };
  try {
    const token = await db.readAccessToken(sql, item.access_token_id);
    const pages = [];
    let cursor = item.cursor;
    for (let guard = 0; guard < 50; guard++) {
      const page = await plaid.syncPage(token, cursor) as SyncPage;
      pages.push(page);
      cursor = page.next_cursor;
      if (!page.has_more) break;
    }
    const rules = await db.loadRules(sql);
    const plan = planSync(pages, rules);
    const accounts = await plaid.accounts(token);
    await db.upsertAccounts(sql, accounts.map((a: unknown) => accountRow(a, item.id, new Date())));
    await db.applySync(sql, item.id, plan, cursor);
    out.added = plan.inserts.length; out.modified = plan.updates.length; out.removed = plan.removals.length;
  } catch (e) {
    const err = e as PlaidError;
    out.status = err instanceof PlaidError ? itemStatusFor(err) : 'error';
    out.error = err.message || String(e);
    await db.failSync(sql, item.id, out.status, out.error);
  }
  return out;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req, env.allowedOrigins);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405, cors);
  if (!env.plaidClientId || !env.plaidSecret) return json({ ok: false, error: 'Plaid is not configured' }, 500, cors);

  let p: Record<string, unknown> = {};
  try { p = await req.json(); } catch { /* empty body is fine */ }
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = {};
  const action = String(p.action || '');

  // Cron calls sync with the dispatch secret; everything else needs a person.
  const auth = req.headers.get('Authorization') || '';
  let user = '';
  if (auth === 'Bearer ' + env.dispatchSecret) {
    if (action !== 'sync') return json({ ok: false, error: 'forbidden' }, 403, cors);
  } else {
    const supa = createClient(env.supabaseUrl, env.anonKey, { global: { headers: { Authorization: auth } } });
    const { data, error } = await supa.auth.getUser();
    if (error || !data?.user?.email) return json({ ok: false, error: 'not authorized — please log in again' }, 401, cors);
    user = data.user.email.toLowerCase();
  }

  try {
    if (action === 'link_token') {
      let accessToken: string | undefined;
      if (p.itemId) {
        const [item] = await db.listItems(sql, String(p.itemId));
        if (!item) return json({ ok: false, error: 'unknown bank' }, 404, cors);
        accessToken = await db.readAccessToken(sql, item.access_token_id);
      }
      const linkToken = await plaid.linkToken({ userId: user, accessToken });
      return json({ ok: true, linkToken }, 200, cors);
    }
    if (action === 'exchange') {
      if (!p.publicToken) return json({ ok: false, error: 'publicToken required' }, 400, cors);
      const { accessToken, itemId } = await plaid.exchange(String(p.publicToken));
      const vaultId = await db.storeAccessToken(sql, itemId, accessToken);
      await db.insertItem(sql, { id: itemId, institution: String(p.institution || ''), accessTokenId: vaultId, linkedBy: user });
      const [item] = await db.listItems(sql, itemId);
      const r = await syncItem(item as Item);
      return json({ ok: r.status === 'ok', itemId, added: r.added, error: r.error }, 200, cors);
    }
    if (action === 'sync') {
      const items = await db.listItems(sql, p.itemId ? String(p.itemId) : undefined);
      const results: ItemResult[] = [];
      for (const item of items) results.push(await syncItem(item as Item));
      const ok = results.every((r) => r.status === 'ok');
      console.log('plaid sync', JSON.stringify(results.map((r) => ({ id: r.id, status: r.status, added: r.added }))));
      return json({ ok, items: results }, ok ? 200 : 500, cors);
    }
    return json({ ok: false, error: 'unknown action' }, 400, cors);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    return json({ ok: false, error: msg }, 500, cors);
  }
});
