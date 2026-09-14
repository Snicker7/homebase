// Supabase project the dashboard talks to. Both values are public by design:
// the anon key only grants what row-level security and the edge functions allow.
// These are the local CLI defaults; production values land in Task 13.
window.CONFIG = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY:
    'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH',
};
