import test from 'node:test';
import assert from 'node:assert';
import { createResendMailer } from './mail.js';

test('posts to Resend with from, reply_to, and bearer auth', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '{}' }; };
  const mailer = createResendMailer({ apiKey: 'k', from: 'Homebase <homebase@samnichols.dev>', replyTo: 'snic9004@gmail.com', fetchImpl });
  await mailer.send({ to: 'a@x.com', subject: 'Hi', html: '<b>x</b>' });
  assert.strictEqual(calls[0].url, 'https://api.resend.com/emails');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer k');
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { from: 'Homebase <homebase@samnichols.dev>', to: ['a@x.com'], reply_to: 'snic9004@gmail.com', subject: 'Hi', html: '<b>x</b>' });
});

test('throws with the response body on a non-2xx', async () => {
  const fetchImpl = async () => ({ ok: false, status: 422, text: async () => 'bad from' });
  const mailer = createResendMailer({ apiKey: 'k', from: 'x@y.z', replyTo: '', fetchImpl });
  await assert.rejects(mailer.send({ to: 'a@x.com', subject: 's', html: 'h' }), /Resend 422: bad from/);
});
