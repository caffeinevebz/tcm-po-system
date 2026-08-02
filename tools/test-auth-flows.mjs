/**
 * End-to-end tests for the account Cloud Functions, against the Firestore and
 * Auth emulators.
 *
 *   npm run test:auth
 *
 * These walk the journeys a real person takes: the owner bootstrapping, then
 * creating an account, then that person signing in and changing their key. The
 * bug that made the owner redo sign-in every time was only visible across two
 * calls, so single-call tests would not have caught it.
 */
process.env.GCLOUD_PROJECT = 'demo-tcm';
process.env.OWNER_EMAIL = 'owner@caffeine.test';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

const ftest = (await import('firebase-functions-test')).default({ projectId: 'demo-tcm' });
const admin = (await import('firebase-admin')).default;
const fns = await import('../functions/index.js');

const w = (f) => ftest.wrap(f);
let pass = 0; const fails = [];

async function ok(label, fn) {
  try { const r = await fn(); pass++; console.log('  ✓ ' + label + (r === undefined ? '' : ': ' + JSON.stringify(r))); return r; }
  catch (e) { fails.push(label); console.log('  ✗ ' + label + ' -> ' + (e.code || '') + ' ' + e.message); }
}
async function refused(label, fn, expect) {
  try { await fn(); fails.push(label); console.log('  ✗ ' + label + ' -> WAS ALLOWED'); }
  catch (e) {
    if (expect && String(e.code).indexOf(expect) === -1) {
      fails.push(label); console.log('  ✗ ' + label + ' -> wrong code ' + e.code);
    } else { pass++; console.log('  ✓ ' + label + ' -> ' + e.code); }
  }
}

const ownerCtx = (uid) => ({ auth: { uid, token: { email: 'owner@caffeine.test', email_verified: true, role: 'owner' } } });
const userCtx  = (uid) => ({ auth: { uid, token: { role: 'user' } } });
const ip = (a) => ({ rawRequest: { ip: a } });

console.log('\nowner bootstrap');
await ok('creates the owner account', () => w(fns.setupOwner)({ email: 'owner@caffeine.test', password: 'a-long-password' }));
await refused('refuses a second bootstrap', () => w(fns.setupOwner)({ email: 'owner@caffeine.test', password: 'another-one' }), 'already-exists');
await refused('refuses a different email', () => w(fns.setupOwner)({ email: 'someone@else.test', password: 'a-long-password' }), 'permission-denied');
// The password rule is checked before the account is looked up, so a short one
// is rejected as invalid-argument whether or not the owner already exists.
await refused('refuses a short password',
  () => w(fns.setupOwner)({ email: 'owner@caffeine.test', password: 'short' }), 'invalid-argument');

const ownerUser = await admin.auth().getUserByEmail('owner@caffeine.test');
const OWNER = ownerCtx(ownerUser.uid);

await ok('owner claims their role', () => w(fns.claimOwner)({}, OWNER));
await refused('a stranger cannot claim owner', () => {
  return w(fns.claimOwner)({}, { auth: { uid: 'x', token: { email: 'nobody@else.test', email_verified: true } } });
}, 'permission-denied');

console.log('\ncreating accounts');
await ok('creates a barista', () => w(fns.createUser)({
  username: 'rahul', name: 'Rahul', role: 'staff', accessKey: 'first-key-99'
}, OWNER));
await refused('rejects a duplicate username', () => w(fns.createUser)({
  username: 'rahul', name: 'Someone', role: 'staff', accessKey: 'other-key-99' }, OWNER), 'already-exists');
await refused('rejects a reserved username', () => w(fns.createUser)({
  username: 'admin', name: 'X', role: 'staff', accessKey: 'other-key-99' }, OWNER), 'invalid-argument');
await refused('rejects a weak access key', () => w(fns.createUser)({
  username: 'weak', name: 'X', role: 'staff', accessKey: '12345' }, OWNER), 'invalid-argument');
await refused('a user cannot create accounts', () => w(fns.createUser)({
  username: 'sneaky', name: 'X', role: 'staff', accessKey: 'good-key-99' }, userCtx('someone')), 'permission-denied');

const rahul = (await admin.firestore().collection('users').doc('rahul').get()).data();

console.log('\npermissions');
await ok('the staff preset is applied', async () => {
  const p = rahul.perms;
  if (!p.requests || !p.receive || !p.recipesAdd) throw new Error('preset missing');
  if (p.poManage || p.prices || p.team) throw new Error('preset too broad');
  return { requests: p.requests, poManage: p.poManage, team: p.team };
});
await ok('team can never be granted to a user', async () => {
  await w(fns.updateUser)({ username: 'rahul', perms: { team: true, requests: true } }, OWNER);
  const after = (await admin.firestore().collection('users').doc('rahul').get()).data();
  if (after.perms.team) throw new Error('team was granted');
  return { team: after.perms.team };
});
await ok('the uid mirror stays in step', async () => {
  const idx = (await admin.firestore().collection('userIndex').doc(rahul.uid).get()).data();
  if (!idx || idx.perms.team !== false) throw new Error('mirror out of step');
  return { mirrored: true };
});

console.log('\nsigning in');
const signedIn = await ok('signs in with username and key',
  async () => { const r = await w(fns.signIn)({ username: 'rahul', accessKey: 'first-key-99' }, ip('1.1.1.1'));
                return { role: r.role, token: !!r.token, mustChangeKey: r.mustChangeKey }; });
await refused('wrong key is refused', () => w(fns.signIn)({ username: 'rahul', accessKey: 'wrong-key-99' }, ip('1.1.1.2')), 'permission-denied');
await refused('unknown username is refused the same way',
  () => w(fns.signIn)({ username: 'nobody', accessKey: 'first-key-99' }, ip('1.1.1.3')), 'permission-denied');
await refused('the owner cannot use the staff door',
  () => w(fns.signIn)({ username: 'owner', accessKey: 'a-long-password' }, ip('1.1.1.4')), 'failed-precondition');

console.log('\nchanging the key');
await ok('the user replaces their issued key',
  () => w(fns.changeMyKey)({ current: 'first-key-99', next: 'my-own-key-77' }, userCtx(rahul.uid)));
await refused('the old key stops working',
  () => w(fns.signIn)({ username: 'rahul', accessKey: 'first-key-99' }, ip('1.1.1.5')), 'permission-denied');
await ok('the new key works',
  async () => { const r = await w(fns.signIn)({ username: 'rahul', accessKey: 'my-own-key-77' }, ip('1.1.1.6'));
                return { role: r.role, mustChangeKey: r.mustChangeKey }; });
await refused('cannot change it without the current one',
  () => w(fns.changeMyKey)({ current: 'guessing', next: 'another-key-88' }, userCtx(rahul.uid)), 'permission-denied');

console.log('\nsuspending and restoring');
await ok('the owner suspends the account', () => w(fns.updateUser)({ username: 'rahul', status: 'suspended' }, OWNER));
await refused('a suspended account cannot sign in',
  () => w(fns.signIn)({ username: 'rahul', accessKey: 'my-own-key-77' }, ip('1.1.1.7')), 'permission-denied');
await ok('the owner restores it', () => w(fns.updateUser)({ username: 'rahul', status: 'active' }, OWNER));
await ok('and they can sign in again',
  async () => { const r = await w(fns.signIn)({ username: 'rahul', accessKey: 'my-own-key-77' }, ip('1.1.1.8'));
                return { role: r.role }; });

console.log('\nresetting a forgotten key');
await ok('the owner issues a new key', () => w(fns.resetAccessKey)({ username: 'rahul', accessKey: 'owner-reset-55' }, OWNER));
await ok('the reset key works and asks to be changed',
  async () => { const r = await w(fns.signIn)({ username: 'rahul', accessKey: 'owner-reset-55' }, ip('1.1.1.9'));
                if (!r.mustChangeKey) throw new Error('should ask for a new key');
                return { mustChangeKey: r.mustChangeKey }; });

console.log('\nsession');
await ok('me() describes the owner', async () => {
  const r = await w(fns.me)({}, OWNER);
  return { role: r.role, isOwner: r.isOwner };
});
await ok('me() describes a user', async () => {
  const r = await w(fns.me)({}, userCtx(rahul.uid));
  return { role: r.role, isOwner: r.isOwner, canReceive: r.perms.receive };
});

console.log('\ndeleting');
await ok('the owner deletes the account', () => w(fns.deleteUser)({ username: 'rahul' }, OWNER));
await refused('the deleted account cannot sign in',
  () => w(fns.signIn)({ username: 'rahul', accessKey: 'owner-reset-55' }, ip('1.1.2.1')), 'permission-denied');
await refused('the owner account cannot be deleted',
  () => w(fns.deleteUser)({ username: 'owner' }, OWNER), 'failed-precondition');

ftest.cleanup();
console.log('');
if (fails.length) {
  console.log(`FAILED ${fails.length} of ${pass + fails.length}`);
  fails.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log(`All ${pass} auth-flow tests passed.`);
process.exit(0);
