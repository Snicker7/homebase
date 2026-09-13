// Every query the calendar runs. Callers pass a postgres.js handle; nothing
// here decides anything, it just reads and writes rows.

// Series overlapping a window: a repeating event that started years ago still
// counts, a one-off that happened years ago does not.
export async function listSeries(sql, from, to) {
  const rows = await sql`
    select id, title, notes, category_id, to_char(day, 'YYYY-MM-DD') as day,
           to_char(time, 'HH24:MI') as time, minutes, repeat,
           to_char(repeat_until, 'YYYY-MM-DD') as repeat_until
      from events
     where day <= ${to}
       and (case when repeat is null then day >= ${from}
                 else repeat_until is null or repeat_until >= ${from} end)
     order by day, id`;
  return rows.map((r) => ({
    id: r.id, title: r.title, notes: r.notes, categoryId: r.category_id,
    day: r.day, time: r.time, minutes: r.minutes,
    repeat: r.repeat, repeatUntil: r.repeat_until,
  }));
}

export async function listExceptions(sql, eventIds) {
  if (!eventIds.length) return [];
  const rows = await sql`
    select event_id, to_char(day, 'YYYY-MM-DD') as day, skipped, override
      from event_exceptions where event_id = any(${eventIds})`;
  return rows.map((r) => ({ eventId: r.event_id, day: r.day, skipped: r.skipped, override: r.override }));
}

export async function saveEvent(sql, ev) {
  const repeat = ev.repeat ? sql.json(ev.repeat) : null;
  if (ev.id) {
    const [row] = await sql`
      update events set title = ${ev.title}, notes = ${ev.notes}, category_id = ${ev.categoryId},
             day = ${ev.day}, time = ${ev.time}, minutes = ${ev.minutes},
             repeat = ${repeat}, repeat_until = ${ev.repeatUntil}, updated_at = now()
       where id = ${ev.id} returning id`;
    return row ? row.id : null;
  }
  const [row] = await sql`
    insert into events (title, notes, category_id, day, time, minutes, repeat, repeat_until, created_by)
    values (${ev.title}, ${ev.notes}, ${ev.categoryId}, ${ev.day}, ${ev.time}, ${ev.minutes},
            ${repeat}, ${ev.repeatUntil}, ${ev.user})
    returning id`;
  return row.id;
}

export async function deleteEvent(sql, id) {
  const rows = await sql`delete from events where id = ${id} returning id`;
  return rows.length > 0;
}

// One row per changed occurrence, keyed by the date the rule produced. Saving
// over an existing exception replaces it, so skip-then-edit behaves.
export async function saveOccurrence(sql, o) {
  const rows = await sql`
    insert into event_exceptions (event_id, day, skipped, override)
    values (${o.eventId}, ${o.day}, ${o.skipped}, ${o.override ? sql.json(o.override) : null})
    on conflict (event_id, day) do update set skipped = excluded.skipped, override = excluded.override
    returning event_id`;
  return rows.length > 0;
}

// The update list leaves `sort` alone: a color or name edit is not a reorder,
// and rewriting it would collapse the seeded order to one value. `active` comes
// back on, so adding a category by the name of a retired one un-retires it
// rather than silently updating a row that stays hidden.
export async function saveCategory(sql, c) {
  const sort = c.sort == null ? 100 : c.sort;
  await sql`
    insert into event_categories (id, name, color, sort) values (${c.id}, ${c.name}, ${c.color}, ${sort})
    on conflict (id) do update set name = excluded.name, color = excluded.color, active = true`;
}

// Retiring keeps the events that already point at the category; only the picker
// loses it. Deleting is left to the SQL editor, where the consequences are visible.
export async function retireCategory(sql, id) {
  const rows = await sql`update event_categories set active = false where id = ${id} and not system returning id`;
  return rows.length > 0;
}

export async function listOfficeItems(sql, from, to) {
  return sql`
    select id, kind, brand, slug, business, title, to_char(day, 'YYYY-MM-DD') as day,
           to_char(time, 'HH24:MI') as time, minutes, done, waits_on_client, source,
           stage, project, repeat, link, url, fetched_at
      from office_items where day >= ${from} and day <= ${to} order by day, time nulls first, id`;
}

// The window is the unit of truth: whatever the feed returned for it replaces
// whatever was there, so a deleted or rescheduled office item leaves the calendar.
export async function replaceOfficeWindow(sql, rows, from, to) {
  await sql.begin(async (tx) => {
    for (const r of rows) {
      await tx`
        insert into office_items (id, kind, brand, slug, business, title, day, time, minutes, done,
                                  waits_on_client, source, stage, project, repeat, link, url, fetched_at)
        values (${r.id}, ${r.kind}, ${r.brand}, ${r.slug}, ${r.business}, ${r.title}, ${r.day}, ${r.time},
                ${r.minutes}, ${r.done}, ${r.waits_on_client}, ${r.source}, ${r.stage}, ${r.project},
                ${r.repeat}, ${r.link}, ${r.url}, now())
        on conflict (id) do update set kind = excluded.kind, brand = excluded.brand, slug = excluded.slug,
          business = excluded.business, title = excluded.title, day = excluded.day, time = excluded.time,
          minutes = excluded.minutes, done = excluded.done, waits_on_client = excluded.waits_on_client,
          source = excluded.source, stage = excluded.stage, project = excluded.project,
          repeat = excluded.repeat, link = excluded.link, url = excluded.url, fetched_at = now()`;
    }
    const keep = rows.map((r) => r.id);
    // An empty feed window is normal, and postgres.js cannot type an empty
    // array for any(); delete the window outright instead.
    if (keep.length) {
      await tx`delete from office_items where day >= ${from} and day <= ${to} and not (id = any(${keep}))`;
    } else {
      await tx`delete from office_items where day >= ${from} and day <= ${to}`;
    }
  });
}
