import test from 'node:test';
import assert from 'node:assert';
import { summaryHtml, walletsHtml } from './summary.js';

const row = { expected_income: '1250.00', spent_filed: '65.00', spent_unfiled: '40.00', remaining: '1145.00', months_in_window: 2 };

test('summaryHtml leads with what is left and lists the three parts', () => {
  const html = summaryHtml(row);
  assert.match(html, /Left this month/);
  assert.match(html, /\$1145\.00/);
  assert.match(html, /Expected income.*\$1250\.00/s);
  assert.match(html, /Spent, filed.*\$65\.00/s);
  assert.match(html, /Spent, unfiled.*\$40\.00/s);
  assert.doesNotMatch(html, /class="summary over"/);
});

test('summaryHtml flags a negative remainder', () => {
  const html = summaryHtml({ ...row, remaining: '-105.00' });
  assert.match(html, /class="summary over"/);
  assert.match(html, /−\$105\.00/);
});

test('summaryHtml says when there is no income history to expect from', () => {
  const html = summaryHtml({ ...row, expected_income: '0.00', remaining: '-105.00', months_in_window: 0 });
  assert.match(html, /no income history yet/);
});

const wallets = [
  { email: 'ann@x.com', name: 'Ann', earned: '48.25', spent: '31.00' },
  { email: 'bo@x.com', name: 'Bo', earned: '12.00', spent: '4.50' },
];

test('walletsHtml lists each person with what they earned and spent', () => {
  const html = walletsHtml(wallets);
  assert.match(html, /Wallets this month/);
  assert.match(html, /Ann.*\$48\.25.*−\$31\.00/s);
  assert.match(html, /Bo.*\$12\.00.*−\$4\.50/s);
});

test('walletsHtml escapes a name rather than trusting it', () => {
  const html = walletsHtml([{ email: 'x@x.com', name: '<script>', earned: '0', spent: '0' }]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('walletsHtml renders nothing when there are no wallets to show', () => {
  assert.strictEqual(walletsHtml([]), '');
  assert.strictEqual(walletsHtml(undefined), '');
});
