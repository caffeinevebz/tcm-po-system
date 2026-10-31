/* =============================================================================
 * Guest ordering, feedback and loyalty — pure validation, no Firebase.
 * -----------------------------------------------------------------------------
 * Like ./reservation.js, this takes the request, the owner's settings and the
 * clock, and returns { value } or { error }. ../website.js does the storing.
 *
 * The one rule that matters most: a guest's browser never decides a price. An
 * order names menu item ids and quantities; names and prices are looked up
 * here in the published menu (site/menu), so a tampered request cannot order
 * a ₹300 dish for ₹1.
 * ========================================================================== */

const R = require('./reservation');

const ORDER_DEFAULTS = { tableEnabled: true, takeawayEnabled: true, prepMinutes: 20 };
const LOYALTY_DEFAULTS = { enabled: true, stampsForReward: 9, reward: 'a coffee on us' };

const MAX_LINES = 30;
const MAX_QTY = 20;
const FEEDBACK_TAGS = ['Coffee', 'Food', 'Service', 'Ambience', 'Speed', 'Value'];

function orderSettings(info) {
  const o = info && info.ordering && typeof info.ordering === 'object' ? info.ordering : {};
  const prep = Number(o.prepMinutes);
  return {
    tableEnabled: o.tableEnabled !== false,
    takeawayEnabled: o.takeawayEnabled !== false,
    prepMinutes: Number.isFinite(prep) && prep >= 5 && prep <= 180 ? Math.floor(prep) : ORDER_DEFAULTS.prepMinutes
  };
}

function loyaltySettings(info) {
  const l = info && info.loyalty && typeof info.loyalty === 'object' ? info.loyalty : {};
  const n = Number(l.stampsForReward);
  return {
    enabled: l.enabled !== false,
    stampsForReward: Number.isInteger(n) && n >= 3 && n <= 30 ? n : LOYALTY_DEFAULTS.stampsForReward,
    reward: R.clean(l.reward, 80) || LOYALTY_DEFAULTS.reward
  };
}

/** Is the café open at this instant (Jodhpur time)? */
function isOpenNow(info, now) {
  const s = R.siteSettings(info);
  const t = R.localNow(now);
  if (s.closedWeekdays.includes(R.weekday(t.date)) || s.reservations.closedDates.includes(t.date)) return false;
  return t.minutes >= R.toMinutes(s.open) && t.minutes < R.toMinutes(s.close);
}

/**
 * Takeaway pickup times for today: every 15 minutes from now + preparation
 * time, up to 15 minutes before closing.
 */
function pickupSlots(info, now) {
  const s = R.siteSettings(info);
  const t = R.localNow(now);
  if (s.closedWeekdays.includes(R.weekday(t.date)) || s.reservations.closedDates.includes(t.date)) return [];
  const asPickups = {
    ...s,
    reservations: { ...s.reservations, slotMinutes: 15, lastSeatingMinutes: 15, leadMinutes: orderSettings(info).prepMinutes }
  };
  return R.slotsFor(t.date, asPickups, now);
}

/** Every orderable item in the published menu, by id. */
function menuIndex(menu) {
  const out = new Map();
  ((menu && menu.categories) || []).forEach((c) => {
    if (!c || c.hidden) return;
    (c.items || []).forEach((it) => {
      if (!it || !it.id || it.hidden) return;
      out.set(String(it.id), it);
    });
  });
  return out;
}

const priced = (it) => typeof it.price === 'number' && Number.isFinite(it.price) && it.price >= 0;

/**
 * Validate an order.
 *   type   'table' (needs `table`) or 'takeaway' (needs name, phone, pickupTime)
 *   items  [{ id, qty, note? }]
 */
function validateOrder(input, menu, info, now) {
  const d = input && typeof input === 'object' ? input : {};
  const o = orderSettings(info);
  const type = d.type === 'takeaway' ? 'takeaway' : d.type === 'table' ? 'table' : null;
  if (!type) return { error: 'Unknown order type.' };

  if (type === 'table' && !o.tableEnabled) return { error: 'Ordering from the table is paused. Please order at the counter.' };
  if (type === 'takeaway' && !o.takeawayEnabled) return { error: 'Takeaway orders are paused right now. Please call us.' };

  const index = menuIndex(menu);
  if (!Array.isArray(d.items) || !d.items.length) return { error: 'Your order is empty.' };
  if (d.items.length > MAX_LINES) return { error: 'That is a very big order. Please order at the counter.' };

  const lines = [];
  for (const raw of d.items) {
    const it = index.get(String(raw && raw.id));
    if (!it) return { error: 'Something in your order is no longer on the menu. Please refresh the menu.' };
    if (it.available === false) return { error: `Sorry, ${it.name} has sold out. Please remove it and try again.` };
    if (!priced(it)) return { error: `Please ask a team member to order ${it.name}.` };
    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return { error: `Check the quantity for ${it.name}.` };
    lines.push({ id: String(it.id), name: String(it.name).slice(0, 80), price: it.price, qty, note: R.clean(raw.note, 120) });
  }
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const note = R.clean(d.note, 300);

  // Name and phone are optional at a table (only needed for a loyalty stamp)
  // and required for takeaway, so we can call when it is ready.
  const name = R.clean(d.name, 60);
  const phoneRaw = String(d.phone || '').trim();
  const phone = phoneRaw ? R.normalizePhone(phoneRaw) : '';
  if (phoneRaw && !phone) return { error: 'Enter a 10-digit mobile number.' };

  const today = R.localNow(now).date;
  const base = { type, lines, total, note, name, phone, date: today };

  if (type === 'table') {
    const table = String(d.table || '').replace(/[^0-9A-Za-z-]/g, '').slice(0, 6);
    if (!table) return { error: 'Scan the QR code on your table to order.' };
    if (!isOpenNow(info, now)) return { error: 'The kitchen is closed right now.' };
    return { value: { ...base, table, pickupTime: '' } };
  }

  if (name.length < 2) return { error: 'Tell us your name for the order.' };
  if (!phone) return { error: 'We need your mobile number for a takeaway order.' };
  const pickupTime = String(d.pickupTime || '');
  const slots = pickupSlots(info, now);
  if (!slots.length) return { error: 'We are not taking more takeaway orders today.' };
  if (!slots.includes(pickupTime)) return { error: 'Choose a pickup time from the list.' };
  return { value: { ...base, table: '', pickupTime } };
}

function validateFeedback(input) {
  const d = input && typeof input === 'object' ? input : {};
  const rating = Number(d.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { error: 'Choose a rating from 1 to 5 stars.' };
  const tags = Array.isArray(d.tags) ? d.tags.filter((t) => FEEDBACK_TAGS.includes(t)).slice(0, FEEDBACK_TAGS.length) : [];
  const comment = String(d.comment == null ? '' : d.comment).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 1000);
  const name = R.clean(d.name, 60);
  const phoneRaw = String(d.phone || '').trim();
  const phone = phoneRaw ? R.normalizePhone(phoneRaw) : '';
  if (phoneRaw && !phone) return { error: 'That mobile number looks wrong. Leave it empty if you prefer.' };
  const visit = R.clean(d.visit, 20);    // an order or booking reference, if they came from one
  return { value: { rating, tags, comment, name, phone, visit } };
}

/** First name only, so a phone-number lookup reveals as little as possible. */
function firstName(name) {
  return R.clean(name, 60).split(' ')[0] || '';
}

/** Short order code that staff can call out: e.g. "K7Q2". */
function orderCode(randomBytes) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += alphabet[randomBytes[i] % alphabet.length];
  return out;
}

module.exports = {
  ORDER_DEFAULTS, LOYALTY_DEFAULTS, FEEDBACK_TAGS, MAX_QTY,
  orderSettings, loyaltySettings, isOpenNow, pickupSlots, menuIndex,
  validateOrder, validateFeedback, firstName, orderCode
};
