// Input checks for the bank actions that ride on the api function. Pure, so
// the shapes are tested without a database.
export const BANK_ACTIONS = ['categorize', 'addBudgetCategory'];

const MAX_NOTE = 500;

export function validateCategorize(p) {
  const id = String(p.id || '').trim();
  const categoryId = String(p.categoryId || '').trim();
  const note = String(p.note || '').trim();
  if (!id) return { error: 'transaction id required' };
  if (!categoryId) return { error: 'category required' };
  if (note.length > MAX_NOTE) return { error: 'note must be ' + MAX_NOTE + ' characters or fewer' };
  return { id, categoryId, note, remember: p.remember === true || p.remember === 'true' };
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function validateCategory(p) {
  const name = String(p.name || '').trim();
  const kind = p.kind ? String(p.kind) : 'spend';
  if (!name) return { error: 'name required' };
  if (kind !== 'spend' && kind !== 'income' && kind !== 'transfer') return { error: 'kind must be spend, income, or transfer' };
  const id = slug(name);
  if (!id) return { error: 'name needs a letter or digit' };
  return { id, name, emoji: String(p.emoji || '').trim().slice(0, 16), kind };
}
