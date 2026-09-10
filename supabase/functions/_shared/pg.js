import { createStore } from './store.js';

const LOCK_KEY = 7461;

export async function loadSnapshot(sql) {
  const [people, cats, ledger, habit, chores, settings, holidays, walletSpend] = await Promise.all([
    sql`select email, name from people order by email`,
    sql`select config from categories order by id`,
    sql`select id, ts, type, category, period_key, result, freeze_used, amount, balance_after, actor, note from ledger order by ts, id`,
    sql`select actor, category, state from habit_state`,
    sql`select category, state from chore_state`,
    sql`select key, value from settings`,
    sql`select to_char(day, 'YYYY-MM-DD') as day from holidays`,
    // Card transactions filed to a person's wallet: rows, so the activity feed
    // can list each one and re-derive the running balance across both sources.
    sql`select t.id, to_char(t.date, 'YYYY-MM-DD') as date, t.amount, t.merchant,
               bc.wallet_owner as actor
          from transactions t
          join budget_categories bc on bc.id = t.category_id
         where bc.kind = 'wallet' and t.removed_at is null
         order by t.date, t.id`,
  ]);
  return {
    people,
    categories: cats.map((r) => r.config),
    ledger: ledger.map((r) => ({
      id: r.id, timestamp: r.ts, type: r.type, category: r.category, periodKey: r.period_key,
      result: r.result, freezeUsed: r.freeze_used, amount: Number(r.amount),
      balanceAfter: r.balance_after == null ? '' : Number(r.balance_after), actor: r.actor, note: r.note,
    })),
    habitStates: habit.map((r) => ({ actor: r.actor, category: r.category, state: r.state })),
    choreStates: chores.map((r) => ({ category: r.category, state: r.state })),
    settings: Object.fromEntries(settings.map((r) => [r.key, r.value])),
    holidays: holidays.map((r) => r.day),
    walletTxns: walletSpend.map((r) => ({
      actor: r.actor, id: r.id, date: r.date, amount: Number(r.amount), merchant: r.merchant,
    })),
  };
}

const COL = { freezeUsed: 'freeze_used', amount: 'amount', balanceAfter: 'balance_after', result: 'result', periodKey: 'period_key', note: 'note' };

export async function applyJournal(sql, journal) {
  for (const e of journal) {
    switch (e.op) {
      case 'append': {
        const r = e.row;
        await sql`insert into ledger (id, ts, type, category, period_key, result, freeze_used, amount, balance_after, actor, note)
          values (${r.id}, ${r.timestamp}, ${r.type}, ${r.category || null}, ${r.periodKey || null}, ${r.result || null},
                  ${r.freezeUsed === true}, ${r.amount}, ${r.balanceAfter === '' ? null : r.balanceAfter}, ${r.actor}, ${r.note || ''})`;
        break;
      }
      case 'update': {
        const patch = {};
        for (const k of Object.keys(e.patch)) {
          if (!COL[k]) continue;
          let v = e.patch[k];
          if (k === 'balanceAfter' && v === '') v = null;
          patch[COL[k]] = v;
        }
        if (Object.keys(patch).length) await sql`update ledger set ${sql(patch)} where id = ${e.id}`;
        break;
      }
      case 'delete':
        await sql`delete from ledger where id = ${e.id}`;
        break;
      case 'habitState':
        await sql`insert into habit_state (actor, category, state) values (${e.actor}, ${e.category}, ${sql.json(e.state)})
          on conflict (actor, category) do update set state = excluded.state`;
        break;
      case 'choreState':
        await sql`insert into chore_state (category, state) values (${e.category}, ${sql.json(e.state)})
          on conflict (category) do update set state = excluded.state`;
        break;
      case 'categories': {
        const ids = e.list.map((c) => c.id);
        for (const c of e.list) {
          await sql`insert into categories (id, kind, name, active, config, updated_at)
            values (${c.id}, ${c.kind === 'chore' ? 'chore' : 'habit'}, ${c.name}, ${c.active !== false}, ${sql.json(c)}, now())
            on conflict (id) do update set kind = excluded.kind, name = excluded.name, active = excluded.active, config = excluded.config, updated_at = now()`;
        }
        if (ids.length) await sql`delete from categories where id <> all(${ids})`;
        else await sql`delete from categories`;
        break;
      }
      case 'setting':
        if (e.value === null) await sql`delete from settings where key = ${e.key}`;
        else await sql`insert into settings (key, value) values (${e.key}, ${sql.json(e.value)}) on conflict (key) do update set value = excluded.value`;
        break;
      default:
        throw new Error('unknown journal op ' + e.op);
    }
  }
}

// One action, one transaction, serialized across all callers by an advisory
// lock so two simultaneous requests can't double-record or clobber saves.
// `marks`, when given, collects phase timestamps (ms) so callers can report
// where a slow request spent its time.
export async function runAction(sql, fn, marks) {
  const mark = (k) => { if (marks) marks[k] = Date.now(); };
  mark('begin');
  return sql.begin(async (tx) => {
    mark('connected');
    await tx`select pg_advisory_xact_lock(${LOCK_KEY})`;
    mark('locked');
    const store = createStore(await loadSnapshot(tx));
    mark('loaded');
    const result = await fn(store);
    mark('acted');
    await applyJournal(tx, store.journal());
    mark('applied');
    return result;
  });
}
