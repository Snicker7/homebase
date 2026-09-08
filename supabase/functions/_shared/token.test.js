import test from 'node:test';
import assert from 'node:assert';
import { signToken, verifyToken } from './token.js';

const secret = 'test-secret';
const payload = { person: 'a@x.com', categoryId: 'bedtime', periodKey: '2026-09-07', result: 'on_time', exp: 2_000_000_000_000 };

test('round trip', async () => {
  const t = await signToken(payload, secret);
  assert.match(t, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepStrictEqual(await verifyToken(t, secret, 1_000_000_000_000), payload);
});

test('rejects tampering, wrong secret, expiry, garbage', async () => {
  const t = await signToken(payload, secret);
  const [body, sig] = t.split('.');
  const other = await signToken({ ...payload, result: 'missed' }, secret);
  assert.strictEqual(await verifyToken(other.split('.')[0] + '.' + sig, secret, 1), null);
  assert.strictEqual(await verifyToken(t, 'nope', 1), null);
  assert.strictEqual(await verifyToken(t, secret, payload.exp + 1), null);
  assert.strictEqual(await verifyToken('junk', secret, 1), null);
  assert.strictEqual(await verifyToken(body, secret, 1), null);
});
