// Deno-only. Reads the function environment once.
export function readEnv() {
  const get = (k, dflt) => {
    const v = Deno.env.get(k);
    if (v == null || v === '') {
      if (dflt !== undefined) return dflt;
      throw new Error('missing env ' + k);
    }
    return v;
  };
  return {
    dbUrl: get('SUPABASE_DB_URL'),
    supabaseUrl: get('SUPABASE_URL'),
    anonKey: get('SUPABASE_ANON_KEY'),
    checkupSecret: get('CHECKUP_SECRET'),
    dispatchSecret: get('DISPATCH_SECRET'),
    resendKey: get('RESEND_API_KEY'),
    mailFrom: get('MAIL_FROM'),
    mailReplyTo: get('MAIL_REPLY_TO', ''),
    dashboardUrl: get('DASHBOARD_URL'),
    allowedOrigins: get('ALLOWED_ORIGINS').split(',').map((s) => s.trim()),
    // Empty defaults: only the plaid function needs these, and the others
    // must keep booting when they are unset.
    plaidClientId: get('PLAID_CLIENT_ID', ''),
    plaidSecret: get('PLAID_SECRET', ''),
    plaidEnv: get('PLAID_ENV', 'sandbox'),
  };
}
