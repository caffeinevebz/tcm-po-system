/* =============================================================================
 * TCM BrewOps — authentication backend
 * -----------------------------------------------------------------------------
 * verifyPin() replaces the old client-side check in index.html, where the owner
 * and staff PINs sat in plain JavaScript and anyone could read them from View
 * Source (or skip the login entirely by typing /owner.html).
 *
 * Here the PIN is compared against a scrypt hash that never leaves the server,
 * attempts are rate-limited per client IP, and success returns a short-lived
 * Firebase custom token carrying a `role` claim. firestore.rules then enforces
 * what each role may actually read and write.
 *
 * ---------------------------------------------------------------------------
 * DEPLOYING — IMPORTANT
 * ---------------------------------------------------------------------------
 * This project already has a `scanInvoice` function deployed whose source is not
 * in this repository. Deploy by NAME so the CLI does not delete it:
 *
 *     firebase deploy --only functions:verifyPin
 *
 * Do NOT run a bare `firebase deploy --only functions` until scanInvoice's
 * source has been moved into this folder — that would remove it.
 *
 * See SECURITY.md for the full first-time setup (generating the PIN hashes,
 * publishing the Firestore rules, and hardening scanInvoice).
 * ========================================================================== */

const functions = require('firebase-functions/v1');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();

// Generate these with:  node scripts/hash-pin.js <pin>
// Store them with:      firebase functions:secrets:set OWNER_PIN_HASH
const OWNER_PIN_HASH = defineSecret('OWNER_PIN_HASH');
const STAFF_PIN_HASH = defineSecret('STAFF_PIN_HASH');

// --- Throttling ------------------------------------------------------------
const MAX_ATTEMPTS = 8;             // failures allowed inside the window
const WINDOW_MS = 15 * 60 * 1000;   // rolling window
const LOCKOUT_MS = 15 * 60 * 1000;  // how long a tripped client stays locked out

const THROTTLE_COLLECTION = '_authThrottle';

const db = admin.firestore();

/**
 * scrypt parameters. N=16384 keeps verification around ~50-100ms, which is slow
 * enough to make offline brute force of a 4-6 digit PIN expensive but fast
 * enough for an interactive login.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function scryptHash(pin, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pin), salt, SCRYPT.keylen, SCRYPT, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/**
 * Compare a PIN against a stored "saltHex:hashHex" record in constant time.
 * Returns false rather than throwing on a malformed record so that a
 * misconfigured secret is a failed login, not a 500.
 */
async function pinMatches(pin, stored) {
  if (typeof stored !== 'string' || stored.indexOf(':') === -1) return false;

  const [saltHex, hashHex] = stored.split(':');
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch (_) {
    return false;
  }
  if (!salt.length || expected.length !== SCRYPT.keylen) return false;

  const actual = await scryptHash(pin, salt);
  return crypto.timingSafeEqual(expected, actual);
}

/** Don't store raw IPs; a keyed digest is enough to count attempts. */
function throttleKey(ip) {
  return crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex').slice(0, 40);
}

/**
 * Atomically record an attempt and decide whether this client is allowed to try.
 * Runs before the PIN is checked so a locked-out client burns no CPU.
 */
async function checkThrottle(ip) {
  const ref = db.collection(THROTTLE_COLLECTION).doc(throttleKey(ip));
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};

    if (data.lockedUntil && data.lockedUntil > now) {
      return { allowed: false, retryAfterSec: Math.ceil((data.lockedUntil - now) / 1000) };
    }

    // Window expired (or first ever attempt): start counting again.
    const windowStart = data.windowStart && now - data.windowStart < WINDOW_MS ? data.windowStart : now;
    const fails = windowStart === data.windowStart ? Number(data.fails) || 0 : 0;

    tx.set(ref, { windowStart, fails, lockedUntil: 0, updatedAt: now }, { merge: true });
    return { allowed: true, ref, windowStart, fails };
  });
}

async function recordFailure(state) {
  if (!state.ref) return;
  const fails = state.fails + 1;
  const update = { fails, windowStart: state.windowStart, updatedAt: Date.now() };
  if (fails >= MAX_ATTEMPTS) update.lockedUntil = Date.now() + LOCKOUT_MS;
  await state.ref.set(update, { merge: true });
}

async function recordSuccess(state) {
  if (!state.ref) return;
  await state.ref.delete().catch(() => {});
}

exports.verifyPin = functions
  .runWith({ secrets: [OWNER_PIN_HASH, STAFF_PIN_HASH], memory: '256MB', timeoutSeconds: 20 })
  .https.onCall(async (data, context) => {
    const pin = data && typeof data.pin === 'string' ? data.pin.trim() : '';

    // Cheap shape check before touching Firestore or scrypt.
    if (!/^\d{4,12}$/.test(pin)) {
      throw new functions.https.HttpsError('invalid-argument', 'Terminal denied.');
    }

    const ip = (context.rawRequest && (context.rawRequest.ip ||
      (context.rawRequest.headers && context.rawRequest.headers['x-forwarded-for']))) || 'unknown';

    const state = await checkThrottle(String(ip).split(',')[0].trim());
    if (!state.allowed) {
      throw new functions.https.HttpsError(
        'resource-exhausted',
        `Too many attempts. Try again in ${Math.ceil(state.retryAfterSec / 60)} minute(s).`
      );
    }

    // Always evaluate both roles so response time does not reveal which PIN was
    // closer to correct.
    const [isOwner, isStaff] = await Promise.all([
      pinMatches(pin, OWNER_PIN_HASH.value()),
      pinMatches(pin, STAFF_PIN_HASH.value())
    ]);

    const role = isOwner ? 'owner' : isStaff ? 'staff' : null;

    if (!role) {
      await recordFailure(state);
      throw new functions.https.HttpsError('permission-denied', 'Terminal denied.');
    }

    await recordSuccess(state);

    // One stable uid per role: this is a two-role shop terminal, not per-person
    // accounts. Swap to real user records if you ever need a per-staff audit
    // trail — firestore.rules already keys off the claim, not the uid.
    const token = await admin.auth().createCustomToken(role, { role });

    functions.logger.info('pin login', { role });
    return { token, role };
  });

// A reusable guard for your other callables (notably scanInvoice) lives in
// ./lib/auth-guard.js. It is deliberately NOT exported from this file: the
// Firebase CLI treats every export of index.js as a deployable function.
