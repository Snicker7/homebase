import test from 'node:test';
import assert from 'node:assert';
import { barChart } from './chart.js';

const count = (s, re) => (s.match(re) || []).length;

test('barChart draws one bar per value and scales the tallest to the top', () => {
  const svg = barChart({ values: [10, 20, 40], labels: ['J', 'F', 'M'] });
  assert.strictEqual(count(svg, /<rect class="bar"/g), 3);
  const heights = [...svg.matchAll(/<rect class="bar"[^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(heights[2] > heights[1] && heights[1] > heights[0]);
  assert.ok(Math.abs(heights[2] - 2 * heights[1]) < 0.01, 'heights are proportional');
});

test('barChart draws the average line when given, at the right height', () => {
  const svg = barChart({ values: [10, 30], labels: ['a', 'b'], line: 20, height: 120 });
  assert.strictEqual(count(svg, /<line class="avg"/g), 1);
  const bar = Number(/<rect class="bar"[^>]*height="([\d.]+)"/.exec(svg)[1]);
  const y = Number(/<line class="avg"[^>]*y1="([\d.]+)"/.exec(svg)[1]);
  // 10 of 30 is a third of the plot height; the line at 20 sits two thirds up.
  const bottom = Number(/<rect class="bar"[^>]*y="([\d.]+)"/.exec(svg)[1]) + bar;
  assert.ok(Math.abs((bottom - y) - 2 * bar) < 0.5);
});

test('barChart survives all-zero and empty input without dividing by zero', () => {
  assert.match(barChart({ values: [0, 0], labels: ['a', 'b'] }), /<svg/);
  assert.match(barChart({ values: [], labels: [] }), /<svg/);
  assert.doesNotMatch(barChart({ values: [0, 0], labels: ['a', 'b'] }), /NaN/);
});

test('barChart escapes labels and carries an accessible title', () => {
  const svg = barChart({ values: [1], labels: ['<b>'], format: (v) => '$' + v });
  assert.match(svg, /&lt;b&gt;/);
  assert.match(svg, /<title>[^<]*\$1/);
});
