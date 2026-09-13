# Family calendar design

A shared calendar in Homebase that replaces Google Calendar for the two of
us, colors events by category, pulls the Keepsite and Lova business items
out of the office, and mails a three-day agenda every morning.

Phase 4. Builds on the habits, bank, and reports phases described in
`2026-09-08-homebase-design.md`.

## Goals

- Every family event lives in Homebase. Google Calendar is exported once and
  then abandoned, not synced.
- An event carries a category, and the category carries a color that reads
  in both the dark and light themes.
- Repeating events cover the household cases — weekly practice, monthly bill,
  birthdays — including deleting or changing a single occurrence.
- Business tasks and meetings from `keepsitemedia.com/office` appear beside
  family events, read-only, so one screen answers "what does the day look
  like".
- One email each morning lists today and the next two days.

## Decisions

| Question | Decision |
| --- | --- |
| Notifications | Email only, through Resend and the existing hourly `dispatch`. Today plus two days in one message. No SMS. |
| What appears | Family events and imported office items. Chores and habits stay on the dashboard. |
| Recurrence | Daily, weekly on chosen weekdays, monthly by date, yearly. Optional end date. Single occurrences can be skipped or overridden. No "this and all following". |
| Recurrence storage | One row per series plus exception rows. Occurrences are expanded on read by a shared pure module. Nothing is materialized. |
| Categories | A table, seeded and editable. Three reserved rows belong to the office importer. |
| Views | Agenda, month grid, single day. No week view. |
| Office integration | Read-only import this phase. The feed's write operations are left for later. |
| Google migration | A one-off `.ics` import script. No ongoing subscription. |
| Time zone | `America/Denver` wall-clock throughout. Days and times, never instants. |
| Writes | Through the `api` function on the bank-action path: direct SQL, no snapshot, no advisory lock. |

## Architecture

```
Browser (GitHub Pages)
  reads  ──► events, event_exceptions, event_categories, office_items
             via supabase-js under RLS, expanded by recur.js in the page
  writes ──► api function ──► caldb.js ──► Postgres
                          ──► office feed (officeRefresh)
Postgres cron ──► dispatch (hourly) ──► office import
                                    ──► calendar digest ──► Resend
```

Calendar writes carry no reward rule, so they take the same early branch in
`api/index.ts` that bank actions take: validate, run direct SQL, return.
They never load the snapshot and never take the advisory lock, which keeps
them off the habits path entirely.

### New files

| File | Job |
| --- | --- |
| `supabase/migrations/0004_calendar.sql` | The four tables, their indexes, RLS. |
| `supabase/tests/0004_calendar.sql` | Schema and RLS assertions. |
| `supabase/functions/_shared/recur.js` | Pure occurrence expansion. Imported by both the browser and `dispatch`. |
| `supabase/functions/_shared/recur.test.js` | The heaviest tests in the phase. |
| `supabase/functions/_shared/caldb.js` | Event and category SQL. |
| `supabase/functions/_shared/calactions.js` | Action list and validators. |
| `supabase/functions/_shared/officefeed.js` | Fetch, normalize, and upsert the office feed. |
| `supabase/functions/_shared/caldigest.js` | Gather three days and render the email. |
| `js/calendar.js` | The screen: agenda, month, day, editor. |
| `scripts/import-ics.js` | One-off Google Calendar import. |

`recur.js` is plain ES: no `npm:` specifiers, no Deno globals, no imports.
The browser loads it from `/supabase/functions/_shared/recur.js`, which
GitHub Pages serves because Pages publishes the repository root. One
implementation feeds the views, the digest, and the import script.

## Data model

### event_categories

| column | type | note |
| --- | --- | --- |
| id | text pk | slug |
| name | text | display name |
| color | text | `#rrggbb` |
| sort | int | display order |
| system | boolean | reserved for the importer; cannot be deleted |
| active | boolean | retired categories keep their events but leave the picker |

Seeded in `seed.sql`:

| id | name | color | system |
| --- | --- | --- | --- |
| `family` | Family | `#57c785` | no |
| `appointments` | Appointments | `#ef6f8e` | no |
| `school` | School | `#e8b84b` | no |
| `social` | Social | `#f2924b` | no |
| `travel` | Travel | `#3fbfae` | no |
| `birthdays` | Birthdays | `#c97ae0` | no |
| `keepsite` | Keepsite | `#7f8cf0` | yes |
| `lova` | Lova | `#5ec8f2` | yes |
| `office` | Office | `#8d9bb5` | yes |

Each color is checked against both `--card` values in `css/style.css`
(`#1d2356` dark, `#ffffff` light) during the build task and adjusted if it
fails to separate from the background or from its neighbors.

### events

One row per series. A one-off event is a series with `repeat` null.

| column | type | note |
| --- | --- | --- |
| id | uuid pk | `gen_random_uuid()` |
| title | text | required |
| notes | text | may be empty |
| category_id | text fk | `event_categories(id)` |
| day | date | the first occurrence |
| time | time | null means all-day |
| minutes | int | duration; null when all-day |
| repeat | jsonb | null means one-off |
| repeat_until | date | null means forever |
| created_by | text fk | `people(email)` |
| created_at | timestamptz | |
| updated_at | timestamptz | |

Indexed on `day` and on `category_id`.

### event_exceptions

| column | type | note |
| --- | --- | --- |
| event_id | uuid fk | `events(id)` on delete cascade |
| day | date | the **original** occurrence date |
| skipped | boolean | true means that occurrence is deleted |
| override | jsonb | changed `title`, `day`, `time`, `minutes`, `categoryId`, `notes` |

Primary key `(event_id, day)`. A row either skips or overrides; an override
may move the occurrence to a different `day`, which is how "drag this one
instance to Thursday" works without splitting the series.

### office_items

Owned entirely by the importer. Columns follow the feed contract in
`docs/office-calendar-feed.md`.

| column | type | from |
| --- | --- | --- |
| id | text pk | `id` |
| kind | text | `task` or `meeting` |
| brand | text | `keepsite`, `lova`, or null |
| slug | text | client slug, or `office` |
| business | text | client company name, or null |
| title | text | `title` |
| day | date | `due` for tasks, `ymd` for meetings |
| time | time | `time`, may be null |
| minutes | int | meetings only |
| done | boolean | tasks only |
| waits_on_client | boolean | `waitsOnClient` |
| source | text | `pipeline` or `manual` |
| stage | text | pipeline stage id, or null |
| project | text | own tasks only |
| repeat | text | `weekly`, `monthly`, or null; own tasks only |
| link | text | meeting video link |
| url | text | the office page for the item |
| fetched_at | timestamptz | when the import that wrote this row ran |

Indexed on `day`.

### Row-level security

All four tables enable RLS with a single `for select to authenticated using
(true)` policy, matching `members_read_budget_categories` in
`0002_budget.sql`. There are no client write policies. Writes arrive through
`api` on the service connection.

### Recurrence rules

`repeat` takes exactly four shapes:

```json
{"freq":"daily"}
{"freq":"weekly","days":[1,3,5]}
{"freq":"monthly","day":15}
{"freq":"yearly"}
```

`days` are ISO weekday numbers, Monday 1 through Sunday 7. `monthly.day` is
1 to 31. A yearly rule repeats the series' own month and day.

Two edges, settled here so the expansion has no judgement to make:

- A monthly rule on a day the month does not have **skips** that month. The
  31st does not slide to the 30th.
- A yearly rule on 29 February **skips** common years.

`repeat_until` is inclusive. `day` is always the first occurrence: a weekly
rule whose `days` do not include `day`'s weekday is rejected at validation
rather than silently shifted.

## Flows

### Reading a view

The screen computes a window — the visible month padded to whole weeks, or
the agenda's current horizon — and reads three tables under RLS. The first two
go in parallel; the third waits, because it needs the event ids the first one
returns:

1. `events` where `day <= window.to`, and either the event repeats and its
   `repeat_until` is null or on or after `window.from`, or the event is a
   one-off whose `day` is on or after `window.from`. A past one-off must not
   come back; a series that started years ago must.
2. `office_items` where `day` is inside the window.
3. `event_exceptions` for the event ids read 1 returned.

`recur.expand()` turns series and exceptions into occurrences. Office items
are mapped into the same occurrence shape with a `readOnly` flag, their
category taken from `brand` (`keepsite`, `lova`, or `office` when brand is
null). The merged list is sorted by day, then all-day before timed, then
time, then title. Every renderer consumes that one list.

### Saving an event

The editor posts `eventSave` with the whole event. `calactions.js` validates
title, date, time, duration, category, and the `repeat` shape, then
`caldb.js` inserts or updates one row. Editing a series does not touch its
exception rows; they stay keyed to original dates.

### Changing one occurrence

Editing or deleting an occurrence of a repeating event asks which is meant.

- *Just this one*, deleted: `occurrenceSkip` writes `skipped = true`.
- *Just this one*, edited: `occurrenceSave` writes an `override`.
- *The whole series*: `eventSave` or `eventDelete`. Deleting the series
  cascades its exceptions away.

A one-off event skips the question entirely.

### Importing the office feed

Hourly, inside `dispatch`, and on demand through `officeRefresh`:

1. `GET https://www.keepsitemedia.com/office/api/feed` with
   `Authorization: Bearer $KEEPSITE_FEED_TOKEN` and an explicit `from`/`to` of
   30 days back to 90 ahead. That matches the feed's own default, but the
   delete step in 4 has to know exactly which window it is replacing, so the
   window is stated rather than assumed.
2. Normalize each item: `due` or `ymd` becomes `day`, camelCase becomes
   snake_case, missing fields become null.
3. Upsert every item by `id`, stamping `fetched_at`.
4. Delete rows whose `day` falls inside the imported window and whose `id`
   did not come back, which is how a deleted or rescheduled office item
   leaves the calendar.

Rows outside the window are left alone, so an old item eleven months back
stays until it is manually cleared.

### The morning email

`dispatch` runs hourly and already gates the chore digest on the Denver
hour. The calendar digest uses the same clock and a new setting,
`calendarDigestTime`, defaulting to `07:00`.

It runs after `runAction` returns, because `events` is not part of the
snapshot `loadSnapshot` builds. `caldigest.js` reads the three days, expands
them, merges office items, and renders. Each person in `people` gets the
same message.

Three sections: Today, Tomorrow, and the third day by weekday name. Each
item shows its category color as an inline-styled left bar — email has no
custom properties, so the hex is written into the markup — then the time or
"All day", then the title, with the business name above the title for office
items.

Office items that wait on the client and tasks already done are excluded
from the email; they are calendar texture, not morning reading. If all three
days are empty, nothing sends.

## Frontend

| Route | View |
| --- | --- |
| `#/calendar` | Agenda from today, extending as it scrolls |
| `#/calendar/month` | Current month grid |
| `#/calendar/month/2026-09` | That month's grid |
| `#/calendar/day/2026-09-15` | That single day |

`route()` in `js/app.js` gains these four; `index.html` gains a
`navCalendar` link hidden unless signed in, exactly as `navInbox`,
`navAccounts`, and `navBudget` are handled.

The month grid shows up to three colored bars per cell with a "+2" overflow
marker. Tapping a cell opens that day. The day view lists all-day items
first, then timed items with their ranges. The editor is a panel in the
idiom `js/inbox.js` uses, which already avoids the controls that behave
badly on a phone.

A category's color drives a 4px left bar at full strength. Filled
surfaces use `color-mix(in oklab, var(--cat) 18%, var(--card))` so a
category tints its row rather than fighting the theme.

Office items render dimmed when `waits_on_client` is true and struck through
when `done`. They have no editor; tapping one opens its `url` in a new tab.
The calendar screen shows the age of the import from `fetched_at` with a
button that calls `officeRefresh`.

## Security

- The feed token is a Supabase function secret, `KEEPSITE_FEED_TOKEN`. It is
  read only inside `api` and `dispatch`, and never reaches the browser.
- `officeRefresh` is an authenticated action like every other, so only the
  two of us can trigger a fetch.
- The four tables are readable by any authenticated user and writable by
  none, which for a two-person allowlisted app is the same thing as
  "both of us, and nobody else".
- The `.ics` import script runs locally against a connection string and is
  never deployed.

## Failure handling

- A feed fetch that returns 401 or times out is reported in the `dispatch`
  result, exactly as a failed send is, so the cron hour shows red. The
  existing `office_items` rows stay put and the calendar keeps rendering
  them with a stale `fetched_at`.
- The morning email does not depend on the import succeeding. Family events
  are read from Postgres; the office section is whatever was last imported.
- A malformed feed item is skipped and named in the failure list rather than
  aborting the import.
- `recur.expand()` is bounded: it stops at the window's end and refuses a
  window wider than five years, so a bad `repeat_until` cannot spin.

## Testing

- `recur.test.js` covers weekly rules spanning both DST boundaries, monthly
  on the 31st, yearly on 29 February, inclusive `repeat_until`, skips,
  overrides that move a day, and the window bound.
- `calactions.test.js` covers every validator rejection, including the
  weekly rule whose `days` omit the start weekday.
- `officefeed.test.js` runs the sample payload from
  `docs/office-calendar-feed.md` through an injected `fetchImpl`, the way
  `mail.test.js` fakes Resend, and asserts both the upsert and the deletion
  of vanished ids.
- `caldigest.test.js` renders fixtures: a full day, an empty three days, and
  a day of nothing but waiting-on-client items.
- `supabase/tests/0004_calendar.sql` asserts the schema and that an
  anonymous read returns nothing.
- The screen is tested by hand, as the rest of the frontend is.

## Migration from Google Calendar

1. Export each Google calendar as `.ics` from its settings page.
2. Dry run: `node scripts/import-ics.js --file family.ics --category family
   --db "$PROD_DB_URL"`, repeated per file.
3. The script parses each `VEVENT`, treats `DTSTART;VALUE=DATE` as all-day,
   maps `RRULE` onto the four supported rules, converts `EXDATE` into
   skipped exceptions, and assumes `America/Denver` for floating times.
4. Anything it cannot express — an nth-weekday rule, a `COUNT`, a
   `BYSETPOS` — is printed with its summary and date and left out, to be
   re-entered by hand. The count of skipped events is the last line of the
   report.
5. Re-run with `--apply`. Spot-check a birthday, a weekly event, and an
   event with a deleted occurrence.
6. Turn off Google Calendar notifications so the morning email is the only
   one.

## Phasing

One implementation plan, built in this order. The calendar is usable for
family events after task 4; the office and the email are additive.

1. Migration, seed rows, SQL tests.
2. `recur.js` and its tests.
3. `caldb.js`, `calactions.js`, `api` routing.
4. `js/calendar.js`: agenda, month, day, editor, category admin.
5. `officefeed.js`, the hourly import in `dispatch`, `officeRefresh`.
6. `caldigest.js` and the morning email.
7. `scripts/import-ics.js`.
8. README: the `KEEPSITE_FEED_TOKEN` secret, `calendarDigestTime`, and the
   phase 4 setup steps.

## Assumptions

- The office feed ships from the `keepsite` repo's `office-additions` branch
  with `KEEPSITE_FEED_TOKEN` set in Netlify. Until it deploys, the importer
  logs a failed fetch each hour and `office_items` stays empty; nothing else
  in the calendar depends on it.
- Until Lova phase 3 lands on the keepsite side, every client item arrives
  with `brand: "keepsite"`, so the Lova category stays unused and empty.
- Both of us are in `America/Denver`, as is the office. No travelling-across-
  zones handling is built.
- Events are shared. There is no private or per-person calendar, because
  there are two of us and one household.
- Attachments, guests, invitations, and RSVP are out of scope. This replaces
  a household calendar, not a scheduling product.

## Sources

- `docs/office-calendar-feed.md`, the feed contract, written 2026-09-13 from
  the `keepsite` repo's `office-additions` branch.
- `docs/superpowers/specs/2026-09-08-homebase-design.md`, phases 1 to 3.
- [RFC 5545](https://datatracker.ietf.org/doc/html/rfc5545), for the `.ics`
  subset the import script reads.
