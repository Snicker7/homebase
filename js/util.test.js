import test from 'node:test';
import assert from 'node:assert';
import { storageWritable } from './util.js';

// A store that behaves: the probe writes a key and reads it back.
const working = () => {
  const map = new Map();
  return {
    setItem: (k, v) => map.set(k, String(v)),
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    removeItem: (k) => map.delete(k),
  };
};

test('storageWritable accepts a store that keeps what it is given', () => {
  assert.strictEqual(storageWritable(working()), true);
});

test('storageWritable rejects a store that throws on write', () => {
  const store = Object.assign(working(), {
    setItem: () => { throw new Error('QuotaExceededError'); },
  });
  assert.strictEqual(storageWritable(store), false);
});

// Safari with cookies blocked has shipped both shapes: a throwing setItem and
// one that accepts the write and drops it. Reading back catches the quiet one.
test('storageWritable rejects a store that silently drops the write', () => {
  const store = Object.assign(working(), { setItem: () => {}, getItem: () => null });
  assert.strictEqual(storageWritable(store), false);
});

test('storageWritable rejects a missing store instead of throwing', () => {
  assert.strictEqual(storageWritable(undefined), false);
  assert.strictEqual(storageWritable(null), false);
});

test('storageWritable cleans up the key it probed with', () => {
  const map = new Map();
  const seen = [];
  const store = {
    setItem: (k, v) => { seen.push(k); map.set(k, String(v)); },
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    removeItem: (k) => map.delete(k),
  };
  assert.strictEqual(storageWritable(store), true);
  assert.ok(seen.length, 'the probe actually wrote something');
  assert.strictEqual(map.size, 0, 'and took it back out again');
});
