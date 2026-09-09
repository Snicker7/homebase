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
    body := '{}'::jsonb
  );
  $$
);
-- Check it ran: select * from cron.job_run_details order by start_time desc limit 5;
