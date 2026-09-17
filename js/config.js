// Supabase project the dashboard talks to. Both values are public by design:
// the anon key only grants what row-level security and the edge functions allow.
// Committed pointing at production. While developing, swap in the local CLI
// values from `npx supabase status` — and leave that edit out of your commits.
window.CONFIG = {
  SUPABASE_URL: 'https://csimcqtbezylvbbzgqyg.supabase.co',
  SUPABASE_ANON_KEY:
    'sb_publishable_aS9Pl7P8vZl5pmj1h91TDg_o5BJwL5d',
};
