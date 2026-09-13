import test from 'node:test';
import assert from 'node:assert';
import { digestDays, renderDigest, gatherDigest } from './caldigest.js';

const occ = (over) => Object.assign({
  eventId: 'e1', seriesDay: '2026-09-15', day: '2026-09-15', title: 'Soccer', notes: '',
  categoryId: 'family', time: null, minutes: null, repeating: false, readOnly: false,
  url: null, business: null, done: false, waitsOnClient: false,
}, over);
const CATS = { family: { color: '#57c785' }, keepsite: { color: '#7f8cf0' } };

test('three days, headed Today, Tomorrow, and a weekday name', () => {
  const days = digestDays([occ()], '2026-09-15');
  assert.deepStrictEqual(days.map((d) => d.heading), ['Today', 'Tomorrow', 'Thursday']);
  assert.deepStrictEqual(days.map((d) => d.day), ['2026-09-15', '2026-09-16', '2026-09-17']);
});

test('items land on their own day and nothing outside the three appears', () => {
  const days = digestDays([occ(), occ({ day: '2026-09-17', title: 'Dentist' }), occ({ day: '2026-09-20', title: 'Far' })], '2026-09-15');
  assert.deepStrictEqual(days[0].items.map((i) => i.title), ['Soccer']);
  assert.deepStrictEqual(days[1].items, []);
  assert.deepStrictEqual(days[2].items.map((i) => i.title), ['Dentist']);
});

test('done and waiting-on-client office items are left out of the email', () => {
  const days = digestDays([
    occ({ readOnly: true, done: true, title: 'Finished' }),
    occ({ readOnly: true, waitsOnClient: true, title: 'Waiting' }),
    occ({ title: 'Real' }),
  ], '2026-09-15');
  assert.deepStrictEqual(days[0].items.map((i) => i.title), ['Real']);
});

test('an empty three days sends nothing at all', () => {
  assert.strictEqual(renderDigest(digestDays([], '2026-09-15'), CATS, 'https://x/'), null);
  assert.strictEqual(
    renderDigest(digestDays([occ({ readOnly: true, done: true })], '2026-09-15'), CATS, 'https://x/'),
    null, 'a day of nothing but filtered items is still empty');
});

test('the subject names today and the html carries times, colors, and the business', () => {
  const days = digestDays([
    occ({ title: 'Soccer', time: '09:00', minutes: 30 }),
    occ({ title: 'Kickoff call', categoryId: 'keepsite', readOnly: true, business: 'Hollow Oak Cabinetry', time: '10:00', minutes: 30 }),
    occ({ day: '2026-09-16', title: 'Bin day' }),
  ], '2026-09-15');
  const out = renderDigest(days, CATS, 'https://homebase.samnichols.dev/');
  assert.match(out.subject, /Soccer/);
  assert.match(out.html, /9:00 – 9:30 AM/);
  assert.match(out.html, /#57c785/);
  assert.match(out.html, /Hollow Oak Cabinetry/);
  assert.match(out.html, /All day/);
  assert.match(out.html, /homebase\.samnichols\.dev/);
});

test('the subject says how many when there is more than one', () => {
  const days = digestDays([occ({ title: 'A' }), occ({ title: 'B' }), occ({ title: 'C' })], '2026-09-15');
  assert.match(renderDigest(days, CATS, 'https://x/').subject, /3 things today/);
});

test('a title with angle brackets is escaped', () => {
  const days = digestDays([occ({ title: '<script>x</script>' })], '2026-09-15');
  assert.match(renderDigest(days, CATS, 'https://x/').html, /&lt;script&gt;/);
  assert.doesNotMatch(renderDigest(days, CATS, 'https://x/').html, /<script>/);
});

test('an empty today still reports tomorrow', () => {
  const days = digestDays([occ({ day: '2026-09-16', title: 'Bin day' })], '2026-09-15');
  const out = renderDigest(days, CATS, 'https://x/');
  assert.match(out.subject, /Nothing today/);
  assert.match(out.html, /Bin day/);
});

test('gatherDigest asks for exactly three days and merges both sources', async () => {
  const asked = [];
  const deps = {
    listSeries: async (_sql, from, to) => { asked.push([from, to]); return [{ id: 'e1', title: 'Soccer', notes: '', categoryId: 'family', day: '2026-09-15', time: null, minutes: null, repeat: null, repeatUntil: null }]; },
    listExceptions: async () => [],
    listOfficeItems: async () => [{ id: 'o1', title: 'Kickoff', day: '2026-09-16', time: '10:00', minutes: 30, brand: 'keepsite', business: 'Hollow Oak', done: false, waits_on_client: false, url: 'https://x' }],
  };
  const items = await gatherDigest(null, '2026-09-15', deps);
  assert.deepStrictEqual(asked[0], ['2026-09-15', '2026-09-17']);
  assert.deepStrictEqual(items.map((i) => i.title), ['Soccer', 'Kickoff']);
});
