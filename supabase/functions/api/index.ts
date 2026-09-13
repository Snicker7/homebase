import postgres from 'postgres';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { readEnv } from '../_shared/env.js';
import { corsHeaders, json } from '../_shared/cors.js';
import { runAction } from '../_shared/pg.js';
import { createService } from '../_shared/service.js';
import { createResendMailer } from '../_shared/mail.js';
import * as bank from '../_shared/bankdb.js';
import { BANK_ACTIONS, validateCategorize, validateCategory } from '../_shared/bankactions.js';
import * as cal from '../_shared/caldb.js';
import { CAL_ACTIONS, validateEvent, validateOccurrence, validateEventCategory, validateId } from '../_shared/calactions.js';
import { importFeed } from '../_shared/officefeed.js';
import { tzDate } from '../_shared/clock.js';

const env = readEnv();
const sql = postgres(env.dbUrl, { max: 2, prepare: false });
const mail = createResendMailer({ apiKey: env.resendKey, from: env.mailFrom, replyTo: env.mailReplyTo });

// Requests served by this isolate so far; 1 means a cold start.
let served = 0;

Deno.serve(async (req) => {
  const cors = corsHeaders(req, env.allowedOrigins);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405, cors);
  served++;
  const t0 = Date.now();
  const marks: Record<string, number> = {};

  // Open the database connection while the auth server validates the token;
  // on a cold isolate the two together are most of the request.
  const warm = sql`select 1`.then(() => {}, () => {});
  const auth = req.headers.get('Authorization') || '';
  const supa = createClient(env.supabaseUrl, env.anonKey, { global: { headers: { Authorization: auth } } });
  const { data, error } = await supa.auth.getUser();
  marks.auth = Date.now();
  if (error || !data?.user?.email) {
    return json({ ok: false, error: 'not authorized — please log in again' }, 401, cors);
  }
  // Wait here rather than let runAction race a second connection open.
  await warm;

  let p: Record<string, unknown> = {};
  try { p = await req.json(); } catch { /* empty body is fine */ }
  // A JSON scalar or array body parses fine but isn't a payload; assigning
  // `user` onto it would throw outside the try.
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = {};
  p.user = data.user.email.toLowerCase();

  // Bank actions carry no reward rule, so they skip the snapshot and the lock.
  if (BANK_ACTIONS.includes(String(p.action))) {
    try {
      if (p.action === 'categorize') {
        const v = validateCategorize(p);
        if ('error' in v) return json({ ok: false, error: v.error }, 400, cors);
        const hit = await bank.categorize(sql, v);
        if (!hit) return json({ ok: false, error: 'unknown transaction' }, 404, cors);
        let rule = null;
        if (v.remember && hit.merchant) {
          await bank.addRule(sql, { pattern: hit.merchant, categoryId: v.categoryId });
          rule = { pattern: hit.merchant, categoryId: v.categoryId };
        }
        return json({ ok: true, rule }, 200, cors);
      }
      const v = validateCategory(p);
      if ('error' in v) return json({ ok: false, error: v.error }, 400, cors);
      await bank.addCategory(sql, v);
      return json({ ok: true, category: v }, 200, cors);
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      // Two failures are the caller's doing rather than ours; say so plainly.
      if (/duplicate key/.test(msg)) return json({ ok: false, error: 'that category already exists' }, 500, cors);
      if (/foreign key/.test(msg)) return json({ ok: false, error: 'unknown category' }, 400, cors);
      return json({ ok: false, error: msg }, 500, cors);
    }
  }

  // Calendar actions carry no reward rule either, so they take the same road as
  // the bank ones: no snapshot, no advisory lock.
  if (CAL_ACTIONS.includes(String(p.action))) {
    try {
      if (p.action === 'eventSave') {
        const v = validateEvent(p);
        if ('error' in v) return json({ ok: false, error: v.error }, 400, cors);
        const id = await cal.saveEvent(sql, Object.assign({}, v, { user: p.user }));
        if (!id) return json({ ok: false, error: 'unknown event' }, 404, cors);
        return json({ ok: true, id }, 200, cors);
      }
      if (p.action === 'eventDelete') {
        const v = validateId(p);
        if ('error' in v) return json({ ok: false, error: v.error }, 400, cors);
        const hit = await cal.deleteEvent(sql, v.id);
        return hit ? json({ ok: true }, 200, cors) : json({ ok: false, error: 'unknown event' }, 404, cors);
      }
      if (p.action === 'occurrenceSkip' || p.action === 'occurrenceSave') {
        // The action decides; a `skipped` field in the payload must not turn an
        // edit into a silent delete.
        const v = validateOccurrence(Object.assign({}, p, { skipped: p.action === 'occurrenceSkip' }));
        if ('error' in v) return json({ ok: false, error: v.error }, 400, cors);
        const hit = await cal.saveOccurrence(sql, v);
        return hit ? json({ ok: true }, 200, cors) : json({ ok: false, error: 'unknown event' }, 404, cors);
      }
      if (p.action === 'calCategorySave') {
        const v = validateEventCategory(p);
        if ('error' in v) return json({ ok: false, error: v.error }, 400, cors);
        await cal.saveCategory(sql, v);
        return json({ ok: true, category: v }, 200, cors);
      }
      if (p.action === 'calCategoryRetire') {
        const v = validateId(p);
        if ('error' in v) return json({ ok: false, error: v.error }, 400, cors);
        const hit = await cal.retireCategory(sql, v.id);
        return hit ? json({ ok: true }, 200, cors) : json({ ok: false, error: 'that category is reserved for the office' }, 400, cors);
      }
      if (p.action === 'officeRefresh') {
        if (!env.keepsiteFeedToken) return json({ ok: false, error: 'the office feed token is not set' }, 400, cors);
        const today = tzDate(new Date());
        const out = await importFeed(sql, { token: env.keepsiteFeedToken, today });
        return json({ ok: out.failures.length === 0, imported: out.imported, error: out.failures[0] }, 200, cors);
      }
      return json({ ok: false, error: 'unknown action' }, 400, cors);
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      if (/foreign key/.test(msg)) return json({ ok: false, error: 'unknown category' }, 400, cors);
      if (/duplicate key/.test(msg)) return json({ ok: false, error: 'that category already exists' }, 400, cors);
      return json({ ok: false, error: msg }, 500, cors);
    }
  }

  try {
    const result = await runAction(sql, (store) =>
      createService({ store, now: () => new Date(), mail, dashboardUrl: env.dashboardUrl, secret: env.checkupSecret }).route(p),
    marks);
    marks.done = Date.now();
    // Phase durations, readable in the browser's Network panel under Server Timing.
    const order = ['auth', 'begin', 'connected', 'locked', 'loaded', 'acted', 'applied', 'done'];
    let prev = t0;
    const timing = order.filter((k) => k in marks).map((k) => { const d = marks[k] - prev; prev = marks[k]; return `${k};dur=${d}`; });
    timing.push(`req${served};dur=${Date.now() - t0}`);
    console.log(`api ${p.action} ${timing.join(' ')}`);
    return json(result, 200, { ...cors, 'Server-Timing': timing.join(', ') });
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    return json({ ok: false, error: msg }, /not authorized/.test(msg) ? 401 : 500, cors);
  }
});
