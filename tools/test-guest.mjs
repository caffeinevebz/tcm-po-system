/**
 * Tests for guest ordering, feedback and loyalty rules (functions/lib/guest.js).
 *
 *   npm run test:site
 *
 * Pure logic — no emulators, no network.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('../functions/lib/guest.js');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

// 10:00 IST, Saturday 24 Oct 2026. Default hours 09:00–23:00.
const NOW = new Date('2026-10-24T04:30:00Z');
const NIGHT = new Date('2026-10-24T18:00:00Z');   // 23:30 IST — closed

const MENU = {
  categories: [
    { id: 'c1', name: 'Coffee', items: [
      { id: 'flat', name: 'Flat White', price: 230, available: true },
      { id: 'gone', name: 'Cold Brew', price: 240, available: false },
      { id: 'ask', name: 'Seasonal Special', price: null, available: true },
      { id: 'secret', name: 'Hidden Thing', price: 99, hidden: true }
    ] },
    { id: 'c2', name: 'Off menu', hidden: true, items: [{ id: 'off', name: 'Off', price: 10 }] }
  ]
};

const table = (over, info, now) =>
  G.validateOrder({ type: 'table', table: '7', items: [{ id: 'flat', qty: 2 }], ...over }, MENU, info || {}, now || NOW);
const takeaway = (over, info, now) =>
  G.validateOrder({ type: 'takeaway', name: 'Asha', phone: '9829012345', pickupTime: '10:30',
                    items: [{ id: 'flat', qty: 1 }], ...over }, MENU, info || {}, now || NOW);

test('a table order is priced from the menu, not the request', () => {
  const r = table({ items: [{ id: 'flat', qty: 2, price: 1, name: 'Free coffee' }] });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.value.lines, [{ id: 'flat', name: 'Flat White', price: 230, qty: 2, note: '' }]);
  assert.equal(r.value.total, 460);
  assert.equal(r.value.table, '7');
  assert.equal(r.value.date, '2026-10-24');
});

test('items that cannot be ordered are refused', () => {
  assert.match(table({ items: [{ id: 'gone', qty: 1 }] }).error, /sold out/);
  assert.match(table({ items: [{ id: 'ask', qty: 1 }] }).error, /ask a team member/);
  assert.match(table({ items: [{ id: 'secret', qty: 1 }] }).error, /no longer on the menu/);
  assert.match(table({ items: [{ id: 'off', qty: 1 }] }).error, /no longer on the menu/);
  assert.match(table({ items: [{ id: 'nope', qty: 1 }] }).error, /no longer on the menu/);
  assert.match(table({ items: [] }).error, /empty/);
});

test('quantities must be sensible whole numbers', () => {
  for (const qty of [0, -1, 1.5, 21, '2x']) assert.match(table({ items: [{ id: 'flat', qty }] }).error, /quantity/, String(qty));
});

test('a table order needs a table and an open café', () => {
  assert.match(table({ table: '' }).error, /Scan the QR code/);
  assert.equal(table({ table: '<b>7</b>' }).value.table, 'b7b');
  assert.match(table({}, {}, NIGHT).error, /closed/);
  assert.match(table({}, { ordering: { tableEnabled: false } }).error, /paused/);
});

test('a phone at the table is optional, but must be valid if given', () => {
  assert.equal(table({}).value.phone, '');
  assert.equal(table({ phone: '98290 12345' }).value.phone, '919829012345');
  assert.match(table({ phone: '123' }).error, /10-digit/);
});

test('takeaway needs a name, a phone and a real pickup slot', () => {
  assert.equal(takeaway({}).error, undefined);
  assert.equal(takeaway({}).value.pickupTime, '10:30');
  assert.match(takeaway({ name: '' }).error, /name/);
  assert.match(takeaway({ phone: '' }).error, /mobile number/);
  assert.match(takeaway({ pickupTime: '10:05' }).error, /pickup time/);   // off the 15-minute grid
  assert.match(takeaway({ pickupTime: '10:15' }).error, /pickup time/);   // inside the 20-minute prep time
  assert.match(takeaway({}, { ordering: { takeawayEnabled: false } }).error, /paused/);
});

test('pickup slots run from prep time until 15 minutes before close', () => {
  const slots = G.pickupSlots({}, NOW);
  assert.equal(slots[0], '10:30');
  assert.equal(slots[slots.length - 1], '22:45');
  assert.equal(G.pickupSlots({ ordering: { prepMinutes: 45 } }, NOW)[0], '10:45');
  assert.deepEqual(G.pickupSlots({ closedWeekdays: [6] }, NOW), []);       // Saturday closed
  assert.deepEqual(G.pickupSlots({}, NIGHT), []);
});

test('feedback is validated and trimmed', () => {
  const ok = G.validateFeedback({ rating: 5, tags: ['Coffee', 'Hacked', 'Service'], comment: '  Lovely!\nThanks ', phone: '' });
  assert.equal(ok.value.rating, 5);
  assert.deepEqual(ok.value.tags, ['Coffee', 'Service']);
  assert.equal(ok.value.comment, 'Lovely!\nThanks');
  for (const rating of [0, 6, 4.5, '']) assert.match(G.validateFeedback({ rating }).error, /rating/, String(rating));
  assert.match(G.validateFeedback({ rating: 3, phone: '12' }).error, /mobile/);
});

test('loyalty settings fall back to defaults', () => {
  assert.deepEqual(G.loyaltySettings({}), { enabled: true, stampsForReward: 9, reward: 'a coffee on us' });
  assert.equal(G.loyaltySettings({ loyalty: { stampsForReward: 1 } }).stampsForReward, 9);
  assert.equal(G.loyaltySettings({ loyalty: { stampsForReward: 6, enabled: false } }).enabled, false);
});

test('only a first name is revealed by a card look-up', () => {
  assert.equal(G.firstName('  Asha   Rathore '), 'Asha');
  assert.equal(G.firstName(''), '');
});

test('order codes are short and unambiguous', () => {
  assert.match(G.orderCode(Buffer.from([0, 9, 200, 255])), /^[A-HJ-NP-Z2-9]{4}$/);
});

console.log(`\n${passed} passed`);
