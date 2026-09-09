# Homebase design

Homebase replaces the Apps Script habits app and adds a budgeting module.
Two users, personal use, one login each. Served from `homebase.samnichols.dev`
out of the `homebase` repo; backed by Supabase.

## Goals

- Habits app behaves exactly as today but responds in tens of milliseconds
  instead of one to two seconds per action.
- Bank transactions arrive automatically from Plaid and are categorized once.
- Each budget category shows a trailing average and flags when the current
  month is running ahead of it.
- The habits wallet becomes a rolling envelope in the budget: credited only by
  habit and chore payouts, debited by tagged bank transactions and cash spends,
  never cleared or topped up on a schedule.

## Decisions

| Question | Decision |
| --- | --- |
| Platform | Supabase: Postgres, auth, edge functions, cron. Free tier. |
| Hosting | Static site on GitHub Pages from the `homebase` repo at `homebase.samnichols.dev`. |
| Bank data | Plaid Trial plan. Ten Production Items for the account's lifetime, seven or fewer needed. |
| Budget style | Tracking with trailing averages and pace warnings. No envelopes except the wallet. |
| Notifications | Email via Resend, same reminder and one-tap check-up flow as today. |
| Frontend | Vanilla JavaScript, ES modules, no build step, hash router. |
| Rules | The existing `engine.js` and its 106 tests move over unchanged apart from the export line. |
| History | Migrated from the Sheet ledger and script properties. No reset. |
| Deposits | The "Add money" feature is removed. Migrated deposit rows stay in history. |

## Architecture

```
Browser (GitHub Pages)
  reads  ──► Supabase Postgres via supabase-js, row-level security
  writes ──► Supabase Edge Functions ──► Postgres
                                     ──► Resend (email)
                                     ──► Plaid (bank data)
Postgres cron ──► dispatch (hourly), plaid sync (4x daily)
```

Reads that carry no rules go straight to Postgres under row-level security.
Every write that runs a rule or touches a secret goes through an edge function.
The browser never holds the service key.

### Edge functions

| Function | Job |
| --- | --- |
| `api` | Every authenticated dashboard action, routed by an `action` field exactly as the Apps Script router is today: state, record, amend, deleteEntry, catHistory, claim, pauseChores, resumeChores, spend, and the category admin actions. |
| `checkup` | Verifies a signed one-tap token from a check-up email and runs the record path. Returns JSON the dashboard's check-in view renders. |
| `plaid` | Create Link token, exchange public token, update mode, sync transactions and balances. Phase 2. |
| `dispatch` | Hourly: reminders, check-up emails, freeze and bonus settlement at period rollover. |

All functions are Deno. The ported Apps Script logic lives in `_shared/service.js`
and runs synchronously against an in-memory snapshot of the tables; each
function loads the snapshot, runs the action, and writes the resulting journal
back inside one transaction under an advisory lock. That keeps the port close
to verbatim and lets the whole service run under Node's test runner with no
database.

### Repo layout

```
homebase/
  index.html
  css/
  js/                      ES modules by screen, hash router
    config.js              Supabase URL and anon key
  supabase/
    config.toml
    migrations/            numbered SQL, includes views and cron
    seed.sql               two people, wallet categories, transfer category
    tests/                 SQL assertions over a fixture ledger
    functions/
      _shared/engine.js    reward rules, unchanged
      _shared/service.js   ported Apps Script logic
      _shared/store.js     in-memory snapshot with a write journal
      _shared/pg.js        snapshot load and journal apply
      _shared/clock.js  token.js  mail.js  cors.js
      _shared/*.test.js
      api/ checkup/ dispatch/ plaid/
  scripts/
    migrate-from-sheet.js  one-off import
  docs/superpowers/        specs and plans
  CNAME                    homebase.samnichols.dev
```

## Data model

### Habits

**people** — one row per login. The ledger and state tables key on email, as
the Sheet does, so the port and the migration stay one to one.

| column | type | note |
| --- | --- | --- |
| email | text pk | lowercase |
| name | text | display name |

Signups are closed. An auth trigger rejects any new auth user whose email is
not already in `people`.

**categories** — habits and chores.

| column | type | note |
| --- | --- | --- |
| id | text pk | slug, as today |
| kind | text | `habit` or `chore` |
| name | text | |
| active | boolean | |
| config | jsonb | the normalized category object the engine consumes |
| updated_at | timestamptz | |

**ledger** — same columns as the Sheet. Undo deletes a row and amend rewrites
one, as the Apps Script does today; a replay updates amount, freeze used, and
balance after on the affected rows.

| column | type |
| --- | --- |
| id | uuid pk |
| ts | timestamptz |
| type | text (`entry`, `bonus`, `spend`, `deposit`, `claim`, `penalty`) |
| category | text null |
| period_key | text null |
| result | text null |
| freeze_used | boolean |
| amount | numeric(10,2) |
| balance_after | numeric(10,2) |
| actor | text references people(email) |
| note | text |

Indexes on `(actor, ts)` and `(category, period_key)`.

**habit_state** — one row per person per category.

| column | type |
| --- | --- |
| actor | text |
| category | text |
| state | jsonb |
| primary key | (actor, category) |

**chore_state** — one row per chore, since a chore period is done once by
whoever did it. Columns `category text pk`, `state jsonb`.

**settings** — key-value (`key text pk`, `value jsonb`) for the chore pause
date and the average window.

**holidays** — `day date pk`. Replaces the `HOLIDAYS` constant.

### Budget

**plaid_items** — one row per institution login. No row-level policies for
`anon` or `authenticated`; only the service role reads it.

| column | type | note |
| --- | --- | --- |
| id | text pk | Plaid item id |
| institution | text | |
| access_token | text | encrypted with Supabase Vault |
| cursor | text null | transactions sync cursor |
| status | text | `ok`, `login_required`, `error` |
| linked_by | text references people(email) | |
| last_synced_at | timestamptz null | |

**accounts**

| column | type |
| --- | --- |
| id | text pk (Plaid account id) |
| item_id | text references plaid_items |
| name | text |
| type | text |
| subtype | text |
| mask | text |
| current_balance | numeric(12,2) null |
| balance_as_of | timestamptz null |

**transactions**

| column | type | note |
| --- | --- | --- |
| id | text pk | Plaid transaction id |
| account_id | text references accounts | |
| date | date | |
| amount | numeric(12,2) | Plaid sign: positive is money out |
| merchant | text | |
| pending | boolean | |
| plaid_category | text null | hint only |
| category_id | text null references budget_categories | |
| note | text | |
| removed_at | timestamptz null | soft delete from Plaid's removed list |
| categorized_by | text | `rule`, `user`, or null |

**budget_categories**

| column | type | note |
| --- | --- | --- |
| id | text pk | slug |
| name | text | |
| emoji | text | |
| kind | text | `spend`, `income`, `transfer`, `wallet` |
| wallet_owner | text null | people.email, set only when kind is `wallet` |

Seed inserts two `wallet` rows, one per person, and one `transfer` row.

**category_rules**

| column | type |
| --- | --- |
| id | serial pk |
| pattern | text (case-insensitive substring on merchant) |
| category_id | text |
| priority | integer |

First match by priority wins. A user categorization always overrides a rule
and never gets overwritten by a later sync.

### Views

- **wallet_balance(actor)**: the ledger side follows the engine's
  `runningBalanceRows` rule exactly (`spend` subtracts its amount, every other
  type adds its signed amount), minus non-removed transactions whose category
  is that person's wallet.
- **monthly_actuals**: sum of non-removed, non-pending transactions by
  `category_id` and month, excluding kind `transfer`.
- **category_pace**: for each spend category, this month's spend so far, the
  trailing average over the last N complete months (N from `settings`,
  default 6), the expected spend at this point of the month
  (`average * day_of_month / days_in_month`), and a boolean `over_pace`.

Balances are always derived. Nothing stores a running total except
`ledger.balance_after`, which is kept for display and migration parity.

## Flows

### Login

Supabase magic link by email. The redirect URL is `https://homebase.samnichols.dev/`.
Sessions persist in the browser. Only emails present in `people` can sign in.

### Recording a habit entry

1. Browser calls `api` with `{action: 'record', categoryId, result}` and the
   user's JWT.
2. The function opens a transaction, takes an advisory lock, and loads a
   snapshot: people, categories, both state tables, settings, holidays, and
   every ledger row.
3. The ported `doRecord` runs against the snapshot. Engine functions
   `applyEntry`, `replayFrom`, and friends run unchanged.
4. The snapshot's journal of appends, updates, deletes, and state saves is
   applied and the transaction commits.
5. Response returns the new state and wallet balance; the browser updates in
   place.

Undo, amend, chore claim, chore pause, spend, and category admin are further
`action` values on the same function.

### Dashboard read

The dashboard calls `api` with `action: state`. This stays a function call
rather than a direct table read because loading the dashboard may settle a
period rollover or run the chore sweep, both of which write. The response
shape is unchanged from today, so the rendering code carries over. The page
renders from a local-storage copy of the last response first, then replaces
it. Budget screens in later phases read their tables directly under
row-level security.

### Hourly dispatch

Postgres cron calls `dispatch` at minute zero of every hour through `pg_net`.
For each active category: send the reminder at its reminder hour, send the
check-up at its check-up hour, and run freeze and bonus settlement at period
rollover. Mail is sent through Resend from `homebase@samnichols.dev` with
Reply-To set to snic9004@gmail.com; no mailbox exists for the sender. The
settlement runs inside the locked transaction; the messages it produces are
queued and sent only after the transaction commits, so a failed commit never
leaves mail already sent and other requests never wait on Resend. A failed
send is logged and skipped, not retried, since a late reminder is noise.

### One-tap check-up

Each yes or no link carries a token: base64 of
`{actor, category, periodKey, result, exp}` plus an HMAC-SHA256 signature over
it using a project secret. Expiry is two days. `checkup` verifies the signature
and expiry, then runs the same `doRecord` path as the dashboard. A period already recorded
returns an "already recorded" page rather than a second entry.

### Linking a bank

1. Budget settings calls `plaid` with `action: link_token`. Function returns a
   Link token, or an update-mode Link token if an existing item id is passed.
2. Browser opens Plaid Link and receives a public token.
3. Browser calls `plaid` with `action: exchange`. Function stores the item and
   accounts, then runs a first sync.

Update mode reuses the existing item, so re-authenticating a broken login does
not consume one of the ten Trial slots.

### Sync

Cron calls `plaid` with `action: sync` at 06:00, 12:00, 18:00, and 23:00 local.
A "Sync now" button calls the same thing. Per item:

1. Call transactions sync with the stored cursor, paging until `has_more` is
   false.
2. Added rows: insert, apply the first matching rule, set `categorized_by` to
   `rule` when one matched.
3. Modified rows: update amount, merchant, pending, date. Never touch
   `category_id` or `note`.
4. Removed rows: set `removed_at`.
5. Refresh account balances.
6. Commit, then save the new cursor.

A failure on one item sets its status and moves on. The budget page shows any
item not in `ok`.

### Categorizing

The transactions inbox lists rows with null `category_id`, newest first, with
Plaid's category as the suggestion. One tap assigns a category; a "remember
this merchant" checkbox also inserts a rule using the merchant string. Tagging a
transaction to a person's wallet debits that wallet immediately through the
view.

### Reports

- **Month**: every spend category with spent so far, trailing average, and
  pace. Over-pace rows sort first.
- **History**: twelve monthly bars per category with the average as a line.
- **Accounts**: last synced balance per account and a net total.

## Frontend

Vanilla JavaScript, ES modules, no build step. A hash router maps
`#/`, `#/categories`, `#/budget`, `#/budget/history`, `#/inbox`, and
`#/accounts` to screen modules. The Supabase client loads from the jsDelivr
CDN; Plaid Link's script loads only on the accounts screen. Charts are inline
SVG produced by one helper. The current stylesheet carries over with an added
tablet breakpoint and a 900px maximum width for the budget screens.

## Security

- Anon key in the browser is fine; every table has row-level security. In
  phase 1 no table has a client policy, so the browser can only reach the
  functions. Later phases add read policies for the budget tables.
- `plaid_items` has no client policies at all.
- Edge functions verify the caller's JWT and use the service role only inside
  the function.
- Check-up tokens are signed, expire in two days, and are idempotent by the
  ledger's once-per-period guard.
- Plaid access tokens are stored through Supabase Vault, never returned to
  the browser.

## Failure handling

- Functions return `{ok: false, error}`; the UI shows a banner and leaves
  state unchanged.
- Writes are safe to retry: entries are guarded per period, transactions are
  keyed by Plaid id, and the cursor is saved only after its batch commits.
- With Supabase unreachable the dashboard renders the cached state with a
  "showing cached" banner and disables write buttons.
- Supabase pauses free projects after seven idle days. The hourly cron keeps
  the project active.

## Testing

- `engine.test.js` runs under node's test runner, unchanged, 106 tests.
- The ported service has Node tests against the in-memory store: record path
  including replay, chore sweep and claim, dispatch with a recording mailer.
  Token sign and verify are tested the same way.
- Snapshot load and journal apply have one Node test that runs only when a
  local database URL is set, against the Supabase CLI local stack.
- SQL views have assertion scripts in `supabase/tests/` run against a fixture
  ledger, covering wallet balance, monthly actuals, and pace with and without
  a partial month.
- Frontend is tested by hand.

## Migration and cutover

1. Export the Sheet ledger to CSV and copy `states`, `choreStates`,
   `categories`, and `chorePauseUntil` from script properties.
2. `scripts/migrate-from-sheet.js` maps `actor` emails to `people.id` and
   inserts categories, ledger, state, and settings.
3. Verify each person's `wallet_balance` matches the old dashboard.
4. Point `js/config.js` at Supabase, publish, and disable the Apps Script
   trigger the same day. The Sheet stays as a read-only backup.

## Phasing

Each phase gets its own implementation plan and is used before the next
starts.

1. **Foundation and habits port.** Supabase project, schema, auth, `api`,
   `checkup`, `dispatch`, migration, DNS and Pages setup, cutover.
2. **Bank sync.** `plaid` function, link and update mode, sync cron,
   transactions inbox, rules.
3. **Reports and wallet link.** Month, history, and accounts screens, pace
   view, wallet debits from tagged transactions, removal of the deposit
   button.

## Assumptions

- Subdomain is `homebase.samnichols.dev`.
- Sender address `homebase@samnichols.dev` requires verifying the domain in
  Resend, one TXT and one CNAME record.
- Trailing average window defaults to six complete months.
- Plaid Trial terms as of September 2026: ten Production Items, lifetime,
  Transactions included, auto-approved after identity verification.

## Sources

- [Plaid Trial plan](https://support.plaid.com/hc/en-us/articles/39994173227159-What-is-the-Plaid-Trial-plan)
- [Plaid pricing and billing](https://plaid.com/docs/account/billing/)
- [Plaid: Sandbox, Production, Trial, Limited Production](https://support.plaid.com/hc/en-us/articles/16110110883479-How-are-Sandbox-Production-Trial-plan-and-Limited-Production-different)
- [SimpleFIN Bridge](https://beta-bridge.simplefin.org/), the fallback if Plaid's cap ever binds
