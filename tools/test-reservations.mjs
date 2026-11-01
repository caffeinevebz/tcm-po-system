/**
 * Tests for website reservation validation (functions/lib/reservation.js).
 *
 *   npm run test:site
 *
 * Pure logic — no emulators, no network.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../functions/lib/reservation.js');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

// 10:00 IST on Saturday 24 Oct 2026 is 04:30 UTC.
const NOW = new Date('2026-10-24T04:30:00Z');
const good = { name: 'Asha Rathore', phone: '98290 12345', guests: 4, date: '2026-10-25', time: '19:30' };
const ok = (over, info) => R.validateReservation({ ...good, ...over }, info || {}, NOW);

test('local clock is Jodhpur time', () => {
  assert.deepEqual(R.localNow(NOW), { date: '2026-10-24', minutes: 600 });
  // 20:00 UTC on the 24th is already the 25th in India.
  assert.equal(R.localNow(new Date('2026-10-24T20:00:00Z')).date, '2026-10-25');
});

test('a normal booking is accepted and cleaned', () => {
  const r = ok({ name: '  Asha   Rathore ', notes: 'Window\nseat please' });
  assert.equal(r.error, undefined);
  assert.equal(r.value.name, 'Asha Rathore');
  assert.equal(r.value.phone, '919829012345');
  assert.equal(r.value.notes, 'Window seat please');
});

test('phone numbers in the usual Indian shapes', () => {
  for (const p of ['9829012345', '09829012345', '+91 98290 12345', '91-98290-12345']) {
    assert.equal(R.normalizePhone(p), '919829012345', p);
  }
  assert.equal(R.normalizePhone('+44 7700 900123'), '447700900123');
  for (const p of ['12345', '5829012345', '44 7700 900123', '']) {
    assert.equal(R.normalizePhone(p), null, p);
  }
});

test('missing or silly fields are refused', () => {
  assert.match(ok({ name: 'A' }).error, /name/);
  assert.match(ok({ phone: '123' }).error, /mobile/);
  assert.match(ok({ email: 'not-an-email' }).error, /email/);
  assert.match(ok({ guests: 0 }).error, /guests/);
  assert.match(ok({ guests: 2.5 }).error, /guests/);
  assert.match(ok({ guests: 13 }).error, /events enquiry/);
  assert.match(ok({ time: '7pm' }).error, /time/);
});

test('dates in the past, too far ahead, or on closed days', () => {
  assert.match(ok({ date: '2026-10-23' }).error, /passed/);
  assert.match(ok({ date: '2026-12-31' }).error, /30 days/);
  assert.match(ok({ date: '2026-10-32' }).error, /Choose a date/);
  assert.match(ok({ date: '25/10/2026' }).error, /Choose a date/);
  // 25 Oct 2026 is a Sunday.
  assert.match(ok({}, { closedWeekdays: [0] }).error, /closed/);
  assert.match(ok({}, { reservations: { closedDates: ['2026-10-25'] } }).error, /closed/);
});

test('times must sit on the grid inside opening hours', () => {
  assert.equal(ok({ time: '09:00' }).error, undefined);
  assert.equal(ok({ time: '22:00' }).error, undefined);   // close 23:00, last seating 60 min before
  assert.match(ok({ time: '22:30' }).error, /not available/);
  assert.match(ok({ time: '08:30' }).error, /not available/);
  assert.match(ok({ time: '19:15' }).error, /not available/);
});

test('same-day bookings need the lead time', () => {
  // It is 10:00; with 30 minutes' notice the first slot is 10:30.
  assert.match(ok({ date: '2026-10-24', time: '10:00' }).error, /not available/);
  assert.equal(ok({ date: '2026-10-24', time: '10:30' }).error, undefined);
});

test('owner settings change the rules', () => {
  const info = { open: '11:00', close: '22:00', reservations: { maxGuests: 6, slotMinutes: 60 } };
  assert.match(ok({ time: '10:00' }, info).error, /not available/);
  assert.equal(ok({ time: '11:00', guests: 6 }, info).error, undefined);
  assert.match(ok({ time: '11:30' }, info).error, /not available/);
  assert.match(ok({ guests: 7 }, info).error, /more than 6/);
  assert.match(ok({}, { reservations: { enabled: false } }).error, /paused/);
});

test('malformed settings fall back to defaults', () => {
  const s = R.siteSettings({ open: '9am', reservations: { maxGuests: -4, slotMinutes: 7 } });
  assert.equal(s.open, '09:00');
  assert.equal(s.reservations.maxGuests, 12);
  assert.equal(s.reservations.slotMinutes, 30);
});

test('unknown occasions are dropped, not stored', () => {
  assert.equal(ok({ occasion: '<script>' }).value.occasion, '');
  assert.equal(ok({ occasion: 'Birthday' }).value.occasion, 'Birthday');
});

test('reference codes avoid look-alike characters', () => {
  const code = R.referenceCode(Buffer.from([0, 8, 14, 31, 255]));
  assert.match(code, /^TCM-[A-HJ-NP-Z2-9]{5}$/);
});

console.log(`\n${passed} passed`);
