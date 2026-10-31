/* =============================================================================
 * The public website — thecaffeineministry.in
 * -----------------------------------------------------------------------------
 * These callables are the ONLY way a guest can write to the database:
 *
 *   createReservation  a table booking            → reservations/
 *   placeOrder         a table or takeaway order  → orders/
 *   trackOrder         the status of one order, given its secret token
 *   submitFeedback     a rating and comment       → feedback/
 *   loyaltyCard        how many stamps a phone number has
 *
 * Those collections are closed to visitors, so nobody can read another
 * guest's details or flood a collection directly. Everything comes through
 * here, where it is validated against the owner's settings and rate-limited
 * per network address (and, where one is given, per phone number).
 *
 * Deploy with:  npm run deploy:website   (from functions/)
 * ========================================================================== */

const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { validateReservation, referenceCode, normalizePhone } = require('./lib/reservation');
const G = require('./lib/guest');

const db = admin.firestore();

const RESERVATIONS = 'reservations';
const THROTTLE = '_siteThrottle';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Generous for real guests, tight for a script. Table orders allow far more
// per address than bookings because a whole room of guests can share the
// café's own Wi-Fi, and so one address.
const LIMITS = {
  ip:            { max: 6,  windowMs: HOUR },   // bookings, per network address
  phone:         { max: 4,  windowMs: DAY },    // bookings, per phone number
  orderIp:       { max: 60, windowMs: HOUR },
  orderPhone:    { max: 12, windowMs: DAY },
  feedbackIp:    { max: 6,  windowMs: HOUR },
  cardIp:        { max: 30, windowMs: HOUR }
};

const tooMany = (msg) => new functions.https.HttpsError('resource-exhausted', msg);
const bad = (msg) => new functions.https.HttpsError('invalid-argument', msg);
const isBot = (data) => !!(data && typeof data.company === 'string' && data.company.trim());

async function siteDoc(id) {
  const snap = await db.collection('site').doc(id).get();
  return snap.exists ? snap.data() : {};
}

function clientIp(context) {
  const raw = (context.rawRequest && (context.rawRequest.ip ||
    (context.rawRequest.headers && context.rawRequest.headers['x-forwarded-for']))) || 'unknown';
  return String(raw).split(',')[0].trim();
}

const hashed = (kind, value) =>
  kind + '_' + crypto.createHash('sha256').update(kind + '|' + value).digest('hex').slice(0, 40);

/**
 * Count this request against a sliding window. Returns false once the limit is
 * reached. Only hashes are stored, never the address or phone number itself.
 */
async function withinLimit(kind, value) {
  const { max, windowMs } = LIMITS[kind];
  const ref = db.collection(THROTTLE).doc(hashed(kind, value));
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const hits = (snap.exists && Array.isArray(snap.data().hits) ? snap.data().hits : [])
      .filter((t) => now - t < windowMs);
    if (hits.length >= max) return false;
    hits.push(now);
    tx.set(ref, { hits, expiresAt: new Date(now + windowMs) });
    return true;
  });
}

exports.createReservation = functions.runWith({ memory: '256MB', timeoutSeconds: 30 })
  .https.onCall(async (data, context) => {
    // Bots fill every field they find. People never see this one.
    if (data && typeof data.company === 'string' && data.company.trim()) {
      return { ref: referenceCode(crypto.randomBytes(5)), status: 'pending' };
    }

    if (!await withinLimit('ip', clientIp(context))) {
      throw new functions.https.HttpsError('resource-exhausted',
        'Too many booking requests from this connection. Please call or message us instead.');
    }

    const infoSnap = await db.collection('site').doc('info').get();
    const result = validateReservation(data, infoSnap.exists ? infoSnap.data() : {}, new Date());
    if (result.error) throw new functions.https.HttpsError('invalid-argument', result.error);

    const booking = result.value;
    if (!await withinLimit('phone', booking.phone)) {
      throw new functions.https.HttpsError('resource-exhausted',
        'We already have several requests from this number today. We will be in touch shortly.');
    }

    const ref = referenceCode(crypto.randomBytes(5));
    await db.collection(RESERVATIONS).add({
      ...booking,
      ref,
      status: 'pending',
      source: 'website',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    functions.logger.info('reservation requested', { ref, date: booking.date, guests: booking.guests });
    return { ref, status: 'pending', date: booking.date, time: booking.time, guests: booking.guests };
  });

// =============================================================================
// placeOrder — a guest orders from their table, or for takeaway.
// =============================================================================
// Prices and names come from the published menu, never from the request.
// Returns an id and a random token; together they let that guest (and only
// that guest) follow the order's progress on /order.
exports.placeOrder = functions.runWith({ memory: '256MB', timeoutSeconds: 30 })
  .https.onCall(async (data, context) => {
    if (isBot(data)) return { id: 'x', token: 'x', code: G.orderCode(crypto.randomBytes(4)), total: 0 };

    if (!await withinLimit('orderIp', clientIp(context))) {
      throw tooMany('Too many orders from this connection. Please order at the counter.');
    }

    const [info, menu] = await Promise.all([siteDoc('info'), siteDoc('menu')]);
    const result = G.validateOrder(data, menu, info, new Date());
    if (result.error) throw bad(result.error);
    const order = result.value;

    if (order.phone && !await withinLimit('orderPhone', order.phone)) {
      throw tooMany('We already have several orders from this number today. Please order at the counter.');
    }

    const token = crypto.randomBytes(16).toString('hex');
    const code = G.orderCode(crypto.randomBytes(4));
    const ref = await db.collection('orders').add({
      ...order,
      code,
      token,
      status: 'new',
      source: 'website',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    functions.logger.info('order placed', { code, type: order.type, table: order.table, total: order.total });
    return { id: ref.id, token, code, total: order.total };
  });

// =============================================================================
// trackOrder — the guest's own order status, for the /order page.
// =============================================================================
exports.trackOrder = functions.runWith({ memory: '128MB', timeoutSeconds: 15 })
  .https.onCall(async (data) => {
    const id = String(data?.id || '');
    const token = String(data?.token || '');
    if (!/^[A-Za-z0-9]{10,40}$/.test(id) || !/^[a-f0-9]{32}$/.test(token)) throw bad('Order not found.');

    const snap = await db.collection('orders').doc(id).get();
    const o = snap.exists ? snap.data() : null;
    // Same answer for "no such order" and "wrong token": an id alone reveals nothing.
    const digest = (t) => crypto.createHash('sha256').update(String(t)).digest();
    if (!o || !crypto.timingSafeEqual(digest(o.token), digest(token))) {
      throw bad('Order not found.');
    }
    return {
      code: o.code, status: o.status, type: o.type, table: o.table || '', pickupTime: o.pickupTime || '',
      total: o.total, items: (o.lines || []).map((l) => ({ name: l.name, qty: l.qty })),
      phone: !!o.phone, date: o.date
    };
  });

// =============================================================================
// submitFeedback — "How was your visit?"
// =============================================================================
// Stored for the owner only. The reply tells the page whether to offer the
// guest a Google review link (4 or 5 stars, and the owner has set one).
exports.submitFeedback = functions.runWith({ memory: '128MB', timeoutSeconds: 15 })
  .https.onCall(async (data, context) => {
    if (isBot(data)) return { thanks: true, review: '' };
    if (!await withinLimit('feedbackIp', clientIp(context))) {
      throw tooMany('Thank you, we have already received your feedback.');
    }
    const result = G.validateFeedback(data);
    if (result.error) throw bad(result.error);

    await db.collection('feedback').add({
      ...result.value,
      resolved: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const info = await siteDoc('info');
    const review = typeof info.googleReviewUrl === 'string' && /^https:\/\//.test(info.googleReviewUrl)
      ? info.googleReviewUrl : '';
    return { thanks: true, review: result.value.rating >= 4 ? review : '' };
  });

// =============================================================================
// loyaltyCard — "How many stamps do I have?"
// =============================================================================
// Returns only the stamp count and a first name. Stamps themselves are added
// by staff in BrewOps when the guest pays, never by the guest.
exports.loyaltyCard = functions.runWith({ memory: '128MB', timeoutSeconds: 15 })
  .https.onCall(async (data, context) => {
    if (!await withinLimit('cardIp', clientIp(context))) {
      throw tooMany('Too many look-ups. Please try again in a little while.');
    }
    const phone = normalizePhone(data?.phone);
    if (!phone) throw bad('Enter the 10-digit mobile number you gave us.');

    const [info, snap] = await Promise.all([siteDoc('info'), db.collection('loyalty').doc(phone).get()]);
    const rules = G.loyaltySettings(info);
    if (!rules.enabled) throw new functions.https.HttpsError('failed-precondition', 'Our rewards programme is paused right now.');

    const card = snap.exists ? snap.data() : null;
    return {
      found: !!card,
      name: card ? G.firstName(card.name) : '',
      stamps: card ? Math.max(0, Number(card.stamps) || 0) : 0,
      target: rules.stampsForReward,
      reward: rules.reward,
      redeemed: card ? Number(card.redeemed) || 0 : 0
    };
  });
