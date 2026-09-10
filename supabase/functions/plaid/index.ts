import postgres from 'postgres';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { readEnv } from '../_shared/env.js';
import { corsHeaders, json } from '../_shared/cors.js';
import { createPlaid } from '../_shared/plaid.js';
import { makeSyncItem } from '../_shared/banksyncrun.js';
import * as db from '../_shared/bankdb.js';

const env = readEnv();
const sql = postgres(env.dbUrl, { max: 2, prepare: false });
const plaid = createPlaid({ clientId: env.plaidClientId, secret: env.plaidSecret, env: env.plaidEnv, fetchImpl: fetch });

type Item = { id: string; institution: string; access_token_id: string; cursor: string | null; status: string; linked_by: string };
type ItemResult = { id: string; status: string; added: number; modified: number; removed: number; error: string };

const syncItem = makeSyncItem({ sql, plaid, db, now: () => new Date() });

Deno.serve(async (req) => {
  const cors = corsHeaders(req, env.allowedOrigins);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405, cors);

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

  // Checked after auth so an unconfigured deployment cannot be probed anonymously.
  if (!env.plaidClientId || !env.plaidSecret) return json({ ok: false, error: 'Plaid is not configured' }, 500, cors);

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
      // The Trial plan allows ten items for the account's lifetime, so a second
      // link to a bank already here is refused before Plaid is ever called.
      const institutionId = String(p.institutionId || '');
      if (institutionId && await db.findItemByInstitution(sql, institutionId)) {
        return json({ ok: false, error: 'already linked — use Fix login on the Banks screen' }, 409, cors);
      }
      const { accessToken, itemId } = await plaid.exchange(String(p.publicToken));
      const vaultId = await db.storeAccessToken(sql, itemId, accessToken);
      const supersededId = await db.insertItem(sql, {
        id: itemId, institution: String(p.institution || ''), institutionId, accessTokenId: vaultId, linkedBy: user,
      });
      // Re-linking the same item leaves its old secret in Vault, still valid to
      // anyone who reads the table; drop it.
      if (supersededId) await db.deleteAccessToken(sql, supersededId);
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
