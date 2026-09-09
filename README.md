# Homebase

Habits, chores, and (soon) budgeting for two. Frontend on GitHub Pages at
homebase.samnichols.dev, backend on Supabase.

See `docs/superpowers/specs/2026-09-08-homebase-design.md`.

## Develop

    npm install
    npm test
    npx supabase start                                                # local Postgres + functions
    npx supabase functions serve --env-file supabase/functions/.env   # in another shell
    python3 -m http.server 8000                                       # serve the frontend

Copy `supabase/functions/.env.example` to `supabase/functions/.env` and fill
in the values before serving functions locally.

The Supabase CLI runs via `npx` — there's no global install in this repo.

Running `npm test` with `DB_URL` set exercises the Postgres-backed tests
against the local database and leaves rows behind. Run
`npx supabase db reset` before a manual testing session that follows.

## Production setup (once)

1. **Supabase project.** supabase.com, New project, region US West, note the
   project ref (shown in the dashboard URL and under Project Settings,
   General) and database password. Then locally:

       npx supabase link --project-ref PROJECT_REF
       npx supabase db push
       psql "$PROD_DB_URL" -f supabase/seed.sql

2. **Resend.** resend.com, Domains, add `samnichols.dev`, add the TXT and
   CNAME records it shows at your DNS host, wait for Verified. Create an API
   key with sending access.

3. **Auth email through Resend.** Supabase dashboard, Authentication, SMTP
   Settings: host `smtp.resend.com`, port 465, user `resend`, password = the
   API key, sender `homebase@samnichols.dev`, sender name `Homebase`.
   Authentication, URL Configuration: set Site URL to
   `https://homebase.samnichols.dev` in the dashboard. `supabase/config.toml`
   still has `site_url = "http://localhost:8000"` for local dev (marked
   `TODO(task-13)`) — if you ever run `npx supabase config push`, change
   `site_url` there first, or it will overwrite the dashboard value. Add
   `https://homebase.samnichols.dev` to Redirect URLs (config.toml's
   `additional_redirect_urls` already lists it, so a config push won't drop
   it). Under Providers, Email: keep Email enabled and leave "Allow new
   users to sign up" ON. The first magic link creates each auth user, and
   the `enforce_allowlist` trigger is what rejects anyone not in `people`.
   Set OTP expiry to 3600.

4. **Function secrets.**

       openssl rand -hex 32   # CHECKUP_SECRET
       openssl rand -hex 32   # DISPATCH_SECRET
       npx supabase secrets set CHECKUP_SECRET=... DISPATCH_SECRET=... \
         RESEND_API_KEY=re_... 'MAIL_FROM=Homebase <homebase@samnichols.dev>' \
         MAIL_REPLY_TO=snic9004@gmail.com \
         DASHBOARD_URL=https://homebase.samnichols.dev/ \
         ALLOWED_ORIGINS=https://homebase.samnichols.dev
       npx supabase functions deploy api
       npx supabase functions deploy checkup --no-verify-jwt
       npx supabase functions deploy dispatch --no-verify-jwt

5. **Cron.** Open `supabase/cron.sql`, fill in PROJECT_REF and
   DISPATCH_SECRET, run it in the SQL editor. Next hour, check
   `cron.job_run_details` shows status `succeeded` — that only means the
   request was enqueued, not that the function answered. Confirm the
   response too:

       select status_code, content from net._http_response order by created desc limit 5;

   Expect `status_code` 200 and a body containing `"ok":true`.

6. **Frontend.** In `js/config.js`, replace the committed local-dev
   `SUPABASE_URL` and `SUPABASE_ANON_KEY` with the production project's URL
   and anon key (Project Settings, API). Push to GitHub. Repo Settings,
   Pages: deploy from `main`, root. Custom domain
   `homebase.samnichols.dev`, enforce HTTPS. At your DNS host add
   `CNAME homebase -> snicker7.github.io`.

7. **Migrate.** `dumpProps` lives in `scripts/dump-props.gs` — paste it into
   the Apps Script editor first, then run it and save the log as
   `scripts/data/props.json`; download the Ledger tab as
   `scripts/data/ledger.csv`. Then:

       node scripts/migrate-from-sheet.js --ledger scripts/data/ledger.csv \
         --props scripts/data/props.json --db "$PROD_DB_URL"          # dry run
       node scripts/migrate-from-sheet.js ... --db "$PROD_DB_URL" --apply

   Both wallets must match the old dashboard to the cent.

8. **Cut over.** In Apps Script, Triggers, delete the hourly `emailDispatch`
   trigger. Log in at homebase.samnichols.dev on both phones. Leave the
   Sheet as a read-only backup.

## Verify in production

After step 8 above, with the user:

- Load the dashboard from `https://homebase.samnichols.dev` and confirm the
  browser console shows no CORS errors on the `state` call.
- Record today's answer on one habit from the dashboard. Expected under one
  second.
- Wait for the next reminder hour; both inboxes receive one email from
  `Homebase <homebase@samnichols.dev>` with Reply-To the Gmail address.
- Tap a check-up link from a phone; the check-in view shows the recorded
  result; a second tap says already recorded.
- Supabase dashboard, Edge Functions, Logs: the hourly `dispatch` line shows
  `{"ok":true,"failures":[]}`.

## Retire the old app

In the `samsite` repo, decide whether to delete `habits/` or leave a
redirect page at `habits/index.html` pointing to
`https://homebase.samnichols.dev/`. The redirect is recommended, since old
check-up emails still link there.

## Settings

Rows in the `settings` table, editable in the SQL editor. The app writes
`chorePauseUntil` itself from the pause card; the rest are manual.

| key | default | meaning |
|---|---|---|
| `choreDigestTime` | `08:00` | Hour (Denver, whole hour) the morning chore digest goes out. One email per person listing the chores due that day. |
