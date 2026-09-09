import postgres from 'postgres';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { readEnv } from '../_shared/env.js';
import { corsHeaders, json } from '../_shared/cors.js';
import { runAction } from '../_shared/pg.js';
import { createService } from '../_shared/service.js';
import { createResendMailer } from '../_shared/mail.js';

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
