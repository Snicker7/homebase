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

Deno.serve(async (req) => {
  const cors = corsHeaders(req, env.allowedOrigins);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405, cors);

  const auth = req.headers.get('Authorization') || '';
  const supa = createClient(env.supabaseUrl, env.anonKey, { global: { headers: { Authorization: auth } } });
  const { data, error } = await supa.auth.getUser();
  if (error || !data?.user?.email) {
    return json({ ok: false, error: 'not authorized — please log in again' }, 401, cors);
  }

  let p: Record<string, unknown> = {};
  try { p = await req.json(); } catch { /* empty body is fine */ }
  p.user = data.user.email.toLowerCase();

  try {
    const result = await runAction(sql, (store) =>
      createService({ store, now: () => new Date(), mail, dashboardUrl: env.dashboardUrl, secret: env.checkupSecret }).route(p),
    );
    return json(result, 200, cors);
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    return json({ ok: false, error: msg }, /not authorized/.test(msg) ? 401 : 500, cors);
  }
});
