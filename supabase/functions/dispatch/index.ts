import postgres from 'postgres';
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
  if ((req.headers.get('Authorization') || '') !== 'Bearer ' + env.dispatchSecret) {
    return json({ ok: false, error: 'forbidden' }, 403, cors);
  }
  const result = await runAction(sql, (store) =>
    createService({ store, now: () => new Date(), mail, dashboardUrl: env.dashboardUrl, secret: env.checkupSecret }).dispatch(),
  );
  console.log('dispatch', JSON.stringify(result));
  // 500 on failure so the cron log shows the hour red.
  return json(result, result.ok ? 200 : 500, cors);
});
