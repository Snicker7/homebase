import postgres from 'postgres';
import { readEnv } from '../_shared/env.js';
import { corsHeaders, json } from '../_shared/cors.js';
import { runAction } from '../_shared/pg.js';
import { createService } from '../_shared/service.js';
import { verifyToken } from '../_shared/token.js';
import { createResendMailer } from '../_shared/mail.js';

const env = readEnv();
const sql = postgres(env.dbUrl, { max: 2, prepare: false });
const mail = createResendMailer({ apiKey: env.resendKey, from: env.mailFrom, replyTo: env.mailReplyTo });

Deno.serve(async (req) => {
  const cors = corsHeaders(req, env.allowedOrigins);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405, cors);
  let body: { t?: string } = {};
  try { body = await req.json(); } catch { /* fallthrough */ }
  const payload = await verifyToken(body.t, env.checkupSecret, Date.now());
  if (!payload) return json({ ok: false, error: 'this link has expired — open the dashboard instead' }, 200, cors);
  try {
    const result = await runAction(sql, (store) =>
      createService({ store, now: () => new Date(), mail, dashboardUrl: env.dashboardUrl, secret: env.checkupSecret }).checkup(payload),
    );
    return json(result, 200, cors);
  } catch (err) {
    return json({ ok: false, error: String((err as Error)?.message || err) }, 500, cors);
  }
});
