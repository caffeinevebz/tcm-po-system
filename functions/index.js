/* =============================================================================
 * TCM BrewOps — authentication backend
 * -----------------------------------------------------------------------------
 * Identity model
 *
 *   Owner    exactly one person, identified by the number configured as
 *            OWNER_PHONE. Full access. Cannot be invited or revoked.
 *
 *   Staff    invite-only. The owner adds a mobile number to the team list
 *            first; only a number that already appears there can register.
 *            An uninvited number is refused even with a valid SMS code, so a
 *            stranger cannot sign themselves up.
 *
 * Everyone signs in the first time with phone + OTP, then sets a PIN so the
 * daily sign-in on the shop tablet is instant and costs no SMS.
 *
 * The OTP is handled by Firebase Phone Authentication — Google sends the SMS,
 * enforces retry limits and runs the anti-abuse checks. This file only decides
 * what a *verified* phone number is allowed to become.
 *
 * ---------------------------------------------------------------------------
 * DEPLOYING
 * ---------------------------------------------------------------------------
 *   npm run deploy:auth
 *
 * which deploys these four functions BY NAME. The existing scanInvoice
 * function's source is not in this repository, and a bare `--only functions`
 * would delete it.
 *
 * The first deploy prompts for OWNER_PHONE. Enter your number in international
 * form, e.g. +919876543210. See SETUP.md.
 * ========================================================================== */

const functions = require('firebase-functions/v1');
const { defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();

const db = admin.firestore();

// Prompted for on the first deploy, then remembered in .env.<project>.
// A phone number is not a secret, so this is a plain parameter rather than a
// Secret Manager entry — one less thing to set up.
const OWNER_PHONE = defineString('OWNER_PHONE', {
  description: 'Owner mobile number in international format, e.g. +919876543210'
});

const TEAM = 'staffMembers';       // keyed by phoneKey, readable by the owner
const SECRETS = '_staffSecrets';   // PIN hashes, keyed by uid; no client access
const THROTTLE = '_authThrottle';

// --- phone numbers ----------------------------------------------------------

function digitsOf(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/**
 * Stable document id for a number, independent of how it was typed.
 * The last 10 digits identify an Indian mobile whether it arrived as
 * 9876543210, 09876543210, +91 98765 43210 or 919876543210.
 */
function phoneKey(phone) {
  const d = digitsOf(phone);
  return d.length > 10 ? d.slice(-10) : d;
}

function samePhone(a, b) {
  const ka = phoneKey(a), kb = phoneKey(b);
  return !!ka && ka === kb;
}

function isOwnerPhone(phone) {
  const configured = OWNER_PHONE.value();
  return !!configured && samePhone(phone, configured);
}

// --- PIN hashing ------------------------------------------------------------
// scrypt at N=16384 takes ~50-100ms to verify: slow enough to make offline
// brute force of a short PIN expensive, fast enough for an interactive login.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function scryptHash(pin, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pin), salt, SCRYPT.keylen, SCRYPT, (err, derived) =>
      err ? reject(err) : resolve(derived));
  });
}

async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptHash(pin, salt);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function pinMatches(pin, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  let salt, expected;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch (_) { return false; }
  if (!salt.length || expected.length !== SCRYPT.keylen) return false;
  return crypto.timingSafeEqual(expected, await scryptHash(pin, salt));
}

function isValidPin(pin) {
  if (!/^\d{4,8}$/.test(pin)) return false;
  if (/^(\d)\1+$/.test(pin)) return false;                 // 0000, 111111
  if ('01234567890'.includes(pin)) return false;           // 1234, 4567
  if ('09876543210'.includes(pin)) return false;           // 4321, 9876
  return true;
}

// --- guards -----------------------------------------------------------------

function requireSignedIn(context) {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in first.');
  }
  return context.auth.uid;
}

function requireOwner(context) {
  requireSignedIn(context);
  if (context.auth.token.role !== 'owner') {
    throw new functions.https.HttpsError('permission-denied', 'Owner only.');
  }
  return context.auth.uid;
}

function callerPhone(context) {
  return (context.auth && context.auth.token && context.auth.token.phone_number) || '';
}

// --- throttling -------------------------------------------------------------
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

function throttleId(parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);
}

async function checkThrottle(id) {
  const ref = db.collection(THROTTLE).doc(id);
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};

    if (data.lockedUntil && data.lockedUntil > now) {
      return { allowed: false, retryAfterSec: Math.ceil((data.lockedUntil - now) / 1000) };
    }
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

async function clearThrottle(state) {
  if (state.ref) await state.ref.delete().catch(() => {});
}

function clientIp(context) {
  const raw = (context.rawRequest && (context.rawRequest.ip ||
    (context.rawRequest.headers && context.rawRequest.headers['x-forwarded-for']))) || 'unknown';
  return String(raw).split(',')[0].trim();
}

const stamp = () => admin.firestore.FieldValue.serverTimestamp();

// =============================================================================
// inviteStaff — the owner adds a mobile number to the team.
// Until a number appears here, it cannot register, OTP or no OTP.
// =============================================================================
exports.inviteStaff = functions.runWith({ memory: '256MB', timeoutSeconds: 30 })
  .https.onCall(async (data, context) => {
    requireOwner(context);

    const phone = typeof data?.phone === 'string' ? data.phone.trim() : '';
    const name = typeof data?.name === 'string' ? data.name.trim().slice(0, 60) : '';
    const key = phoneKey(phone);

    if (key.length < 10) {
      throw new functions.https.HttpsError('invalid-argument',
        'Enter a full mobile number.');
    }
    if (!name) {
      throw new functions.https.HttpsError('invalid-argument',
        'Give the person a name so you can recognise them later.');
    }
    if (isOwnerPhone(phone)) {
      throw new functions.https.HttpsError('failed-precondition',
        'That is the owner number — it already has full access.');
    }

    const ref = db.collection(TEAM).doc(key);
    const existing = await ref.get();

    if (existing.exists && existing.data().status === 'active') {
      throw new functions.https.HttpsError('already-exists',
        `${existing.data().name || 'That number'} has already joined.`);
    }

    await ref.set({
      phoneKey: key,
      phone: digitsOf(phone).length > 10 ? '+' + digitsOf(phone) : '+91' + key,
      name,
      role: 'staff',
      status: 'invited',
      hasPin: false,
      invitedBy: context.auth.uid,
      invitedAt: stamp(),
      updatedAt: stamp()
    }, { merge: true });

    functions.logger.info('staff invited', { key, by: context.auth.uid });
    return { ok: true, phoneKey: key, name };
  });

// =============================================================================
// claimRole — called right after a successful phone/OTP sign-in.
// Decides what this verified number is, and writes the role custom claim.
// =============================================================================
exports.claimRole = functions.runWith({ memory: '256MB', timeoutSeconds: 30 })
  .https.onCall(async (data, context) => {
    const uid = requireSignedIn(context);
    const phone = callerPhone(context);

    if (!phone) {
      throw new functions.https.HttpsError('failed-precondition',
        'This account has no verified mobile number.');
    }

    // --- the owner ---------------------------------------------------------
    if (isOwnerPhone(phone)) {
      await admin.auth().setCustomUserClaims(uid, { role: 'owner' });
      functions.logger.info('owner signed in', { uid });
      return { role: 'owner', status: 'active' };
    }

    if (!OWNER_PHONE.value()) {
      throw new functions.https.HttpsError('failed-precondition',
        'No owner number is configured. Re-deploy and set OWNER_PHONE.');
    }

    // --- staff: must have been invited first --------------------------------
    const key = phoneKey(phone);
    const ref = db.collection(TEAM).doc(key);
    const snap = await ref.get();

    if (!snap.exists) {
      // Verified their number, but nobody put it on the team list.
      await admin.auth().setCustomUserClaims(uid, { role: null });
      throw new functions.https.HttpsError('permission-denied',
        'This number has not been added to the team. Ask the owner to send you an invite.');
    }

    const member = snap.data();

    if (member.status === 'revoked') {
      await admin.auth().setCustomUserClaims(uid, { role: null });
      throw new functions.https.HttpsError('permission-denied',
        'This account has been removed. Speak to the owner.');
    }

    // First registration against the invite, or a returning member on a new
    // device (Firebase issues the same uid for the same number, but re-binding
    // is harmless and keeps the record correct).
    await ref.set({
      uid,
      status: 'active',
      joinedAt: member.joinedAt || stamp(),
      lastSeenAt: stamp(),
      updatedAt: stamp()
    }, { merge: true });

    await admin.auth().setCustomUserClaims(uid, { role: 'staff' });

    functions.logger.info('staff signed in', { uid, key, firstTime: member.status === 'invited' });
    return {
      role: 'staff',
      status: 'active',
      name: member.name || '',
      hasPin: !!member.hasPin,
      isNew: member.status === 'invited'
    };
  });

// =============================================================================
// setPin — store a PIN so future sign-ins on this device skip the SMS.
// =============================================================================
exports.setPin = functions.runWith({ memory: '256MB', timeoutSeconds: 30 })
  .https.onCall(async (data, context) => {
    const uid = requireSignedIn(context);
    const role = context.auth.token.role;

    if (role !== 'owner' && role !== 'staff') {
      throw new functions.https.HttpsError('permission-denied',
        'Your account is not active.');
    }

    const pin = typeof data?.pin === 'string' ? data.pin.trim() : '';
    if (!isValidPin(pin)) {
      throw new functions.https.HttpsError('invalid-argument',
        'Choose 4-8 digits, not all the same and not a run like 1234.');
    }

    const phone = callerPhone(context);

    await db.collection(SECRETS).doc(uid).set({
      pinHash: await hashPin(pin),
      phoneKey: phoneKey(phone),
      role,
      updatedAt: stamp()
    });

    if (role === 'staff') {
      await db.collection(TEAM).doc(phoneKey(phone))
        .set({ hasPin: true, updatedAt: stamp() }, { merge: true });
    }

    functions.logger.info('pin set', { uid, role });
    return { ok: true };
  });

// =============================================================================
// pinSignIn — day-to-day sign-in: mobile number + PIN, no SMS.
// =============================================================================
exports.pinSignIn = functions.runWith({ memory: '256MB', timeoutSeconds: 30 })
  .https.onCall(async (data, context) => {
    const phone = typeof data?.phone === 'string' ? data.phone.trim() : '';
    const pin = typeof data?.pin === 'string' ? data.pin.trim() : '';
    const key = phoneKey(phone);

    if (key.length < 10 || !/^\d{4,8}$/.test(pin)) {
      throw new functions.https.HttpsError('invalid-argument', 'Check the number and PIN.');
    }

    // Throttle on (address + number) so one attacker cannot spray many numbers,
    // and one number cannot be ground down from many addresses.
    const state = await checkThrottle(throttleId([clientIp(context), key]));
    if (!state.allowed) {
      throw new functions.https.HttpsError('resource-exhausted',
        `Too many attempts. Try again in ${Math.ceil(state.retryAfterSec / 60)} minute(s).`);
    }

    // Same message whether the number is unknown or the PIN is wrong, so this
    // cannot be used to discover who works here.
    const deny = () => new functions.https.HttpsError('permission-denied', 'Number or PIN is wrong.');

    let user;
    try {
      user = await admin.auth().getUserByPhoneNumber(
        phone.startsWith('+') ? phone : '+91' + key);
    } catch (_) {
      await recordFailure(state);
      throw deny();
    }

    const secretSnap = await db.collection(SECRETS).doc(user.uid).get();
    if (!secretSnap.exists) {
      await recordFailure(state);
      throw new functions.https.HttpsError('failed-precondition',
        'No PIN set for this number yet. Sign in with an SMS code first.');
    }

    if (!await pinMatches(pin, secretSnap.data().pinHash)) {
      await recordFailure(state);
      throw deny();
    }

    // Re-derive the role from current state; never trust a stale claim. This is
    // what makes revoking someone take effect on their next sign-in.
    let role = null;
    if (isOwnerPhone(user.phoneNumber)) {
      role = 'owner';
    } else {
      const memberSnap = await db.collection(TEAM).doc(key).get();
      if (memberSnap.exists && memberSnap.data().status === 'active') role = 'staff';
    }

    if (!role) {
      await clearThrottle(state);
      throw new functions.https.HttpsError('permission-denied',
        'This account is no longer active. Speak to the owner.');
    }

    await admin.auth().setCustomUserClaims(user.uid, { role });
    await clearThrottle(state);

    if (role === 'staff') {
      await db.collection(TEAM).doc(key).set({ lastSeenAt: stamp() }, { merge: true });
    }

    const token = await admin.auth().createCustomToken(user.uid, { role });
    functions.logger.info('pin sign-in', { uid: user.uid, role });
    return { token, role };
  });

// =============================================================================
// setStaffStatus — the owner removes or restores a team member.
// =============================================================================
exports.setStaffStatus = functions.runWith({ memory: '256MB', timeoutSeconds: 30 })
  .https.onCall(async (data, context) => {
    requireOwner(context);

    const key = phoneKey(typeof data?.phoneKey === 'string' ? data.phoneKey : '');
    const status = typeof data?.status === 'string' ? data.status : '';

    if (key.length < 10 || !['active', 'invited', 'revoked'].includes(status)) {
      throw new functions.https.HttpsError('invalid-argument', 'Bad request.');
    }

    const ref = db.collection(TEAM).doc(key);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new functions.https.HttpsError('not-found', 'No such team member.');
    }

    const member = snap.data();
    await ref.update({ status, updatedAt: stamp() });

    if (member.uid) {
      await admin.auth().setCustomUserClaims(member.uid, { role: status === 'active' ? 'staff' : null });
      // Force any device holding an old token to re-check straight away.
      await admin.auth().revokeRefreshTokens(member.uid).catch(() => {});
      if (status === 'revoked') {
        await db.collection(SECRETS).doc(member.uid).delete().catch(() => {});
        await ref.update({ hasPin: false });
      }
    }

    functions.logger.info('staff status changed', { key, status, by: context.auth.uid });
    return { ok: true, status };
  });

// A reusable guard for other callables (notably scanInvoice) lives in
// ./lib/auth-guard.js. It is deliberately NOT exported from this file: the
// Firebase CLI treats every export of index.js as a deployable function.
