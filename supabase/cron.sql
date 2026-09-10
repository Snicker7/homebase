-- supabase/cron.sql
-- Run once in the Supabase SQL editor after the first deploy. Replace the two
-- placeholders. Not a migration: the URL and secret differ per environment.
select cron.unschedule('homebase-dispatch') where exists (select 1 from cron.job where jobname = 'homebase-dispatch');
select cron.schedule(
  'homebase-dispatch',
  '0 * * * *',
  $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/dispatch',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer DISPATCH_SECRET"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
-- Check the job fired: select * from cron.job_run_details order by start_time desc limit 5;
-- Then confirm the function itself answered 200: select status_code, content from net._http_response order by created desc limit 5;

-- Bank sync four times a day. pg_cron runs in UTC; 12,18,00,05 UTC are
-- 06,12,18,23 Denver in summer and an hour earlier in winter, which is fine.
select cron.unschedule('homebase-plaid-sync') where exists (select 1 from cron.job where jobname = 'homebase-plaid-sync');
select cron.schedule(
  'homebase-plaid-sync',
  '0 0,5,12,18 * * *',
  $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/plaid',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer DISPATCH_SECRET"}'::jsonb,
    body := '{"action":"sync"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
