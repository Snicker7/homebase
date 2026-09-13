# Office calendar feed: handoff for the homebase calendar

This file is for the agent building the family calendar in the `homebase`
repo (homebase.samnichols.dev, Supabase). It describes how that calendar
gets the Keepsite and Lova business items out of the office that runs at
`https://www.keepsitemedia.com/office/`, what those items look like, and
what is and is not built yet.

Written 2026-09-13 from the `office-additions` branch of the `keepsite`
repo. The office's own docs are that repo's `README.md` ("The office")
and `docs/superpowers/specs/2026-09-12-office-two-brands-design.md`.

## Status, read this first

| Piece | State |
|---|---|
| The office (clients, tasks, meetings, own tasks, contacts) | Built and running for Keepsite. |
| Lova inside the same office (brand field, switcher, her domain, her Stripe) | Designed, not built. Phases 3 to 5 of the spec above. Until phase 3 lands every item is Keepsite's. |
| The feed endpoint described below | Built on the `office-additions` branch; live once that branch deploys and `KEEPSITE_FEED_TOKEN` is set in Netlify. |

Do not try to log the homebase browser into the office. The office sits
behind Netlify Identity with a session cookie and a CSRF token, and the
homebase frontend is a static site on GitHub Pages. The feed is a
separate, token-authenticated JSON route for machines.

## The two businesses, in one office

Keepsite Media (Sam) and Lova Content Creation (Sierra) are run from the
same office at keepsitemedia.com/office. Both owners are admins and see
both businesses, with a Keepsite / Lova / All switcher. Every client,
pipeline, agreement template and payment carries a `brand` of
`keepsite` or `lova`. Two kinds of item are brand-free: **own tasks**
(business work with no client, stored under the reserved client slug
`office`) and **contacts** (partners, referral sources, vendors; not in
the feed, they have no dates).

What the calendar cares about:

- **Tasks.** Each belongs to a client (slug) or is an own task (slug
  `office`). Has a due day, an optional time, done or not. Pipeline tasks
  are created automatically when a client enters a stage; some of them
  wait on the client (a questionnaire, a signature, a payment) rather
  than on the owner.
- **Meetings.** Each belongs to a client. Day, time, length in minutes,
  an optional video link.

Days are `YYYY-MM-DD` strings and times are `HH:MM`, both in
**America/Denver**. The office never stores instants for these; it
stores the wall-clock day and time the owner typed.

## The feed contract

### Read

```
GET https://www.keepsitemedia.com/office/api/feed?from=2026-09-01&to=2026-10-31
Authorization: Bearer <KEEPSITE_FEED_TOKEN>
Accept: application/json
```

- `from` and `to` are inclusive days. Both optional; default is 30 days
  back to 90 days ahead. Anything else is 400.
- Done tasks are included when they fall in the window, with `done: true`,
  so the calendar can show them struck through if it wants.
- `brand` is optional: `?brand=keepsite` or `?brand=lova` filters; omitted
  means both. Own tasks (`slug: "office"`) come back under every brand
  filter because they belong to neither.
- Wrong or missing token: 401 with no body. The token is one long random
  string held as the Netlify env var `KEEPSITE_FEED_TOKEN` on the
  keepsite site and as a Supabase function secret on the homebase side.
  It is never sent to a browser.
- Response is `application/json`, `Cache-Control: private, no-store`.

Response shape:

```json
{
  "generatedAt": "2026-09-13T15:02:11.000Z",
  "timezone": "America/Denver",
  "office": "https://www.keepsitemedia.com/office/",
  "items": [
    {
      "kind": "task",
      "id": "20260912T171530abcdef",
      "brand": "keepsite",
      "slug": "sapphire-stem-floral",
      "business": "Sapphire Stem Floral",
      "title": "Layouts approved",
      "due": "2026-09-15",
      "time": null,
      "done": false,
      "waitsOnClient": false,
      "source": "pipeline",
      "stage": "layouts",
      "project": null,
      "repeat": null,
      "url": "https://www.keepsitemedia.com/office/clients/sapphire-stem-floral/?tab=tasks"
    },
    {
      "kind": "task",
      "id": "20260912T180001qrstuv",
      "brand": null,
      "slug": "office",
      "business": null,
      "title": "Post on LinkedIn",
      "due": "2026-09-19",
      "time": "09:00",
      "done": false,
      "waitsOnClient": false,
      "source": "manual",
      "stage": null,
      "project": "Marketing",
      "repeat": "weekly",
      "url": "https://www.keepsitemedia.com/office/tasks/"
    },
    {
      "kind": "meeting",
      "id": "20260910T140000mnopqr",
      "brand": "keepsite",
      "slug": "hollow-oak-cabinetry",
      "business": "Hollow Oak Cabinetry",
      "title": "Kickoff call",
      "ymd": "2026-09-16",
      "time": "10:00",
      "minutes": 30,
      "link": "https://meet.google.com/abc-defg-hij",
      "url": "https://www.keepsitemedia.com/office/clients/hollow-oak-cabinetry/?tab=meetings"
    }
  ]
}
```

Field notes:

- `id` is a 21-character string, sortable by creation time
  (`YYYYMMDDTHHMMSS` plus six base32 characters). Stable for the life of
  the record.
- `brand` is `"keepsite"`, `"lova"`, or `null` for own tasks. Until phase
  3 ships every client item is `"keepsite"`.
- `business` is the client's company name, or `null` for own tasks.
- `waitsOnClient` is true for pipeline tasks that wait on the client (a
  questionnaire back, a signature, a payment). The office shows those
  under "Waiting on clients" rather than "On you"; the family calendar
  probably wants to hide or dim them.
- `source` is `"pipeline"` or `"manual"`; `stage` is the pipeline stage id
  that created a pipeline task, else null.
- `project` is only ever set on own tasks. `repeat` is `"weekly"`,
  `"biweekly"`, `"monthly"`, `"quarterly"`, `"yearly"` or null; own tasks
  and some pipeline tasks carry one.
- `url` is the office page where the item can be acted on. Opening it
  needs an office login; that is fine, both owners have one.
- Meetings have `ymd` where tasks have `due`; the office names them that
  way and the feed keeps the names.

### ICS alternative

The same route with `Accept: text/calendar` or `?format=ics` returns one
VCALENDAR with a VEVENT per item (all-day for a task with no time, timed
in `America/Denver` otherwise, meetings with their duration). `UID` is
`<id>@keepsitemedia.com`. Use this only if a subscribed calendar is
wanted somewhere else; homebase should use the JSON.

### Write (own tasks only)

```
POST https://www.keepsitemedia.com/office/api/feed
Authorization: Bearer <KEEPSITE_FEED_TOKEN>
Content-Type: application/json

{ "op": "add", "title": "Renew domain", "due": "2026-10-01", "time": null, "project": "Admin", "repeat": null, "notes": "" }
{ "op": "done", "id": "20260912T180001qrstuv" }
{ "op": "reopen", "id": "20260912T180001qrstuv" }
```

- `add` creates an own task (slug `office`) and returns the created item
  in the read shape. `title` and `due` are required; `repeat` must be
  `weekly`, `biweekly`, `monthly`, `quarterly`, `yearly` or null. Marking
  a repeating task done creates the next one exactly as the office's own
  Done button does, including the rule that a pipeline task rolls forward
  only while its client is still in the stage that created it.
- `done` and `reopen` work on any task id in the feed, client tasks too,
  because the owner is the same person either way. `delete` is not
  offered; do that in the office.
- Client tasks and meetings are not creatable from the feed. They belong
  to a client's pipeline and a client's page.
- Errors are 400 with `{ "error": "..." }`; unknown id is 404.

## How homebase should consume it

Homebase's architecture is "reads go straight to Postgres under RLS,
writes go through an edge function, the browser never holds a secret".
Fit the feed into that:

1. **Import on a schedule.** The hourly `dispatch` function (already
   scheduled by pg_cron) fetches the feed with the token from a function
   secret named `KEEPSITE_FEED_TOKEN` and upserts rows into a new
   `office_items` table keyed by `id`, deleting rows no longer returned
   in the window. Keep the columns close to the JSON: `kind`, `brand`,
   `slug`, `business`, `title`, `day` (from `due` or `ymd`), `time`,
   `minutes`, `done`, `waits_on_client`, `source`, `stage`, `project`,
   `repeat`, `link`, `url`, `fetched_at`.
2. **Read under RLS.** The calendar view reads `office_items` with
   supabase-js like every other table. Both people can read it.
3. **On-demand refresh and writes.** Add `officeRefresh`, `officeAddTask`
   and `officeSetDone` actions to the `api` edge function. Each calls the
   feed with the secret, then re-imports the window so the table is
   current before the browser re-reads. The browser never sees the token.
4. **Time zone.** Treat `day` and `time` as Mountain wall-clock. Do not
   convert them; homebase's users are in the same zone as the office.
5. **Rendering.** Suggested: colour by `brand` (Keepsite, Lova, own),
   dim `waits_on_client` items, strike `done`, show `business` as the
   line above `title`, and link `url` out to the office. Meetings show
   their time range from `time` plus `minutes`.

## What exists today that the keepsite side builds on

For whoever adds the feed route in the keepsite repo (this is not for
the homebase agent, but it explains why the contract looks the way it
does):

- Tasks and meetings are read with `store().tasks.listAll()` and
  `store().meetings.listAll()` in `netlify/functions/lib/office/store.mjs`;
  client names come from `store().clients.list()`.
- `waitsOnClient(task)` is in `attention.mjs`; the ICS builder is
  `ics.mjs`; own-task creation and Done live in `actions/task.mjs`
  (`OWN_SLUG` from `clients.mjs`, recurrence in `recurrence.mjs`).
- Every `/office/` path is guarded by the middleware through `guard.mjs`;
  the feed route has to be listed as public there and check the bearer
  token itself, the way `/sign/` and the questionnaire function check
  their own tokens.
- Netlify env vars are documented in `README.md` under "The office";
  `KEEPSITE_FEED_TOKEN` joins that table.

## Names and addresses

| Thing | Value |
|---|---|
| Office | `https://www.keepsitemedia.com/office/` |
| Feed | `https://www.keepsitemedia.com/office/api/feed` |
| Brands | `keepsite`, `lova` (lova arrives with phase 3) |
| Own-task slug | `office` |
| Time zone | `America/Denver` |
| Token | `KEEPSITE_FEED_TOKEN` on both sides |
| Lova's client-facing domain | Not chosen yet; irrelevant to the feed, all office data lives at keepsitemedia.com |
