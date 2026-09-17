// The "left this month" block at the top of the Budget screen, built from one
// month_summary row. Pure so it can be tested without a DOM.
import { esc, money } from './util.js';

export function summaryHtml(r) {
  const remaining = Number(r.remaining);
  const noHistory = !Number(r.months_in_window);
  const part = (label, value, note) =>
    '<div class="summary-part"><span>' + esc(label) +
    (note ? ' <span class="muted">' + esc(note) + '</span>' : '') +
    '</span><span>' + money(value) + '</span></div>';
  return (
    '<div class="summary' + (remaining < 0 ? ' over' : '') + '">' +
      '<div class="summary-lead"><span class="summary-label">Left this month</span>' +
      '<b class="summary-amt">' + money(remaining) + '</b></div>' +
      '<div class="summary-parts">' +
        part('Expected income', r.expected_income, noHistory ? 'no income history yet' : '') +
        part('Spent, filed', -Number(r.spent_filed)) +
        part('Spent, unfiled', -Number(r.spent_unfiled)) +
      '</div>' +
    '</div>'
  );
}

// The personal wallets beneath it: what the habit and chore side paid each of
// you this month, and what left the wallet. One row per person, built from
// wallet_month. Pure, like summaryHtml.
export function walletsHtml(rows) {
  if (!rows || !rows.length) return '';
  const line = (w) =>
    '<div class="summary-part"><span>' + esc(w.name) + '</span>' +
    '<span>' + money(w.earned) + ' earned · ' + money(-Number(w.spent)) + ' spent</span></div>';
  return (
    '<div class="summary">' +
      '<div class="summary-lead"><span class="summary-label">Wallets this month</span></div>' +
      '<div class="summary-parts">' + rows.map(line).join('') + '</div>' +
    '</div>'
  );
}
