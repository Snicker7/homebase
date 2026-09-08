export const TZ = 'America/Denver';
// Hour (local) at which a weekly freeze period hands over on Monday. Sunday's
// habit is answered Monday morning; settling at midnight would spend the new
// week's freeze on it and pay the old week's bonus before the answer arrived.
export const WEEKLY_ROLLOVER_HOUR = 17;
// One-tap check-up links stop verifying after this long.
export const CHECKUP_TTL_MS = 2 * 24 * 3600 * 1000;
