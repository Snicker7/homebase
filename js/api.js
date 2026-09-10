// js/api.js — everything the dashboard needs from Supabase: the auth session,
// the authenticated `api` calls, and the anon-key check-in call.
// supabase-js is vendored as a UMD bundle (js/vendor/supabase.js, loaded by
// index.html) so the login screen never waits on a CDN module graph.
const { createClient } = window.supabase;

const cfg = window.CONFIG || {};
export const configured = () =>
  /^https?:\/\//.test(cfg.SUPABASE_URL || '') &&
  !!cfg.SUPABASE_ANON_KEY &&
  !/paste/.test(cfg.SUPABASE_ANON_KEY);

const supabase = configured() ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
// Direct reads under row-level security. Writes never go this way.
export const sb = supabase;
const fnUrl = (name) => cfg.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/' + name;

async function post(name, body, token) {
  if (!supabase) throw new Error('Backend not configured (set SUPABASE_URL and SUPABASE_ANON_KEY in js/config.js)');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(fnUrl(name), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Run the function next to the database: every request opens a
        // connection and makes three round trips, and cross-region each one
        // costs about 100 ms.
        'x-region': 'us-west-1',
        apikey: cfg.SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + (token || cfg.SUPABASE_ANON_KEY),
      },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Network timeout — check your connection' : 'Could not reach the backend');
  } finally {
    clearTimeout(timer);
  }
  let data;
  try { data = await res.json(); } catch { throw new Error('Backend returned an unreadable response'); }
  return data;
}

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

export async function api(action, extra) {
  const session = await getSession();
  if (!session) return { ok: false, error: 'not authorized — please log in again' };
  return post('api', Object.assign({ action }, extra || {}), session.access_token);
}

export const checkup = (t) => post('checkup', { t });

// The plaid function: bank linking and syncing.
export async function bank(action, extra) {
  const session = await getSession();
  if (!session) return { ok: false, error: 'not authorized — please log in again' };
  return post('plaid', Object.assign({ action }, extra || {}), session.access_token);
}

export async function requestLogin(email) {
  if (!supabase) throw new Error('Backend not configured');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin + location.pathname },
  });
  // Unknown emails are rejected by the database trigger; say the same thing
  // either way so the allowlist can't be probed.
  if (error && !/signups are closed|Database error/i.test(error.message)) throw new Error(error.message);
}

export const signOut = () => (supabase ? supabase.auth.signOut() : Promise.resolve());
export const onAuthChange = (cb) => supabase && supabase.auth.onAuthStateChange((_evt, session) => cb(session));
