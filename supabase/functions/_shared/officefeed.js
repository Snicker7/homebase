// The office feed: fetch, normalize, and hand the window to caldb. The contract
// is docs/office-calendar-feed.md. Days and times arrive as Denver wall-clock
// strings and are stored exactly as they arrive.
import { replaceOfficeWindow } from './caldb.js';
import { addDays } from './recur.js';

export const FEED_URL = 'https://www.keepsitemedia.com/office/api/feed';
const BACK_DAYS = 30;
const AHEAD_DAYS = 90;

// The feed would default to the same span, but the delete step has to know
// exactly which window it is replacing, so the window is stated rather than assumed.
export const feedWindow = (today) => ({ from: addDays(today, -BACK_DAYS), to: addDays(today, AHEAD_DAYS) });

const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const orNull = (v) => (v === undefined || v === '' ? null : v);

export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'task' || raw.kind === 'meeting' ? raw.kind : null;
  const id = String(raw.id || '').trim();
  const day = raw.kind === 'meeting' ? raw.ymd : raw.due;
  if (!kind || !id || !isDay(day)) return null;
  return {
    id,
    kind,
    brand: raw.brand === 'keepsite' || raw.brand === 'lova' ? raw.brand : null,
    slug: String(raw.slug || ''),
    business: orNull(raw.business),
    title: String(raw.title || ''),
    day,
    time: raw.time ? String(raw.time) : null,
    minutes: raw.minutes == null ? null : Number(raw.minutes),
    done: raw.done === true,
    waits_on_client: raw.waitsOnClient === true,
    source: String(raw.source || ''),
    stage: orNull(raw.stage),
    project: orNull(raw.project),
    repeat: orNull(raw.repeat),
    link: orNull(raw.link),
    url: orNull(raw.url),
  };
}

// `replace` is injectable so the tests never need a database.
export async function importFeed(sql, { token, today, fetchImpl, replace }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const write = replace || replaceOfficeWindow;
  const { from, to } = feedWindow(today);
  const failures = [];

  let body;
  try {
    const res = await doFetch(FEED_URL + '?from=' + from + '&to=' + to, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    });
    if (!res.ok) {
      failures.push('office feed ' + res.status + (res.status === 401 ? ' — check KEEPSITE_FEED_TOKEN' : ''));
      return { imported: 0, failures };
    }
    body = await res.json();
  } catch (e) {
    failures.push('office feed unreachable — ' + ((e && e.message) || e));
    return { imported: 0, failures };
  }

  // A 200 with no items array is a broken feed, not an empty one. Treating the
  // two alike would let one bad deploy upstream delete the whole cached window.
  if (!body || !Array.isArray(body.items)) {
    failures.push('office feed returned no items array');
    return { imported: 0, failures };
  }

  const rows = [];
  for (const raw of body.items) {
    const row = normalizeItem(raw);
    // One bad row must not cost the other ninety-nine.
    if (row) rows.push(row);
    else failures.push('unreadable office item: ' + JSON.stringify(raw).slice(0, 120));
  }
  await write(sql, rows, from, to);
  return { imported: rows.length, failures };
}
