// Runs only against the local stack: DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test
import test from 'node:test';
import assert from 'node:assert';
import postgres from 'postgres';
import * as db from './caldb.js';

const DB_URL = process.env.DB_URL;

// The calendar tables hold nothing a test should keep, so each test starts and
// ends on an empty set rather than working around whatever ran before it.
async function clear(sql) {
  await sql`delete from event_exceptions`;
  await sql`delete from events`;
  await sql`delete from office_items`;
}

const series = (sql, title, day, extra = {}) => db.saveEvent(sql, {
  title, notes: '', categoryId: 'family', day, time: null, minutes: null,
  repeat: null, repeatUntil: null, user: 'ann@x.com', ...extra,
});

test('caldb: listSeries takes the series a padded window can reach', { skip: !DB_URL && 'set DB_URL' }, async () => {
  const sql = postgres(DB_URL);
  try {
    await clear(sql);
    await sql`insert into people (email, name) values ('ann@x.com', 'Ann') on conflict do nothing`;
    const mondays = { freq: 'weekly', days: [1] };
    await series(sql, 'Soccer', '2026-01-05', { repeat: mondays });
    await series(sql, 'Swimming', '2026-01-05', { repeat: mondays, repeatUntil: '2026-07-01' });
    await series(sql, 'Dentist', '2026-01-06');
    await series(sql, 'Recital', '2026-09-20', { time: '09:00', minutes: 45 });
    await series(sql, 'Parade', '2026-10-20');
    await series(sql, 'Ski trip', '2026-12-01');

    // Drawn September; selected August through October, because an exception can
    // pull an occurrence in from a month either side.
    const rows = await db.listSeries(sql, '2026-09-01', '2026-09-30');
    assert.deepStrictEqual(rows.map((r) => r.title).sort(), ['Parade', 'Recital', 'Soccer'],
      'a repeating series from January still reaches September; a one-off from January does not, ' +
      'a repeat that ended in July does not, and October is inside the pad while December is not');

    const soccer = rows.find((r) => r.title === 'Soccer');
    assert.deepStrictEqual(soccer.repeat, mondays);
    assert.strictEqual(soccer.repeatUntil, null);
    // The columns come back as the strings the expander reads, never as dates.
    const recital = rows.find((r) => r.title === 'Recital');
    assert.strictEqual(recital.day, '2026-09-20');
    assert.strictEqual(recital.time, '09:00');
    assert.strictEqual(recital.minutes, 45);
    assert.strictEqual(recital.categoryId, 'family');

    // A series that ends inside the pad is still selected: its last occurrences
    // are in the drawn window.
    await series(sql, 'Lessons', '2026-01-05', { repeat: mondays, repeatUntil: '2026-08-10' });
    const withLessons = await db.listSeries(sql, '2026-09-01', '2026-09-30');
    assert.ok(withLessons.some((r) => r.title === 'Lessons'));
  } finally {
    await clear(sql);
    await sql.end();
  }
});

test('caldb: replaceOfficeWindow replaces its window and no other day', { skip: !DB_URL && 'set DB_URL' }, async () => {
  const sql = postgres(DB_URL);
  try {
    await clear(sql);
    const item = (id, day, title) => ({
      id, kind: 'task', brand: 'keepsite', slug: id, business: 'Keepsite', title, day,
      time: null, minutes: null, done: false, waits_on_client: false, source: 'feed',
      stage: null, project: null, repeat: null, link: null, url: 'https://example.com/' + id,
    });

    await db.replaceOfficeWindow(sql, [item('a', '2026-09-10', 'Draft'), item('b', '2026-09-12', 'Review')], '2026-09-01', '2026-09-30');
    await db.replaceOfficeWindow(sql, [item('c', '2026-10-05', 'Launch')], '2026-10-01', '2026-10-31');
    const first = await db.listOfficeItems(sql, '2026-09-01', '2026-09-30');
    assert.deepStrictEqual(first.map((r) => r.id), ['a', 'b']);

    // The feed dropped b and renamed a: the window is the unit of truth, so b
    // leaves and October is none of this window's business.
    await db.replaceOfficeWindow(sql, [item('a', '2026-09-10', 'Draft again')], '2026-09-01', '2026-09-30');
    const second = await db.listOfficeItems(sql, '2026-09-01', '2026-09-30');
    assert.deepStrictEqual(second.map((r) => [r.id, r.title]), [['a', 'Draft again']]);
    assert.deepStrictEqual((await db.listOfficeItems(sql, '2026-10-01', '2026-10-31')).map((r) => r.id), ['c']);

    // An empty feed window is the other delete branch: it empties the window
    // outright, and still leaves October alone.
    await db.replaceOfficeWindow(sql, [], '2026-09-01', '2026-09-30');
    assert.strictEqual((await db.listOfficeItems(sql, '2026-09-01', '2026-09-30')).length, 0);
    assert.deepStrictEqual((await db.listOfficeItems(sql, '2026-10-01', '2026-10-31')).map((r) => r.id), ['c']);
  } finally {
    await clear(sql);
    await sql.end();
  }
});

test('caldb: saveOccurrence replaces the exception on a day rather than adding one', { skip: !DB_URL && 'set DB_URL' }, async () => {
  const sql = postgres(DB_URL);
  try {
    await clear(sql);
    await sql`insert into people (email, name) values ('ann@x.com', 'Ann') on conflict do nothing`;
    const id = await series(sql, 'Soccer', '2026-09-01', { repeat: { freq: 'weekly', days: [2] } });

    await db.saveOccurrence(sql, { eventId: id, day: '2026-09-22', skipped: false, override: { title: 'Soccer — away game' } });
    const overridden = await db.listExceptions(sql, [id]);
    assert.deepStrictEqual(overridden, [{ eventId: id, day: '2026-09-22', skipped: false, override: { title: 'Soccer — away game' } }]);

    // Skipping the day it was renamed on: one row per occurrence, so the
    // override goes with the row it was stored in.
    await db.saveOccurrence(sql, { eventId: id, day: '2026-09-22', skipped: true, override: null });
    assert.deepStrictEqual(await db.listExceptions(sql, [id]),
      [{ eventId: id, day: '2026-09-22', skipped: true, override: null }]);

    await db.saveOccurrence(sql, { eventId: id, day: '2026-09-29', skipped: true, override: null });
    assert.strictEqual((await db.listExceptions(sql, [id])).length, 2);
    assert.deepStrictEqual(await db.listExceptions(sql, []), []);
  } finally {
    await clear(sql);
    await sql.end();
  }
});
