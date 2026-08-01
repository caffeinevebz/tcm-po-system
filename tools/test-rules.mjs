/**
 * Security-rule tests for firestore.rules.
 *
 * These assert the boundary that actually protects the data — not the
 * client-side guard in each page, which a determined visitor can bypass.
 *
 *   npm run test:rules
 *
 * Requires Java (the Firestore emulator is a JAR) and the Firebase CLI. The
 * npm script wraps this in `firebase emulators:exec`, which starts and stops
 * the emulator around the run.
 */
import fs from 'node:fs';
import {
  initializeTestEnvironment, assertFails, assertSucceeds
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-tcm',
  firestore: {
    rules: fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
    host: '127.0.0.1',
    port: 8085
  }
});

const anon   = env.unauthenticatedContext().firestore();
const owner  = env.authenticatedContext('ownerUid', { role: 'owner' }).firestore();
const staff  = env.authenticatedContext('staffUid', { role: 'staff' }).firestore();
// Someone who verified their mobile number but was never invited: Firebase gave
// them a session, claimRole refused to give them a role.
const noRole = env.authenticatedContext('strangerUid', {}).firestore();
// A second staff member, used to prove one cannot impersonate another.
const staff2 = env.authenticatedContext('staff2Uid', { role: 'staff' }).firestore();

await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'settings/main'), {
    inventory: {}, prices: { Sugar: { price: 45, unit: 'Kg' } }, aliases: {},
    suppliers: [], poCounter: { month: '08-26', count: 1 }
  });
  await setDoc(doc(db, 'pos/TCM-08-26-001'), {
    id: 'TCM/08-26/001', status: 'Approved', supplier: 'Acme',
    items: [{ name: 'Sugar', qty: 5, unit: 'Kg' }]
  });
  await setDoc(doc(db, 'recipes/REC-1'), { id: 'REC-1', name: 'Latte', ingredients: [], createdBy: 'ownerUid' });
  await setDoc(doc(db, 'recipes/REC-STAFF'), { id: 'REC-STAFF', name: 'Staff Mocha', ingredients: [], createdBy: 'staffUid' });
  await setDoc(doc(db, 'requests/REQ-1'), { id: 'REQ-1', items: [{ name: 'Sugar', qty: 1, unit: 'Kg' }] });
  await setDoc(doc(db, 'staffMembers/9876543210'), { phoneKey: '9876543210', uid: 'staffUid', name: 'Rahul', status: 'active', role: 'staff' });
  await setDoc(doc(db, 'staffMembers/9000000000'), { phoneKey: '9000000000', uid: 'staff2Uid', name: 'Priya', status: 'active', role: 'staff' });
  await setDoc(doc(db, '_staffSecrets/staffUid'), { pinHash: 'x:y' });
});

let pass = 0; const fails = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name); console.log('  ✗ ' + name + '\n      ' + String(e.message).split('\n')[0]); }
}

const newRecipe = (id, by) => ({ id, name: 'Something new', ingredients: [{ name: 'Sugar', qty: 5, unit: 'gms' }], createdBy: by });

console.log('\nstranger — never invited, or removed');
await t('cannot list purchase orders',   () => assertFails(getDocs(collection(anon, 'pos'))));
await t('cannot read the price book',    () => assertFails(getDoc(doc(anon, 'settings/main'))));
await t('cannot read recipes',           () => assertFails(getDoc(doc(anon, 'recipes/REC-1'))));
await t('cannot write a PO',             () => assertFails(setDoc(doc(anon, 'pos/EVIL'), { id: 'EVIL', status: 'Approved' })));
await t('verified number with no role is still a stranger',
  () => assertFails(getDoc(doc(noRole, 'settings/main'))));
await t('verified number with no role cannot add a recipe',
  () => assertFails(setDoc(doc(noRole, 'recipes/REC-X'), newRecipe('REC-X', 'strangerUid'))));

console.log('\nteam directory');
await t('owner reads the whole team',     () => assertSucceeds(getDocs(collection(owner, 'staffMembers'))));
await t('staff reads their own record',   () => assertSucceeds(getDoc(doc(staff, 'staffMembers/9876543210'))));
await t('staff CANNOT read a colleague',  () => assertFails(getDoc(doc(staff, 'staffMembers/9000000000'))));
await t('staff CANNOT invite themselves', () => assertFails(setDoc(doc(staff, 'staffMembers/9111111111'), { uid: 'staffUid', status: 'active' })));
await t('staff CANNOT re-activate themselves after removal',
  () => assertFails(updateDoc(doc(staff, 'staffMembers/9876543210'), { status: 'active' })));
await t('even the owner cannot write the team directly (functions only)',
  () => assertFails(setDoc(doc(owner, 'staffMembers/9222222222'), { uid: 'x', status: 'active' })));

console.log('\nPIN hashes');
await t('staff cannot read their own PIN hash', () => assertFails(getDoc(doc(staff, '_staffSecrets/staffUid'))));
await t('owner cannot read PIN hashes',         () => assertFails(getDoc(doc(owner, '_staffSecrets/staffUid'))));

console.log('\nstaff — what they may do');
await t('reads the catalogue',          () => assertSucceeds(getDoc(doc(staff, 'settings/main'))));
await t('reads recipes',                () => assertSucceeds(getDoc(doc(staff, 'recipes/REC-1'))));
await t('submits a material request',   () => assertSucceeds(setDoc(doc(staff, 'requests/REQ-NEW'), { id: 'REQ-NEW', items: [{ name: 'Sugar', qty: 2, unit: 'Kg' }] })));
await t('ADDS a new recipe',            () => assertSucceeds(setDoc(doc(staff, 'recipes/REC-NEW'), newRecipe('REC-NEW', 'staffUid'))));
await t('books in a delivery',          () => assertSucceeds(updateDoc(doc(staff, 'pos/TCM-08-26-001'), { status: 'Delivered', receivedItems: [{ name: 'Sugar', receivedQty: 5 }], deliveryDate: '01/08/2026', receivedBy: 'Rahul' })));
await t('teaches the scanner an alias', () => assertSucceeds(updateDoc(doc(staff, 'settings/main'), { aliases: { 'AMUL BUTTER 500G PKT.': 'Amul Butter' } })));

console.log('\nstaff — what they may NOT do');
await t('CANNOT edit any recipe',            () => assertFails(updateDoc(doc(staff, 'recipes/REC-1'), { name: 'Renamed' })));
await t('CANNOT edit a recipe they wrote',   () => assertFails(updateDoc(doc(staff, 'recipes/REC-STAFF'), { name: 'Renamed' })));
await t('CANNOT delete a recipe they wrote', () => assertFails(deleteDoc(doc(staff, 'recipes/REC-STAFF'))));
await t("CANNOT add a recipe in someone else's name",
  () => assertFails(setDoc(doc(staff2, 'recipes/REC-FAKE'), newRecipe('REC-FAKE', 'staffUid'))));
await t('CANNOT add a nameless recipe',      () => assertFails(setDoc(doc(staff, 'recipes/REC-BAD'), { id: 'REC-BAD', name: '', ingredients: [], createdBy: 'staffUid' })));
await t('CANNOT edit the master price book', () => assertFails(updateDoc(doc(staff, 'settings/main'), { prices: { Sugar: { price: 1, unit: 'Kg' } } })));
await t('CANNOT edit the catalogue',         () => assertFails(updateDoc(doc(staff, 'settings/main'), { inventory: { Hacked: [] } })));
await t('CANNOT raise a PO',                 () => assertFails(setDoc(doc(staff, 'pos/TCM-08-26-099'), { id: 'x', status: 'Approved', items: [] })));
await t('CANNOT delete a PO',                () => assertFails(deleteDoc(doc(staff, 'pos/TCM-08-26-001'))));
await t('CANNOT rewrite PO line items',      () => assertFails(updateDoc(doc(staff, 'pos/TCM-08-26-001'), { items: [{ name: 'Gold', qty: 99, unit: 'Kg' }] })));
await t('CANNOT delete a staff request',     () => assertFails(deleteDoc(doc(staff, 'requests/REQ-1'))));
await t('CANNOT submit an empty request',    () => assertFails(setDoc(doc(staff, 'requests/REQ-EMPTY'), { id: 'REQ-EMPTY', items: [] })));

console.log('\nowner — full access');
await t('reads everything',       () => assertSucceeds(getDocs(collection(owner, 'pos'))));
await t('edits the price book',   () => assertSucceeds(updateDoc(doc(owner, 'settings/main'), { prices: { Sugar: { price: 50, unit: 'Kg' } } })));
await t('raises a PO',            () => assertSucceeds(setDoc(doc(owner, 'pos/TCM-08-26-002'), { id: 'TCM/08-26/002', status: 'Approved', items: [] })));
await t('edits a staff recipe',   () => assertSucceeds(updateDoc(doc(owner, 'recipes/REC-STAFF'), { name: 'Corrected Mocha' })));
await t('deletes a staff recipe', () => assertSucceeds(deleteDoc(doc(owner, 'recipes/REC-STAFF'))));
await t('clears a staff request', () => assertSucceeds(deleteDoc(doc(owner, 'requests/REQ-1'))));

console.log('\ndefaults');
await t('login throttle is closed to everyone', () => assertFails(getDoc(doc(owner, '_authThrottle/abc'))));
await t('unlisted collections are denied',      () => assertFails(setDoc(doc(owner, 'anythingElse/x'), { a: 1 })));

await env.cleanup();
console.log('');
if (fails.length) {
  console.log(`FAILED ${fails.length} of ${pass + fails.length}`);
  fails.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log(`All ${pass} rules tests passed.`);
