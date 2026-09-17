// Helpers every screen module shares. app.js imports these too, so there is
// one definition of each.
export const $ = (id) => document.getElementById(id);
// Denver's date, not the browser's: every day and time in this app is Denver
// wall-clock, and a laptop in another zone must not shift what "today" means.
export const denverToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
export const money = (n) => { const v = Number(n || 0); return (v < 0 ? '−$' : '$') + Math.abs(v).toFixed(2); };
// Every innerHTML interpolates values the two of you typed — names and notes.
export const esc = (v) =>
  String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function banner(msg, isError) {
  const b = $('banner');
  b.textContent = msg;
  b.className = 'banner' + (isError ? ' error' : ' ok');
  b.hidden = !msg;
}

// Can this browser actually keep what we store? supabase-js runs the same
// probe, and when it fails it silently holds the auth session in a plain
// object that dies with the tab — which reaches the person as "log in again in
// every new tab". Probing it here lets the app say so instead.
export function storageWritable(store) {
  try {
    if (!store) return false;
    const k = 'hb-probe-' + Math.random();
    store.setItem(k, k);
    const kept = store.getItem(k) === k;
    store.removeItem(k);
    return kept;
  } catch {
    return false;
  }
}
