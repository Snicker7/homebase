// Every query the bank side runs. Callers pass a postgres.js handle; nothing
// here decides anything, it just reads and writes rows.

export async function storeAccessToken(sql, itemId, token) {
  const [row] = await sql`select vault.create_secret(${token}, ${'plaid:' + itemId}) as id`;
  return row.id;
}

export async function readAccessToken(sql, vaultId) {
  const [row] = await sql`select decrypted_secret from vault.decrypted_secrets where id = ${vaultId}`;
  if (!row) throw new Error('access token missing from vault');
  return row.decrypted_secret;
}

export async function insertItem(sql, { id, institution, accessTokenId, linkedBy }) {
  await sql`
    insert into plaid_items (id, institution, access_token_id, linked_by)
    values (${id}, ${institution || ''}, ${accessTokenId}, ${linkedBy})
    on conflict (id) do update set institution = excluded.institution, access_token_id = excluded.access_token_id, status = 'ok', error = ''`;
}

export async function listItems(sql, itemId) {
  return itemId
    ? sql`select id, institution, access_token_id, cursor, status, error, linked_by, last_synced_at from plaid_items where id = ${itemId}`
    : sql`select id, institution, access_token_id, cursor, status, error, linked_by, last_synced_at from plaid_items order by institution, id`;
}

export async function upsertAccounts(sql, rows) {
  for (const a of rows) {
    await sql`
      insert into accounts (id, item_id, name, type, subtype, mask, current_balance, balance_as_of)
      values (${a.id}, ${a.item_id}, ${a.name}, ${a.type}, ${a.subtype}, ${a.mask}, ${a.current_balance}, ${a.balance_as_of})
      on conflict (id) do update set name = excluded.name, type = excluded.type, subtype = excluded.subtype,
        mask = excluded.mask, current_balance = excluded.current_balance, balance_as_of = excluded.balance_as_of`;
  }
}

// One transaction for the whole run: rows and cursor land together or not at all.
export async function applySync(sql, itemId, plan, cursor) {
  await sql.begin(async (tx) => {
    for (const r of plan.inserts) {
      // A re-sent id keeps whatever category and note it already has.
      await tx`
        insert into transactions (id, account_id, date, amount, merchant, pending, plaid_category, category_id, categorized_by)
        values (${r.id}, ${r.account_id}, ${r.date}, ${r.amount}, ${r.merchant}, ${r.pending}, ${r.plaid_category}, ${r.category_id}, ${r.categorized_by})
        on conflict (id) do update set date = excluded.date, amount = excluded.amount, merchant = excluded.merchant,
          pending = excluded.pending, plaid_category = excluded.plaid_category, removed_at = null`;
    }
    for (const r of plan.updates) {
      await tx`
        update transactions set date = ${r.date}, amount = ${r.amount}, merchant = ${r.merchant},
          pending = ${r.pending}, plaid_category = ${r.plaid_category}
        where id = ${r.id}`;
    }
    if (plan.removals.length) {
      await tx`update transactions set removed_at = now() where id = any(${plan.removals}) and removed_at is null`;
    }
    await tx`update plaid_items set cursor = ${cursor}, status = 'ok', error = '', last_synced_at = now() where id = ${itemId}`;
  });
}

export async function failSync(sql, itemId, status, message) {
  await sql`update plaid_items set status = ${status}, error = ${String(message || '').slice(0, 500)} where id = ${itemId}`;
}

export async function loadRules(sql) {
  return sql`select id, pattern, category_id, priority from category_rules order by priority, id`;
}

// Returns the merchant so the caller can turn it into a rule; null when the id is unknown.
export async function categorize(sql, { id, categoryId, note }) {
  const rows = await sql`
    update transactions set category_id = ${categoryId}, categorized_by = 'user', note = ${note || ''}
    where id = ${id} returning merchant`;
  return rows[0] || null;
}

export async function addRule(sql, { pattern, categoryId }) {
  await sql`insert into category_rules (pattern, category_id) values (${pattern}, ${categoryId})`;
}

export async function addCategory(sql, { id, name, emoji, kind }) {
  await sql`insert into budget_categories (id, name, emoji, kind) values (${id}, ${name}, ${emoji || ''}, ${kind})`;
}
