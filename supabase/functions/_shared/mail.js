// supabase/functions/_shared/mail.js
// Outbound mail through Resend. Apps Script's MailApp is gone; the edge
// function wires one of these into the service context as ctx.mail.
export function createResendMailer({ apiKey, from, replyTo, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  return {
    async send({ to, subject, html }) {
      const body = { from, to: Array.isArray(to) ? to : [to], subject, html };
      if (replyTo) body.reply_to = replyTo;
      const res = await doFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Resend ' + res.status + ': ' + (await res.text()));
    },
  };
}
