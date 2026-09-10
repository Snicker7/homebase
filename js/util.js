// Helpers every screen module shares. app.js imports these too, so there is
// one definition of each.
export const $ = (id) => document.getElementById(id);
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
