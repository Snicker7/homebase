import postgres from 'postgres';
import { readEnv } from '../_shared/env.js';
import { corsHeaders, json } from '../_shared/cors.js';
import { runAction } from '../_shared/pg.js';
import { createService } from '../_shared/service.js';
import { createResendMailer } from '../_shared/mail.js';
import { importFeed } from '../_shared/officefeed.js';
import { tzDate, tzHourStr } from '../_shared/clock.js';
import { gatherDigest, digestDays, renderDigest } from '../_shared/caldigest.js';

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
  // The office import is independent of the habits dispatch: a feed that is
  // down must not cost the hour its reminders.
  if (env.keepsiteFeedToken) {
    // A database hiccup during the import must not swallow the failures the
    // mail loop already recorded in `result`.
    try {
      const today = tzDate(new Date());
      const office = await importFeed(sql, { token: env.keepsiteFeedToken, today });
      for (const f of office.failures) { result.failures.push(f); result.ok = false; }
      console.log('office import', JSON.stringify({ imported: office.imported, failures: office.failures.length }));
    } catch (e) {
      result.failures.push('office import — ' + ((e as Error)?.message || e));
      result.ok = false;
    }
  }
  // The calendar digest reads tables the habits snapshot does not carry, so it
  // runs here rather than inside the service.
  const hour = tzHourStr(new Date());
  const [digestSetting] = await sql`select value #>> '{}' as v from settings where key = 'calendarDigestTime'`;
  if ((digestSetting?.v || '07:00') === hour) {
    try {
      const today = tzDate(new Date());
      const items = await gatherDigest(sql, today);
      const cats = Object.fromEntries(
        (await sql`select id, color from event_categories`).map((c) => [c.id, { color: c.color }]),
      );
      const mail0 = renderDigest(digestDays(items, today), cats, env.dashboardUrl);
      if (mail0) {
        for (const p of await sql`select email from people order by email`) {
          try {
            await mail.send({ to: p.email, subject: mail0.subject, html: mail0.html });
          } catch (e) {
            result.failures.push('calendar digest to ' + p.email + ' — ' + ((e as Error)?.message || e));
            result.ok = false;
          }
        }
      }
    } catch (e) {
      result.failures.push('calendar digest — ' + ((e as Error)?.message || e));
      result.ok = false;
    }
  }
  console.log('dispatch', JSON.stringify(result));
  // 500 on failure so the cron log shows the hour red.
  return json(result, result.ok ? 200 : 500, cors);
});
