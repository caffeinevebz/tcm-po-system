/* =============================================================================
 * Website reservations — pure validation, no Firebase.
 * -----------------------------------------------------------------------------
 * Kept free of firebase-admin so tools/test-reservations.mjs can exercise every
 * rule without emulators. The callable in ../website.js feeds it the request,
 * the clock and the owner's settings from site/info, and stores what it returns.
 *
 * The public site (website/js/site.js) builds its time slots from the same
 * settings. If you change DEFAULT_SITE here, change SITE_DEFAULTS there too.
 * ========================================================================== */

const TZ = 'Asia/Kolkata';

const DEFAULT_SITE = {
  open: '09:00',
  close: '23:00',
  closedWeekdays: [],          // 0 = Sunday … 6 = Saturday
  reservations: {
    enabled: true,
    maxGuests: 12,             // larger parties are routed to an events enquiry
    slotMinutes: 30,
    lastSeatingMinutes: 60,    // last booking this long before closing
    daysAhead: 30,
    leadMinutes: 30,           // same-day bookings need at least this much notice
    closedDates: []            // 'YYYY-MM-DD'
  }
};

const OCCASIONS = ['', 'Birthday', 'Anniversary', 'Date night', 'Business', 'Celebration', 'Other'];

/** Merge the owner's settings over the defaults, ignoring malformed values. */
function siteSettings(info) {
  const i = info && typeof info === 'object' ? info : {};
  const r = i.reservations && typeof i.reservations === 'object' ? i.reservations : {};
  const d = DEFAULT_SITE.reservations;
  const num = (v, lo, hi, fallback) =>
    Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Math.floor(Number(v)) : fallback;

  return {
    open: isClock(i.open) ? i.open : DEFAULT_SITE.open,
    close: isClock(i.close) ? i.close : DEFAULT_SITE.close,
    closedWeekdays: Array.isArray(i.closedWeekdays)
      ? i.closedWeekdays.map(Number).filter((n) => n >= 0 && n <= 6) : [],
    reservations: {
      enabled: r.enabled !== false,
      maxGuests: num(r.maxGuests, 1, 100, d.maxGuests),
      slotMinutes: [15, 30, 60].includes(Number(r.slotMinutes)) ? Number(r.slotMinutes) : d.slotMinutes,
      lastSeatingMinutes: num(r.lastSeatingMinutes, 0, 240, d.lastSeatingMinutes),
      daysAhead: num(r.daysAhead, 1, 180, d.daysAhead),
      leadMinutes: num(r.leadMinutes, 0, 1440, d.leadMinutes),
      closedDates: Array.isArray(r.closedDates) ? r.closedDates.filter(isIsoDate) : []
    }
  };
}

function isClock(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
function isIsoDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function toMinutes(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }

/** The calendar date and minute-of-day in Jodhpur for a given instant. */
function localNow(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute'))
  };
}

/** Whole days from a to b, both 'YYYY-MM-DD'. */
function daysBetween(a, b) {
  return Math.round((Date.UTC(...ymd(b)) - Date.UTC(...ymd(a))) / 86400000);
}
function ymd(s) { const [y, m, d] = s.split('-').map(Number); return [y, m - 1, d]; }
function weekday(s) { return new Date(Date.UTC(...ymd(s))).getUTCDay(); }

/** Bookable times for a date, as 'HH:MM'. */
function slotsFor(date, settings, now) {
  const s = settings;
  const r = s.reservations;
  const first = toMinutes(s.open);
  const last = toMinutes(s.close) - r.lastSeatingMinutes;
  const today = localNow(now);
  const earliest = date === today.date ? today.minutes + r.leadMinutes : -1;

  const out = [];
  // Round the first slot up onto the grid so times read 09:00, 09:30, …
  for (let m = Math.ceil(first / r.slotMinutes) * r.slotMinutes; m <= last; m += r.slotMinutes) {
    if (m < earliest) continue;
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
}

/** Why a date cannot be booked, or null. */
function dateProblem(date, settings, now) {
  // isIsoDate checks the shape; the round trip rejects 2026-02-30 and friends,
  // which Date.UTC would otherwise quietly roll into March.
  if (!isIsoDate(date) || new Date(Date.UTC(...ymd(date))).toISOString().slice(0, 10) !== date) {
    return 'Choose a date.';
  }
  const today = localNow(now).date;
  const ahead = daysBetween(today, date);
  if (ahead < 0) return 'That date has already passed.';
  if (ahead > settings.reservations.daysAhead) {
    return `We take bookings up to ${settings.reservations.daysAhead} days ahead.`;
  }
  if (settings.closedWeekdays.includes(weekday(date)) ||
      settings.reservations.closedDates.includes(date)) {
    return 'We are closed that day.';
  }
  return null;
}

const clean = (v, max) => String(v == null ? '' : v)
  .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Indian mobiles may arrive as 98xxxxxxxx, 098xxxxxxxx, +91 98xxx xxxxx or
 * 91-98xxxxxxxx; they are stored as 9198xxxxxxxx so the owner terminal can open
 * WhatsApp with them directly. Other countries need the + prefix.
 */
function normalizePhone(raw) {
  const s = String(raw || '').trim();
  const digits = s.replace(/\D/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return '91' + digits;
  if (/^0[6-9]\d{9}$/.test(digits)) return '91' + digits.slice(1);
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;
  if (s.startsWith('+') && /^[1-9]\d{7,14}$/.test(digits)) return digits;
  return null;
}

/**
 * Validate a booking request.
 * Returns { value } with the cleaned record, or { error } with a message fit
 * to show the guest.
 */
function validateReservation(input, info, now) {
  const d = input && typeof input === 'object' ? input : {};
  const settings = siteSettings(info);
  const r = settings.reservations;

  if (!r.enabled) return { error: 'Online booking is paused right now. Please call or message us.' };

  const name = clean(d.name, 60);
  if (name.length < 2) return { error: 'Tell us your name.' };

  const phone = normalizePhone(d.phone);
  if (!phone) return { error: 'Enter a 10-digit mobile number (or +country code for overseas numbers).' };

  const email = clean(d.email, 100).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { error: 'That email address looks wrong.' };

  const guests = Number(d.guests);
  if (!Number.isInteger(guests) || guests < 1) return { error: 'How many guests?' };
  if (guests > r.maxGuests) {
    return { error: `For more than ${r.maxGuests} guests, please send an events enquiry instead.` };
  }

  const date = String(d.date || '');
  const dp = dateProblem(date, settings, now);
  if (dp) return { error: dp };

  const time = String(d.time || '');
  if (!isClock(time)) return { error: 'Choose a time.' };
  if (!slotsFor(date, settings, now).includes(time)) {
    return { error: 'That time is not available. Please choose another.' };
  }

  const occasion = OCCASIONS.includes(d.occasion) ? d.occasion : '';
  const notes = clean(d.notes, 500);

  return { value: { name, phone, email, guests, date, time, occasion, notes } };
}

/** A short code the guest can quote: TCM-XXXXX, no look-alike characters. */
function referenceCode(randomBytes) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 5; i++) out += alphabet[randomBytes[i] % alphabet.length];
  return 'TCM-' + out;
}

module.exports = {
  TZ, DEFAULT_SITE, OCCASIONS,
  siteSettings, localNow, slotsFor, dateProblem, normalizePhone,
  validateReservation, referenceCode
};
