// Plaid REST client. `fetchImpl` is injected so tests never touch the network
// and the same file runs under Node and Deno.
const HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

export class PlaidError extends Error {
  constructor(body, status) {
    super((body && body.error_message) || 'Plaid request failed');
    this.name = 'PlaidError';
    this.code = (body && body.error_code) || '';
    this.type = (body && body.error_type) || '';
    this.status = status;
  }
}

// Plaid codes that Link's update mode can repair: the user re-enters credentials
// or re-grants access and the same item keeps working.
const LOGIN_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'PENDING_EXPIRATION',
  'ITEM_LOCKED',
  'INSUFFICIENT_CREDENTIALS',
  'USER_PERMISSION_REVOKED',
]);

// What an item's status becomes after a failed call. Only a login problem is
// fixable by the user; everything else waits for the next sync or a look at the logs.
export function itemStatusFor(err) {
  return err && LOGIN_CODES.has(err.code) ? 'login_required' : 'error';
}

export function createPlaid({ clientId, secret, env, fetchImpl }) {
  const base = HOSTS[env] || HOSTS.sandbox;
  async function call(path, body) {
    const res = await fetchImpl(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, secret, ...body }),
    });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON body: the status carries the news */ }
    if (!res.ok) throw new PlaidError(data, res.status);
    return data;
  }
  return {
    // Update mode (accessToken given) re-authenticates an existing item: no
    // products, so the Trial plan's item count does not move.
    // `userId` becomes Plaid's client_user_id, which their docs require to
    // carry no personal data — send the auth uuid, never an email.
    async linkToken({ userId, accessToken }) {
      if (!userId || /@/.test(String(userId))) {
        throw new Error('client_user_id must be an opaque id, not an email');
      }
      const body = {
        user: { client_user_id: userId },
        client_name: 'Homebase',
        country_codes: ['US'],
        language: 'en',
      };
      if (accessToken) body.access_token = accessToken;
      else { body.products = ['transactions']; body.transactions = { days_requested: 90 }; }
      return (await call('/link/token/create', body)).link_token;
    },
    async exchange(publicToken) {
      const d = await call('/item/public_token/exchange', { public_token: publicToken });
      return { accessToken: d.access_token, itemId: d.item_id };
    },
    async accounts(accessToken) {
      return (await call('/accounts/get', { access_token: accessToken })).accounts || [];
    },
    // One page of /transactions/sync. The caller loops on has_more and saves
    // next_cursor only once the whole run is in.
    async syncPage(accessToken, cursor) {
      const body = { access_token: accessToken, count: 500 };
      if (cursor) body.cursor = cursor;
      return call('/transactions/sync', body);
    },
  };
}
