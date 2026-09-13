// The morning email: today and the next two days, one message per person.
// Email has no custom properties, so every color is written inline.
import { listSeries, listExceptions, listOfficeItems } from './caldb.js';
import { expandAll, officeOccurrence, sortOccurrences, addDays, weekday, timeLabel } from './recur.js';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DEFAULT_COLOR = '#8d9bb5';

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Read the three days the calendar needs, from both sources.
export async function gatherDigest(sql, today, deps) {
  const d = deps || { listSeries, listExceptions, listOfficeItems };
  const to = addDays(today, 2);
  const series = await d.listSeries(sql, today, to);
  const exceptions = await d.listExceptions(sql, series.map((s) => s.id));
  const office = await d.listOfficeItems(sql, today, to);
  return sortOccurrences(expandAll(series, exceptions, today, to).concat(office.map(officeOccurrence)));
}

// Items already done, and office tasks waiting on somebody else, are calendar
// texture rather than morning reading.
const worthSending = (o) => !o.done && !o.waitsOnClient;

export function digestDays(items, today) {
  return [0, 1, 2].map((n) => {
    const day = addDays(today, n);
    return {
      day,
      heading: n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : WEEKDAYS[weekday(day) - 1],
      items: items.filter((o) => o.day === day && worthSending(o)),
    };
  });
}

export function renderDigest(days, cats, dashboardUrl) {
  const total = days.reduce((n, d) => n + d.items.length, 0);
  // A daily email that usually says "nothing scheduled" trains you to ignore it.
  if (!total) return null;

  const today = days[0].items;
  // Two titles is about as much as an inbox list shows; the rest are a count,
  // so a busy morning does not produce a subject nothing will display.
  const SUBJECT_TITLES = 2;
  const named = today.slice(0, SUBJECT_TITLES).map((o) => o.title).join(', ');
  const rest = today.length - SUBJECT_TITLES;
  const subject = !today.length
    ? '📅 Nothing today · ' + days[1].items.concat(days[2].items).length + ' coming up'
    : today.length === 1
      ? '📅 ' + today[0].title
      : '📅 ' + today.length + ' things today: ' + named + (rest > 0 ? ' and ' + rest + ' more' : '');

  const row = (o) => {
    const color = (cats[o.categoryId] && cats[o.categoryId].color) || DEFAULT_COLOR;
    const link = o.readOnly && o.url;
    const title = link
      ? '<a href="' + esc(o.url) + '" style="color:inherit">' + esc(o.title) + '</a>'
      : esc(o.title);
    return '<tr><td style="padding:0 0 8px">' +
      '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>' +
      '<td style="width:4px;background:' + esc(color) + ';border-radius:2px">&nbsp;</td>' +
      '<td style="padding-left:10px">' +
      (o.business ? '<div style="font-size:12px;color:#5b639a">' + esc(o.business) + '</div>' : '') +
      '<div><b>' + title + '</b></div>' +
      '<div style="font-size:13px;color:#5b639a">' + esc(timeLabel(o.time, o.minutes)) + '</div>' +
      '</td></tr></table></td></tr>';
  };

  const section = (d) =>
    '<h3 style="margin:18px 0 8px;font-size:15px">' + esc(d.heading) + '</h3>' +
    (d.items.length
      ? '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">' + d.items.map(row).join('') + '</table>'
      : '<p style="margin:0;color:#5b639a">Nothing scheduled.</p>');

  const html =
    '<div style="font-family:system-ui,Arial,sans-serif;max-width:480px">' +
    days.map(section).join('') +
    '<p style="margin-top:20px"><a href="' + esc(dashboardUrl) + '#/calendar">Open the calendar</a></p></div>';

  return { subject, html };
}
