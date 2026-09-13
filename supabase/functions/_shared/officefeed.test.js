import test from 'node:test';
import assert from 'node:assert';
import { feedWindow, normalizeItem, importFeed } from './officefeed.js';

const SAMPLE = {
  generatedAt: '2026-09-13T15:02:11.000Z',
  timezone: 'America/Denver',
  items: [
    { kind: 'task', id: '20260912T171530abcdef', brand: 'keepsite', slug: 'sapphire-stem-floral',
      business: 'Sapphire Stem Floral', title: 'Layouts approved', due: '2026-09-15', time: null,
      done: false, waitsOnClient: false, source: 'pipeline', stage: 'layouts', project: null, repeat: null,
      url: 'https://www.keepsitemedia.com/office/clients/sapphire-stem-floral/?tab=tasks' },
    { kind: 'task', id: '20260912T180001qrstuv', brand: null, slug: 'office', business: null,
      title: 'Post on LinkedIn', due: '2026-09-19', time: '09:00', done: false, waitsOnClient: false,
      source: 'manual', stage: null, project: 'Marketing', repeat: 'weekly',
      url: 'https://www.keepsitemedia.com/office/tasks/' },
    { kind: 'meeting', id: '20260910T140000mnopqr', brand: 'keepsite', slug: 'hollow-oak-cabinetry',
      business: 'Hollow Oak Cabinetry', title: 'Kickoff call', ymd: '2026-09-16', time: '10:00', minutes: 30,
      link: 'https://meet.google.com/abc-defg-hij',
      url: 'https://www.keepsitemedia.com/office/clients/hollow-oak-cabinetry/?tab=meetings' },
  ],
};

// A stand-in for caldb.replaceOfficeWindow plus a postgres handle.
const fakeDb = () => {
  const calls = [];
  return { calls, replace: async (sql, rows, from, to) => { calls.push({ rows, from, to }); } };
};

test('the window is thirty days back and ninety ahead', () => {
  assert.deepStrictEqual(feedWindow('2026-09-13'), { from: '2026-08-14', to: '2026-12-12' });
});

test('a task keeps its due day and a meeting its ymd', () => {
  assert.strictEqual(normalizeItem(SAMPLE.items[0]).day, '2026-09-15');
  assert.strictEqual(normalizeItem(SAMPLE.items[2]).day, '2026-09-16');
  assert.strictEqual(normalizeItem(SAMPLE.items[2]).minutes, 30);
});

test('camelCase becomes snake_case and absent fields become null', () => {
  const row = normalizeItem(SAMPLE.items[1]);
  assert.strictEqual(row.waits_on_client, false);
  assert.strictEqual(row.brand, null);
  assert.strictEqual(row.business, null);
  assert.strictEqual(row.minutes, null);
  assert.strictEqual(row.project, 'Marketing');
});

test('an item with no id, no day, or an unknown kind is dropped rather than stored', () => {
  assert.strictEqual(normalizeItem({ kind: 'task', title: 'x', due: '2026-09-15' }), null);
  assert.strictEqual(normalizeItem({ kind: 'task', id: 'a', title: 'x' }), null);
  assert.strictEqual(normalizeItem({ kind: 'invoice', id: 'a', title: 'x', due: '2026-09-15' }), null);
  assert.strictEqual(normalizeItem({ kind: 'task', id: 'a', title: 'x', due: '15/09/2026' }), null);
});

test('importFeed sends the token and the window, and replaces what it got', async () => {
  const db = fakeDb();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => SAMPLE, text: async () => '' };
  };
  const res = await importFeed(null, { token: 'tok', today: '2026-09-13', fetchImpl, replace: db.replace });
  assert.match(calls[0].url, /from=2026-08-14&to=2026-12-12/);
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.strictEqual(res.imported, 3);
  assert.deepStrictEqual(res.failures, []);
  assert.strictEqual(db.calls[0].rows.length, 3);
  assert.strictEqual(db.calls[0].from, '2026-08-14');
});

test('a 401 fails loudly and writes nothing', async () => {
  const db = fakeDb();
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => '' });
  const res = await importFeed(null, { token: 'bad', today: '2026-09-13', fetchImpl, replace: db.replace });
  assert.strictEqual(res.imported, 0);
  assert.match(res.failures[0], /401/);
  assert.strictEqual(db.calls.length, 0, 'nothing is replaced when the fetch failed');
});

test('a malformed item is named and the rest still import', async () => {
  const db = fakeDb();
  const body = { items: [SAMPLE.items[0], { kind: 'task', title: 'no id' }] };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
  const res = await importFeed(null, { token: 't', today: '2026-09-13', fetchImpl, replace: db.replace });
  assert.strictEqual(res.imported, 1);
  assert.strictEqual(res.failures.length, 1);
  assert.match(res.failures[0], /unreadable/);
});
