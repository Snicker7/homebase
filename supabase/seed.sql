insert into public.people (email, name) values
  ('snic9004@gmail.com', 'Sam'),
  ('sierra.author@gmail.com', 'Sierra')
on conflict do nothing;

insert into public.holidays (day) values
  ('2026-01-01'), ('2026-05-25'), ('2026-07-03'), ('2026-07-04'), ('2026-09-07'),
  ('2026-11-26'), ('2026-11-27'), ('2026-12-24'), ('2026-12-25'),
  ('2027-01-01'), ('2027-05-31'), ('2027-07-05'), ('2027-09-06'),
  ('2027-11-25'), ('2027-11-26'), ('2027-12-24'), ('2027-12-25')
on conflict do nothing;

insert into public.budget_categories (id, name, emoji, kind, wallet_owner) values
  ('wallet-sam', 'Sam''s wallet', '🌱', 'wallet', 'snic9004@gmail.com'),
  ('wallet-sierra', 'Sierra''s wallet', '🌱', 'wallet', 'sierra.author@gmail.com'),
  ('transfer', 'Transfer', '🔁', 'transfer', null),
  ('income', 'Income', '💵', 'income', null)
on conflict do nothing;

insert into public.event_categories (id, name, color, sort, system) values
  ('family',       'Family',       '#57c785', 10, false),
  ('appointments', 'Appointments', '#ef6f8e', 20, false),
  ('school',       'School',       '#e8b84b', 30, false),
  ('social',       'Social',       '#f2924b', 40, false),
  ('travel',       'Travel',       '#3fbfae', 50, false),
  ('birthdays',    'Birthdays',    '#c97ae0', 60, false),
  ('keepsite',     'Keepsite',     '#7f8cf0', 70, true),
  ('lova',         'Lova',         '#5ec8f2', 80, true),
  ('office',       'Office',       '#8d9bb5', 90, true)
on conflict do nothing;

insert into public.settings (key, value) values ('calendarDigestTime', '"07:00"'::jsonb)
on conflict do nothing;
