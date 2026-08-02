/* =============================================================================
 * TCM BrewOps — accounts and access control
 * -----------------------------------------------------------------------------
 * There is no SMS, no one-time code and no self-registration anywhere in this
 * system. Two ways in, and only two:
 *
 *   Owner   signs in with an email address and password. Exactly one account,
 *           fixed by the OWNER_EMAIL parameter at deploy time. It cannot be
 *           created, renamed or granted from inside the app.
 *
 *   User    an account the owner creates: a username, an access key the owner
 *           issues, a role, and a tick-list of what that person may open.
 *           Users never register themselves and never hold a Firebase
 *           credential of their own — the server mints their session after
 *           checking the access key against a stored hash.
 *
 * Because users have no email or phone attached, the ONLY sign-in provider this
 * project needs enabled is Email/Password, for the owner. No phone provider, no
 * SMS region policy, no reCAPTCHA — the machinery that kept failing is gone.
 *
 * ---------------------------------------------------------------------------
 * DEPLOYING
 * ---------------------------------------------------------------------------
 *   npm run deploy:auth
 *
 * which deploys these functions BY NAME. The existing scanInvoice function's
 * source is not in this repository, and a bare `--only functions` would delete
 * it. The first deploy prompts for OWNER_EMAIL. See SETUP.md.
 * ========================================================================== */

const functions = require('firebase-functions/v1');
const { defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();

const db = admin.firestore();

// Prompted for on the first deploy, then remembered in .env.<project>.
// An email address is not a secret; the password is what protects the account.
const OWNER_EMAIL = defineString('OWNER_EMAIL', {
  description: 'Owner email address, e.g. you@example.com'
});

const USERS = 'users';            // one document per account, keyed by username
const INDEX = 'userIndex';        // the same account keyed by uid, for the rules
const SECRETS = '_userSecrets';   // access-key hashes; no client may read this
const THROTTLE = '_authThrottle';

// -----------------------------------------------------------------------------
// Permissions
// -----------------------------------------------------------------------------
// One flag per area of the app. The owner implicitly holds all of them; every
// other account holds exactly what the owner ticked. firestore.rules reads the
// same flags straight from the user document, so hiding a button and refusing
// the write are driven by one source of truth.
const PERMISSIONS = [
  'requests',      // raise material requests
  'recipesView',   // read the recipe book
  'recipesAdd',    // add new recipes
  'recipesEdit',   // change or delete existing recipes
  'receive',       // book in deliveries against a purchase order
  'poManage',      // create, amend and cancel purchase orders
  'inventory',     // edit the raw-material catalogue and prep rules
  'prices',        // see and edit cost prices and food cost
  'vendors',       // manage the vendor directory
  'team'           // create and manage other users
];

// Sensible starting points the owner can adjust per person.
const ROLE_PRESETS = {
  staff:   { requests: true, recipesView: true, recipesAdd: true, receive: true },
  manager: { requests: true, recipesView: true, recipesAdd: true, recipesEdit: true,
             receive: true, poManage: true, inventory: true, vendors: true },
  viewer:  { recipesView: true }
};

/** The owner implicitly holds everything. */
function ownerPerms() {
  const out = {};
  PERMISSIONS.forEach((p) => { out[p] = true; });
  return out;
}

function cleanPerms(input) {
  const out = {};
  const given = input && typeof input === 'object' ? input : {};
  PERMISSIONS.forEach((p) => { out[p] = given[p] === true; });
  // Only the owner administers accounts. Handing this to a user would let them
  // grant themselves everything else, which defeats the whole arrangement.
  out.team = false;
  return out;
}

// -----------------------------------------------------------------------------
// Access keys
// -----------------------------------------------------------------------------
// scrypt at N=16384 takes ~50-100ms to verify: slow enough to make offline brute
// force expensive, fast enough for an interactive sign-in.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function scryptHash(secret, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(secret), salt, SCRYPT.keylen, SCRYPT, (err, derived) =>
      err ? reject(err) : resolve(derived));
  });
}

async function hashKey(key) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${(await scryptHash(key, salt)).toString('hex')}`;
}

async function keyMatches(key, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  let salt, expected;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch (_) { return false; }
  if (!salt.length || expected.length !== SCRYPT.keylen) return false;
  return crypto.timingSafeEqual(expected, await scryptHash(key, salt));
}

/**
 * Access keys are 6-64 characters and must not be trivially guessable.
 * Deliberately looser than the old PIN rule, which rejected so much that people
 * could not find one it would accept.
 */
function keyProblem(key) {
  const k = String(key || '');
  if (k.length < 6) return 'Use at least 6 characters';
  if (k.length > 64) return 'Use at most 64 characters';
  if (/^(.)\1+$/.test(k)) return 'Not the same character repeated';
  if (/^\d+$/.test(k)) {
    if ('01234567890123456789'.includes(k)) return 'Not a run like 123456';
    if ('09876543210987654321'.includes(k)) return 'Not a run like 654321';
  }
  const common = ['password', 'passw0rd', 'qwerty', 'abc123', 'letmein', 'welcome',
                  'admin1', 'iloveyou', 'monkey', 'dragon', 'brewops', 'caffeine'];
  if (common.indexOf(k.toLowerCase()) !== -1) return 'That one is too widely used';
  return null;
}

/** A readable key the owner can hand over verbally. Avoids look-alike glyphs. */
function suggestKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I, O, 0, 1
  const bytes = crypto.randomBytes(9);
  let out = '';
  for (let i = 0; i < 9; i++) {
    if (i === 3 || i === 6) out += '-';
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

// -----------------------------------------------------------------------------
// Usernames
// -----------------------------------------------------------------------------
/** Lower-case, letters/digits/dot/underscore/hyphen. Doubles as the doc id. */
function normalizeUsername(name) {
  return String(name || '').trim().toLowerCase();
}

function usernameProblem(name) {
  const u = normalizeUsername(name);
  if (u.length < 3) return 'Username needs at least 3 characters';
  if (u.length > 32) return 'Username is too long';
  if (!/^[a-z0-9._-]+$/.test(u)) return 'Letters, numbers, dot, dash and underscore only';
  if (u === 'owner' || u === 'admin') return 'That username is reserved';
  return null;
}

// -----------------------------------------------------------------------------
// Guards
// -----------------------------------------------------------------------------
function requireSignedIn(context) {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in first.');
  }
  return context.auth.uid;
}

function isOwnerEmail(email) {
  const configured = (OWNER_EMAIL.value() || '').trim().toLowerCase();
  return !!configured && String(email || '').trim().toLowerCase() === configured;
}

function requireOwner(context) {
  requireSignedIn(context);
  const tok = context.auth.token || {};
  // Check the claim AND the email, so a stale claim on a renamed account cannot
  // keep owner powers.
  if (tok.role !== 'owner' || !isOwnerEmail(tok.email)) {
    throw new functions.https.HttpsError('permission-denied', 'Owner only.');
  }
  return context.auth.uid;
}

// -----------------------------------------------------------------------------
// Rate limiting
// -----------------------------------------------------------------------------
const MAX_ATTEMPTS = 10;
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

/**
 * Write an account to both places it lives.
 *
 * `users` is keyed by username, because that is what makes the name unique and
 * what the owner browses. `userIndex` is the same record keyed by uid, because
 * firestore.rules only knows the caller's uid and cannot run a query — it needs
 * a direct document path to read status and permissions from.
 */
async function writeAccount(username, uid, patch, merge) {
  const batch = db.batch();
  batch.set(db.collection(USERS).doc(username), patch, { merge: merge !== false });
  batch.set(db.collection(INDEX).doc(uid), patch, { merge: merge !== false });
  await batch.commit();
}

async function deleteAccount(username, uid) {
  const batch = db.batch();
  batch.delete(db.collection(USERS).doc(username));
  batch.delete(db.collection(INDEX).doc(uid));
  await batch.commit();
}

// =============================================================================
// setupOwner — one-time bootstrap, creates the owner's email/password account.
// =============================================================================
// Refuses once the owner account exists, so it cannot be replayed to take over.
exports.setupOwner = functions.runWith({ memory: '256MB', timeoutSeconds: 60 })
  .https.onCall(async (data) => {
    const email = String(data?.email || '').trim().toLowerCase();
    const password = String(data?.password || '');

    if (!isOwnerEmail(email)) {
      throw new functions.https.HttpsError('permission-denied',
        'That address is not the configured owner address.');
    }
    if (password.length < 10) {
      throw new functions.https.HttpsError('invalid-argument',
        'Use an owner password of at least 10 characters.');
    }

    try {
      await admin.auth().getUserByEmail(email);
      throw new functions.https.HttpsError('already-exists',
        'The owner account already exists. Sign in, or reset the password from the Firebase console.');
    } catch (err) {
      if (err instanceof functions.https.HttpsError) throw err;
      // auth/user-not-found is the expected path: create it.
    }

    const user = await admin.auth().createUser({
      email, password, emailVerified: true, displayName: 'Owner'
    });
    await admin.auth().setCustomUserClaims(user.uid, { role: 'owner' });

    await writeAccount('owner', user.uid, {
      uid: user.uid, username: 'owner', name: 'Owner', role: 'owner',
      status: 'active', perms: ownerPerms(), isOwner: true,
      createdAt: stamp(), updatedAt: stamp()
    });

    functions.logger.info('owner account created', { uid: user.uid });
    return { ok: true };
  });

// =============================================================================
// claimOwner — called right after the owner signs in with email + password.
// =============================================================================
exports.claimOwner = functions.runWith({ memory: '256MB', timeoutSeconds: 30 })
  .https.onCall(async (data, context) => {
    const uid = requireSignedIn(context);
    const email = (context.auth.token && context.auth.token.email) || '';

    if (!isOwnerEmail(email)) {
      // Someone signed in with a Firebase account that is not the owner. They
      // get no role at all, so the rules treat them as a stranger.
      //
      // Swallow any failure from clearing the claim: the refusal below is the
      // answer that matters, and letting a raw auth/* error escape here would
      // replace a clear "no access" with something meaningless to the caller.
      await admin.auth().setCustomUserClaims(uid, { role: null }).catch(() => {});
      throw new functions.https.HttpsError('permission-denied',
        'This account does not have access.');
    }

    await admin.auth().setCustomUserClaims(uid, { role: 'owner' });
    await writeAccount('owner', uid, {
      uid, username: 'owner', name: 'Owner', role: 'owner', status: 'active',
      perms: ownerPerms(), isOwner: true, lastSeenAt: stamp(), updatedAt: stamp()
    });

    functions.logger.info('owner signed in', { uid });
    return { role: 'owner', name: 'Owner', perms: ownerPerms(), isOwner: true };
  });

// =============================================================================
// createUser — the owner adds an account.
// =============================================================================
exports.createUser = functions.runWith({ memory: '256MB', timeoutSeconds: 60 })
  .https.onCall(async (data, context) => {
    const ownerUid = requireOwner(context);

    const username = normalizeUsername(data?.username);
    const name = String(data?.name || '').trim().slice(0, 60);
    const role = ROLE_PRESETS[data?.role] ? data.role : 'staff';
    const accessKey = String(data?.accessKey || '');

    const uProblem = usernameProblem(username);
    if (uProblem) throw new functions.https.HttpsError('invalid-argument', uProblem);
    if (!name) throw new functions.https.HttpsError('invalid-argument', 'Give the person a name.');

    const kProblem = keyProblem(accessKey);
    if (kProblem) throw new functions.https.HttpsError('invalid-argument', kProblem);

    // The username is the document id, so this reservation is atomic.
    const ref = db.collection(USERS).doc(username);
    if ((await ref.get()).exists) {
      throw new functions.https.HttpsError('already-exists', 'That username is taken.');
    }

    // Users hold no email or phone: the server mints their session, so there is
    // no provider credential for anyone to guess or reset.
    const authUser = await admin.auth().createUser({ displayName: name });

    const perms = cleanPerms(
      data?.perms && typeof data.perms === 'object' ? data.perms : ROLE_PRESETS[role]);

    await writeAccount(username, authUser.uid, {
      uid: authUser.uid, username, name, role, status: 'active', perms,
      isOwner: false, mustChangeKey: true,
      createdBy: ownerUid, createdAt: stamp(), updatedAt: stamp()
    }, false);
    await db.collection(SECRETS).doc(authUser.uid).set({
      keyHash: await hashKey(accessKey), username, updatedAt: stamp()
    });
    await admin.auth().setCustomUserClaims(authUser.uid, { role: 'user' });

    functions.logger.info('user created', { username, role, by: ownerUid });
    return { ok: true, username, uid: authUser.uid };
  });

// =============================================================================
// updateUser — change a name, role, permissions or status.
// =============================================================================
exports.updateUser = functions.runWith({ memory: '256MB', timeoutSeconds: 30 })
  .https.onCall(async (data, context) => {
    const ownerUid = requireOwner(context);
    const username = normalizeUsername(data?.username);

    const ref = db.collection(USERS).doc(username);
    const snap = await ref.get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found', 'No such user.');
    if (snap.data().isOwner) {
      throw new functions.https.HttpsError('failed-precondition',
        'The owner account cannot be changed here.');
    }

    const patch = { updatedAt: stamp() };
    if (typeof data?.name === 'string' && data.name.trim()) patch.name = data.name.trim().slice(0, 60);
    if (ROLE_PRESETS[data?.role]) patch.role = data.role;
    if (data?.perms && typeof data.perms === 'object') patch.perms = cleanPerms(data.perms);
    if (data?.status === 'active' || data?.status === 'suspended') patch.status = data.status;

    await writeAccount(username, snap.data().uid, patch);

    // The rules read permissions from this document on every request, so a
    // change takes effect on the very next operation. Dropping the refresh
    // tokens as well means a suspended person cannot keep an open tab working.
    if (patch.status === 'suspended') {
      await admin.auth().revokeRefreshTokens(snap.data().uid).catch(() => {});
      await admin.auth().setCustomUserClaims(snap.data().uid, { role: null }).catch(() => {});
    } else if (patch.status === 'active') {
      await admin.auth().setCustomUserClaims(snap.data().uid, { role: 'user' }).catch(() => {});
    }

    functions.logger.info('user updated', { username, by: ownerUid, keys: Object.keys(patch) });
    return { ok: true };
  });

// =============================================================================
// resetAccessKey — the owner issues a new key (someone forgot theirs).
// =============================================================================
exports.resetAccessKey = functions.runWith({ memory: '256MB', timeoutSeconds: 30 })
  .https.onCall(async (data, context) => {
    const ownerUid = requireOwner(context);
    const username = normalizeUsername(data?.username);
    const accessKey = String(data?.accessKey || '');

    const problem = keyProblem(accessKey);
    if (problem) throw new functions.https.HttpsError('invalid-argument', problem);

    const snap = await db.collection(USERS).doc(username).get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found', 'No such user.');
    if (snap.data().isOwner) {
      throw new functions.https.HttpsError('failed-precondition',
        'Change the owner password in the Firebase console.');
    }

    await db.collection(SECRETS).doc(snap.data().uid).set({
      keyHash: await hashKey(accessKey), username, updatedAt: stamp()
    });
    await writeAccount(username, snap.data().uid, { mustChangeKey: true, updatedAt: stamp() });
    await admin.auth().revokeRefreshTokens(snap.data().uid).catch(() => {});

    functions.logger.info('access key reset', { username, by: ownerUid });
    return { ok: true };
  });

// =============================================================================
// deleteUser — remove an account entirely.
// =============================================================================
exports.deleteUser = functions.runWith({ memory: '256MB', timeoutSeconds: 30 })
  .https.onCall(async (data, context) => {
    const ownerUid = requireOwner(context);
    const username = normalizeUsername(data?.username);

    const ref = db.collection(USERS).doc(username);
    const snap = await ref.get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found', 'No such user.');
    if (snap.data().isOwner) {
      throw new functions.https.HttpsError('failed-precondition',
        'The owner account cannot be deleted.');
    }

    const uid = snap.data().uid;
    await deleteAccount(username, uid);
    await db.collection(SECRETS).doc(uid).delete().catch(() => {});
    await admin.auth().deleteUser(uid).catch(() => {});

    functions.logger.info('user deleted', { username, by: ownerUid });
    return { ok: true };
  });

// =============================================================================
// signIn — a user signs in with their username and access key.
// =============================================================================
exports.signIn = functions.runWith({ memory: '256MB', timeoutSeconds: 30 })
  .https.onCall(async (data, context) => {
    const username = normalizeUsername(data?.username);
    const accessKey = String(data?.accessKey || '');

    if (!username || !accessKey) {
      throw new functions.https.HttpsError('invalid-argument', 'Enter your username and access key.');
    }

    const state = await checkThrottle(throttleId([clientIp(context), username]));
    if (!state.allowed) {
      throw new functions.https.HttpsError('resource-exhausted',
        `Too many attempts. Try again in ${Math.ceil(state.retryAfterSec / 60)} minute(s).`);
    }

    // The same message whether the username is unknown or the key is wrong, so
    // the sign-in screen cannot be used to discover who works here.
    const deny = () => new functions.https.HttpsError('permission-denied',
      'Username or access key is wrong.');

    const snap = await db.collection(USERS).doc(username).get();
    if (!snap.exists) { await recordFailure(state); throw deny(); }

    const user = snap.data();
    if (user.isOwner) {
      await clearThrottle(state);
      throw new functions.https.HttpsError('failed-precondition',
        'The owner signs in with an email address and password.');
    }

    const secret = await db.collection(SECRETS).doc(user.uid).get();
    if (!secret.exists) { await recordFailure(state); throw deny(); }
    if (!await keyMatches(accessKey, secret.data().keyHash)) {
      await recordFailure(state);
      throw deny();
    }

    if (user.status !== 'active') {
      await clearThrottle(state);
      throw new functions.https.HttpsError('permission-denied',
        'This account has been suspended. Speak to the owner.');
    }

    await clearThrottle(state);
    await admin.auth().setCustomUserClaims(user.uid, { role: 'user' });
    await writeAccount(username, user.uid, { lastSeenAt: stamp() });

    const token = await admin.auth().createCustomToken(user.uid, { role: 'user' });
    functions.logger.info('user signed in', { username });

    return {
      token,
      role: user.role,
      name: user.name,
      perms: cleanPerms(user.perms),
      mustChangeKey: !!user.mustChangeKey
    };
  });

// =============================================================================
// changeMyKey — a signed-in user replaces their own access key.
// =============================================================================
exports.changeMyKey = functions.runWith({ memory: '256MB', timeoutSeconds: 30 })
  .https.onCall(async (data, context) => {
    const uid = requireSignedIn(context);
    const current = String(data?.current || '');
    const next = String(data?.next || '');

    const problem = keyProblem(next);
    if (problem) throw new functions.https.HttpsError('invalid-argument', problem);

    const secretRef = db.collection(SECRETS).doc(uid);
    const secret = await secretRef.get();
    if (!secret.exists) {
      throw new functions.https.HttpsError('failed-precondition', 'This account has no access key.');
    }
    if (!await keyMatches(current, secret.data().keyHash)) {
      throw new functions.https.HttpsError('permission-denied', 'Your current access key is wrong.');
    }
    if (current === next) {
      throw new functions.https.HttpsError('invalid-argument', 'Choose a different key from the current one.');
    }

    await secretRef.set({ keyHash: await hashKey(next), updatedAt: stamp() }, { merge: true });

    const username = secret.data().username;
    if (username) {
      await writeAccount(username, uid, { mustChangeKey: false, updatedAt: stamp() });
    }

    functions.logger.info('access key changed', { uid });
    return { ok: true };
  });

// =============================================================================
// me — who is this session, and what may they open?
// =============================================================================
exports.me = functions.runWith({ memory: '256MB', timeoutSeconds: 20 })
  .https.onCall(async (data, context) => {
    const uid = requireSignedIn(context);
    const tok = context.auth.token || {};

    if (tok.role === 'owner' && isOwnerEmail(tok.email)) {
      return { role: 'owner', name: 'Owner', isOwner: true, perms: cleanPerms({}), signedIn: true };
    }

    const found = await db.collection(INDEX).doc(uid).get();
    if (!found.exists) return { role: null, signedIn: false };

    const user = found.data();
    if (user.status !== 'active') return { role: null, signedIn: false, suspended: true };

    return {
      role: user.role,
      name: user.name,
      username: user.username,
      isOwner: false,
      perms: cleanPerms(user.perms),
      mustChangeKey: !!user.mustChangeKey,
      signedIn: true
    };
  });

// =============================================================================
// suggestAccessKey — a readable random key for the owner to hand over.
// =============================================================================
exports.suggestAccessKey = functions.runWith({ memory: '128MB', timeoutSeconds: 15 })
  .https.onCall(async (data, context) => {
    requireOwner(context);
    return { accessKey: suggestKey() };
  });

// A reusable guard for other callables (notably scanInvoice) lives in
// ./lib/auth-guard.js. It is deliberately NOT exported from this file: the
// Firebase CLI treats every export of index.js as a deployable function.
