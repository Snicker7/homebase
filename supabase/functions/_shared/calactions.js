// Input checks for the calendar actions that ride on the api function. Pure, so
// the shapes are tested without a database.
import { weekday, daysInMonth, OVERRIDABLE } from './recur.js';

export const CAL_ACTIONS = [
  'eventSave', 'eventDelete', 'occurrenceSkip', 'occurrenceSave',
  'calCategorySave', 'calCategoryRetire', 'officeRefresh',
];

const MAX_TITLE = 200;
const MAX_NOTES = 2000;
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ORDINAL = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');

// A real calendar date, not merely a well-shaped string: 2026-02-30 parses
// nowhere and must not reach Postgres.
const isDay = (v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return false;
  const [y, m, d] = String(v).split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
};
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function validateRepeat(raw, day) {
  if (raw == null) return { repeat: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'repeat must be a rule or nothing' };
  const freq = String(raw.freq || '');
  if (freq === 'daily' || freq === 'yearly') return { repeat: { freq } };
  if (freq === 'weekly') {
    const days = Array.isArray(raw.days) ? raw.days.map(Number) : [];
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      return { error: 'a weekly repeat needs at least one weekday, 1 (Monday) to 7 (Sunday)' };
    }
    const start = weekday(day);
    if (!days.includes(start)) {
      return { error: 'this event starts on a ' + WEEKDAY_NAMES[start - 1] + ', so the repeat has to include it' };
    }
    return { repeat: { freq: 'weekly', days: [...new Set(days)].sort((a, b) => a - b) } };
  }
  if (freq === 'monthly') {
    const dom = +day.slice(8, 10);
    if (Number(raw.day) !== dom) return { error: 'this event starts on the ' + ORDINAL(dom) + ', so a monthly repeat falls on the ' + ORDINAL(dom) };
    return { repeat: { freq: 'monthly', day: dom } };
  }
  return { error: 'repeat must be daily, weekly, monthly, or yearly' };
}

export function validateEvent(p) {
  const title = String(p.title || '').trim();
  const notes = String(p.notes || '').trim();
  const categoryId = String(p.categoryId || '').trim();
  const day = String(p.day || '').trim();
  if (!title) return { error: 'title required' };
  if (title.length > MAX_TITLE) return { error: 'title must be ' + MAX_TITLE + ' characters or fewer' };
  if (notes.length > MAX_NOTES) return { error: 'notes must be ' + MAX_NOTES + ' characters or fewer' };
  if (!categoryId) return { error: 'category required' };
  if (!isDay(day)) return { error: 'date must be a real YYYY-MM-DD date' };

  const hasTime = p.time != null && p.time !== '';
  const hasMinutes = p.minutes != null && p.minutes !== '';
  if (hasTime && !isTime(p.time)) return { error: 'time must be HH:MM' };
  if (hasTime && !hasMinutes) return { error: 'a timed event needs how long it lasts' };
  if (!hasTime && hasMinutes) return { error: 'an all-day event has no length' };
  const minutes = hasMinutes ? Number(p.minutes) : null;
  if (hasMinutes && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) {
    return { error: 'length must be between 1 and 1440 minutes' };
  }

  const r = validateRepeat(p.repeat == null ? null : p.repeat, day);
  if (r.error) return { error: r.error };
  const until = p.repeatUntil == null || p.repeatUntil === '' ? null : String(p.repeatUntil).trim();
  if (until !== null) {
    if (!r.repeat) return { error: 'an end date needs a repeat' };
    if (!isDay(until)) return { error: 'end date must be a real YYYY-MM-DD date' };
    if (until < day) return { error: 'the end date is before the event starts' };
  }
  return {
    id: p.id ? String(p.id).trim() : null,
    title, notes, categoryId, day,
    time: hasTime ? String(p.time) : null,
    minutes,
    repeat: r.repeat,
    repeatUntil: until,
  };
}

export function validateOccurrence(p) {
  const eventId = String(p.eventId || '').trim();
  const day = String(p.day || '').trim();
  if (!eventId) return { error: 'event required' };
  if (!isDay(day)) return { error: 'date must be a real YYYY-MM-DD date' };
  if (p.skipped === true) return { eventId, day, skipped: true, override: null };

  const raw = p.override && typeof p.override === 'object' ? p.override : {};
  const override = {};
  for (const k of OVERRIDABLE) if (raw[k] !== undefined) override[k] = raw[k];
  if (!Object.keys(override).length) return { error: 'nothing to change' };
  if (override.day !== undefined && !isDay(override.day)) return { error: 'date must be a real YYYY-MM-DD date' };
  if (override.time !== undefined && override.time !== null && !isTime(override.time)) return { error: 'time must be HH:MM' };
  // The override merges onto the series, and this validator cannot see the
  // series; requiring the pair together is what keeps a timed occurrence from
  // losing its duration, the way the events table's own check does.
  const touchesTime = override.time !== undefined;
  const touchesMinutes = override.minutes !== undefined;
  if (touchesTime !== touchesMinutes) return { error: 'change the time and the length together' };
  if (touchesMinutes && override.minutes !== null) {
    const m = Number(override.minutes);
    if (!Number.isInteger(m) || m < 1 || m > 1440) return { error: 'length must be between 1 and 1440 minutes' };
    override.minutes = m;
  }
  if (touchesTime && override.time === null && override.minutes !== null) {
    return { error: 'an all-day event has no length' };
  }
  if (override.categoryId !== undefined && !String(override.categoryId).trim()) return { error: 'category required' };
  if (override.notes !== undefined) {
    const n = String(override.notes).trim();
    if (n.length > MAX_NOTES) return { error: 'notes must be ' + MAX_NOTES + ' characters or fewer' };
    override.notes = n;
  }
  if (override.title !== undefined) {
    const t = String(override.title).trim();
    if (!t) return { error: 'title required' };
    if (t.length > MAX_TITLE) return { error: 'title must be ' + MAX_TITLE + ' characters or fewer' };
    override.title = t;
  }
  return { eventId, day, skipped: false, override };
}

export function validateEventCategory(p) {
  const name = String(p.name || '').trim();
  const color = String(p.color || '').trim().toLowerCase();
  if (!name) return { error: 'name required' };
  if (!/^#[0-9a-f]{6}$/.test(color)) return { error: 'color must be a #rrggbb hex' };
  const id = p.id ? slug(p.id) : slug(name);
  if (!id) return { error: 'name needs a letter or digit' };
  const sort = Number.isInteger(Number(p.sort)) ? Number(p.sort) : 100;
  return { id, name, color, sort };
}

export function validateId(p) {
  const id = String(p.id || '').trim();
  return id ? { id } : { error: 'id required' };
}
