import postgres from 'postgres';
import { readEnv } from '../_shared/env.js';
import { corsHeaders, json } from '../_shared/cors.js';
import { runAction } from '../_shared/pg.js';
import { createService } from '../_shared/service.js';
import { createResendMailer } from '../_shared/mail.js';

const env = readEnv();
const sql = postgres(env.dbUrl, { max: 2, prepare: false });
const mail = createResendMailer({ apiKey: env.resendKey, from: env.mailFrom, replyTo: env.mailReplyTo });

type Msg = { to: string; subject: string; html: string };

Deno.serve(async (req) => {
  const cors = corsHeaders(req, env.allowedOrigins);
  if ((req.headers.get('Authorization') || '') !== 'Bearer ' + env.dispatchSecret) {
    return json({ ok: false, error: 'forbidden' }, 403, cors);
  }
  // Settlement is journaled inside the transaction, under the advisory lock;
  // mail goes out only after that commits. Sending inside the lock would let a
  // rolled-back commit leave already-sent mail behind, and would hold every
  // other request behind the length of a Resend call.
  const queued: Msg[] = [];
  const queue = { send: async (m: Msg) => { queued.push(m); } };
  const result = await runAction(sql, (store) =>
    createService({ store, now: () => new Date(), mail: queue, dashboardUrl: env.dashboardUrl, secret: env.checkupSecret }).dispatch(),
  );
  for (const m of queued) {
    try {
      await mail.send(m);
    } catch (e) {
      result.failures.push('send to ' + m.to + ' — ' + ((e as Error)?.message || e));
      result.ok = false;
    }
  }
  console.log('dispatch', JSON.stringify(result));
  // 500 on failure so the cron log shows the hour red.
  return json(result, result.ok ? 200 : 500, cors);
});
