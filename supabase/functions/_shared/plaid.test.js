import test from 'node:test';
import assert from 'node:assert';
import { createPlaid, PlaidError, itemStatusFor } from './plaid.js';

// A fetch that records the request and answers with canned JSON.
function fakeFetch(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: status < 400, status, json: async () => body };
  };
  return { fetchImpl, calls };
}
const creds = { clientId: 'cid', secret: 'sec', env: 'sandbox' };
// Plaid asks that client_user_id carry no personal data, so the app sends the
// auth user's uuid rather than their email.
const UID = '9f1c3b7e-2d4a-4c8e-9b71-5a0e6f2d8c31';

test('linkToken posts credentials, the user, and transactions product', async () => {
  const { fetchImpl, calls } = fakeFetch(200, { link_token: 'link-sandbox-1' });
  const plaid = createPlaid({ ...creds, fetchImpl });
  assert.strictEqual(await plaid.linkToken({ userId: UID }), 'link-sandbox-1');
  assert.strictEqual(calls[0].url, 'https://sandbox.plaid.com/link/token/create');
  const b = calls[0].body;
  assert.strictEqual(b.client_id, 'cid');
  assert.strictEqual(b.secret, 'sec');
  assert.deepStrictEqual(b.user, { client_user_id: UID });
  assert.deepStrictEqual(b.products, ['transactions']);
  assert.deepStrictEqual(b.country_codes, ['US']);
});

test('linkToken in update mode sends the access token and no products', async () => {
  const { fetchImpl, calls } = fakeFetch(200, { link_token: 'link-update' });
  await createPlaid({ ...creds, fetchImpl }).linkToken({ userId: UID, accessToken: 'access-1' });
  assert.strictEqual(calls[0].body.access_token, 'access-1');
  assert.strictEqual(calls[0].body.products, undefined);
});

test('exchange returns the access token and item id', async () => {
  const { fetchImpl, calls } = fakeFetch(200, { access_token: 'access-1', item_id: 'item-1' });
  const r = await createPlaid({ ...creds, fetchImpl }).exchange('public-1');
  assert.deepStrictEqual(r, { accessToken: 'access-1', itemId: 'item-1' });
  assert.strictEqual(calls[0].body.public_token, 'public-1');
});

test('syncPage omits an empty cursor and asks for 500 rows', async () => {
  const { fetchImpl, calls } = fakeFetch(200, { added: [], modified: [], removed: [], next_cursor: 'c1', has_more: false });
  const plaid = createPlaid({ ...creds, fetchImpl });
  await plaid.syncPage('access-1', null);
  assert.strictEqual('cursor' in calls[0].body, false);
  assert.strictEqual(calls[0].body.count, 500);
  await plaid.syncPage('access-1', 'c1');
  assert.strictEqual(calls[1].body.cursor, 'c1');
});

test('production env uses the production host', async () => {
  const { fetchImpl, calls } = fakeFetch(200, { accounts: [] });
  await createPlaid({ ...creds, env: 'production', fetchImpl }).accounts('access-1');
  assert.strictEqual(calls[0].url, 'https://production.plaid.com/accounts/get');
});

test('a Plaid error becomes a PlaidError with its code, and maps to an item status', async () => {
  const { fetchImpl } = fakeFetch(400, { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed' });
  await assert.rejects(createPlaid({ ...creds, fetchImpl }).accounts('access-1'), (e) => {
    assert.ok(e instanceof PlaidError);
    assert.strictEqual(e.code, 'ITEM_LOGIN_REQUIRED');
    assert.strictEqual(e.status, 400);
    assert.strictEqual(itemStatusFor(e), 'login_required');
    return true;
  });
  assert.strictEqual(itemStatusFor(new Error('network')), 'error');
});

test('every login-fixable Plaid code maps to login_required, the rest to error', () => {
  for (const code of ['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'ITEM_LOCKED', 'INSUFFICIENT_CREDENTIALS', 'USER_PERMISSION_REVOKED']) {
    assert.strictEqual(itemStatusFor({ code }), 'login_required', code);
  }
  for (const code of ['ITEM_NOT_FOUND', 'INTERNAL_SERVER_ERROR', 'RATE_LIMIT', '']) {
    assert.strictEqual(itemStatusFor({ code }), 'error', code);
  }
  assert.strictEqual(itemStatusFor(null), 'error');
});

test('linkToken refuses an id that looks like an email', async () => {
  const { fetchImpl, calls } = fakeFetch(200, { link_token: 'link-1' });
  const plaid = createPlaid({ ...creds, fetchImpl });
  await assert.rejects(plaid.linkToken({ userId: 'ann@x.com' }), /client_user_id/);
  assert.strictEqual(calls.length, 0, 'nothing is sent to Plaid');
});
