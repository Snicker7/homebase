import test from 'node:test';
import assert from 'node:assert';
import { validateCategorize, validateCategory, BANK_ACTIONS } from './bankactions.js';

test('validateCategorize: needs an id and a category, trims the note, coerces remember', () => {
  assert.deepStrictEqual(validateCategorize({ id: 'tx1', categoryId: 'groceries', note: '  bulk ', remember: 'true' }),
    { id: 'tx1', categoryId: 'groceries', note: 'bulk', remember: true });
  assert.deepStrictEqual(validateCategorize({ id: 'tx1', categoryId: 'groceries' }), { id: 'tx1', categoryId: 'groceries', note: '', remember: false });
  assert.match(validateCategorize({ categoryId: 'groceries' }).error, /transaction/);
  assert.match(validateCategorize({ id: 'tx1' }).error, /category/);
  assert.match(validateCategorize({ id: 'tx1', categoryId: 'g', note: 'x'.repeat(501) }).error, /note/i);
});

test('validateCategory: slugs the name, defaults to spend, rejects wallet', () => {
  assert.deepStrictEqual(validateCategory({ name: ' Eating Out ', emoji: '🍔' }), { id: 'eating-out', name: 'Eating Out', emoji: '🍔', kind: 'spend' });
  assert.strictEqual(validateCategory({ name: 'Paycheck', kind: 'income' }).kind, 'income');
  assert.match(validateCategory({ name: '' }).error, /name/i);
  assert.match(validateCategory({ name: 'X', kind: 'wallet' }).error, /kind/i);
});

test('BANK_ACTIONS lists the two actions api routes to bankdb', () => {
  assert.deepStrictEqual(BANK_ACTIONS, ['categorize', 'addBudgetCategory']);
});
