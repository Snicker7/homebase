// Fixtures for the service tests: a store loaded from plain objects, a clock
// you can move, and a mailbox that collects instead of sending.
import { createStore } from './store.js';

export const ANN = 'ann@x.com';
export const BO = 'bo@x.com';

export const BEDTIME = {
  id: 'bedtime', kind: 'habit', name: 'Bedtime', emoji: '🛏️', cadence: 'daily',
  rewardIncrement: 0.25, maxPerInstance: 5, freezesPerPeriod: 1, freezeRefresh: 'weekly',
  unusedFreezeBonus: 1, missPenaltyPercent: 100, minPayout: 0, notes: '',
  reminderTime: '21:00', checkupTime: '09:00', active: true,
};

export const DISHES = {
  id: 'dishes', kind: 'chore', name: 'Dishes', emoji: '🍽️', cadence: 'daily',
  value: 2, assignee: '', dueDate: '', dueDay: '', notes: '', reminderTime: '20:00', active: true,
};

export function makeCtx(opts = {}) {
  const store = createStore({
    people: opts.people || [{ email: ANN, name: 'Ann' }, { email: BO, name: 'Bo' }],
    categories: opts.categories || [BEDTIME],
    ledger: opts.ledger || [],
    habitStates: opts.habitStates || [],
    choreStates: opts.choreStates || [],
    settings: opts.settings || {},
    holidays: opts.holidays || [],
  });
  const sent = [];
  // Default clock: Tuesday 2026-09-08 10:00 Denver time (16:00Z).
  let now = new Date(opts.nowIso || '2026-09-08T16:00:00Z');
  const ctx = {
    store,
    now: () => now,
    setNow: (iso) => { now = new Date(iso); },
    mail: { send: async (m) => { sent.push(m); } },
    dashboardUrl: 'https://homebase.samnichols.dev/',
    secret: 'test-secret',
  };
  return { ctx, store, sent };
}
