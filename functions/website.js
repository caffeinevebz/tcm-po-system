/* =============================================================================
 * The public website — thecaffeineministry.in
 * -----------------------------------------------------------------------------
 * createReservation is the ONLY way a guest can write to the database. The
 * `reservations` collection is closed to every client except the owner, so a
 * visitor cannot read other people's bookings or flood the table directly; they
 * go through here, where the request is validated against the owner's opening
 * hours and rate-limited per network address and per phone number.
 *
 * Deploy with:  npm run deploy:website   (from functions/)
 * ========================================================================== */

const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { validateReservation, referenceCode } = require('./lib/reservation');

const db = admin.firestore();

const RESERVATIONS = 'reservations';
const THROTTLE = '_siteThrottle';

// Generous for a family booking a couple of tables, tight for a script.
const LIMITS = {
  ip:    { max: 6, windowMs: 60 * 60 * 1000 },        // per network address, per hour
  phone: { max: 4, windowMs: 24 * 60 * 60 * 1000 }    // per phone number, per day
};

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
