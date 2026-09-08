// Synchronous, in-memory view of the tables an action needs, plus a journal of
// every write. The ported Apps Script logic stays synchronous and near
// verbatim; pg.js turns the journal into SQL inside one transaction.

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function normRow(r) {
  return {
    id: r.id,
    timestamp: r.timestamp instanceof Date ? new Date(r.timestamp) : new Date(r.timestamp),
    type: r.type,
    category: r.category == null ? '' : String(r.category),
    periodKey: r.periodKey == null ? '' : String(r.periodKey),
    result: r.result == null ? '' : String(r.result),
    freezeUsed: r.freezeUsed === true,
    amount: Number(r.amount) || 0,
    balanceAfter: r.balanceAfter === '' || r.balanceAfter == null ? '' : Number(r.balanceAfter),
    actor: r.actor == null ? '' : String(r.actor),
    note: r.note == null ? '' : String(r.note),
  };
}

export function createStore(snapshot) {
  const people = snapshot.people.map((p) => ({ email: String(p.email).toLowerCase(), name: p.name }));
  let categories = clone(snapshot.categories || []);
  const ledger = (snapshot.ledger || []).map(normRow);
  const habit = {};
  for (const r of snapshot.habitStates || []) {
    (habit[r.actor] ||= {})[r.category] = clone(r.state);
  }
  const chores = {};
  for (const r of snapshot.choreStates || []) chores[r.category] = clone(r.state);
  const settings = clone(snapshot.settings || {});
  const holidays = new Set(snapshot.holidays || []);
  const journal = [];

  return {
    allowlist: () => people.map((p) => p.email),
    displayName(email) {
      const p = people.find((x) => x.email === String(email || '').toLowerCase());
      return p ? p.name : String(email || '').split('@')[0];
    },
    partnerOf(email) {
      const self = String(email || '').toLowerCase();
      const p = people.find((x) => x.email !== self);
      return p ? p.email : null;
    },

    categoriesAll: () => clone(categories),
    saveCategories(list) {
      categories = clone(list);
      journal.push({ op: 'categories', list: clone(list) });
    },

    statesAll() {
      const m = {};
      for (const actor of Object.keys(habit)) m[actor] = { cats: clone(habit[actor]) };
      return m;
    },
    saveStatesAll(m) {
      for (const actor of Object.keys(m)) {
        const cats = (m[actor] && m[actor].cats) || {};
        for (const cat of Object.keys(cats)) {
          const before = habit[actor] && habit[actor][cat];
          if (JSON.stringify(before) === JSON.stringify(cats[cat])) continue;
          (habit[actor] ||= {})[cat] = clone(cats[cat]);
          journal.push({ op: 'habitState', actor, category: cat, state: clone(cats[cat]) });
        }
      }
    },

    choreStatesAll: () => clone(chores),
    saveChoreStates(m) {
      for (const cat of Object.keys(m)) {
        if (JSON.stringify(chores[cat]) === JSON.stringify(m[cat])) continue;
        chores[cat] = clone(m[cat]);
        journal.push({ op: 'choreState', category: cat, state: clone(m[cat]) });
      }
    },

    getSetting: (key) => clone(settings[key]),
    setSetting(key, value) {
      settings[key] = clone(value);
      journal.push({ op: 'setting', key, value: clone(value) });
    },
    deleteSetting(key) {
      delete settings[key];
      journal.push({ op: 'setting', key, value: null });
    },

    isHoliday: (dateStr) => holidays.has(String(dateStr)),

    readLedgerRows: () => ledger.map((r) => ({ ...r, timestamp: new Date(r.timestamp) })),
    appendLedger(ev) {
      const row = normRow({ ...ev, id: crypto.randomUUID(), timestamp: ev.timestamp || new Date() });
      ledger.push(row);
      journal.push({ op: 'append', row: { ...row } });
      return row.id;
    },
    deleteLedgerRow(id) {
      const i = ledger.findIndex((r) => String(r.id) === String(id));
      if (i === -1) return false;
      ledger.splice(i, 1);
      journal.push({ op: 'delete', id: String(id) });
      return true;
    },
    updateLedgerRow(id, patch) {
      const row = ledger.find((r) => String(r.id) === String(id));
      if (!row) return false;
      Object.assign(row, normRow({ ...row, ...patch }));
      journal.push({ op: 'update', id: String(id), patch: clone(patch) });
      return true;
    },

    journal: () => clone(journal),
  };
}
