/**
 * Security-rule tests for firestore.rules.
 *
 * These assert the boundary that actually protects the data. The pages hide
 * buttons; only these rules refuse the write.
 *
 *   npm run test:rules
 *
 * Requires Java (the Firestore emulator is a JAR) and the Firebase CLI.
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

const NONE = {};
const ALL = ['requests','recipesView','recipesAdd','recipesEdit','receive',
             'poManage','inventory','prices','vendors'];
const perms = (...on) => Object.fromEntries(ALL.map(p => [p, on.includes(p)]));

const anon    = env.unauthenticatedContext().firestore();
const owner   = env.authenticatedContext('ownerUid',  { role: 'owner' }).firestore();
const barista = env.authenticatedContext('baristaUid', { role: 'user' }).firestore();
const manager = env.authenticatedContext('managerUid', { role: 'user' }).firestore();
const viewer  = env.authenticatedContext('viewerUid',  { role: 'user' }).firestore();
const gone    = env.authenticatedContext('goneUid',    { role: 'user' }).firestore();
// Signed in somehow, but no account record at all.
const ghost   = env.authenticatedContext('ghostUid',   { role: 'user' }).firestore();

await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();

  const account = async (uid, username, p, status = 'active') => {
    const row = { uid, username, name: username, role: 'staff', status, perms: p, isOwner: false };
    await setDoc(doc(db, 'users', username), row);
    await setDoc(doc(db, 'userIndex', uid), row);
  };

  await account('baristaUid', 'rahul',  perms('requests','recipesView','recipesAdd','receive'));
  await account('managerUid', 'priya',  perms('requests','recipesView','recipesAdd','recipesEdit','receive','poManage','inventory','vendors'));
  await account('viewerUid',  'guest',  perms('recipesView'));
  await account('goneUid',    'exstaff', perms('requests','recipesView'), 'suspended');

  await setDoc(doc(db, 'settings/main'), {
    inventory: {}, prices: { Sugar: { price: 45, unit: 'Kg' } }, aliases: {},
    suppliers: [], prepItems: [], poCounter: { month: '08-26', count: 1 }
  });
  await setDoc(doc(db, 'pos/TCM-08-26-001'), {
    id: 'TCM/08-26/001', status: 'Approved', supplier: 'Acme',
    items: [{ name: 'Sugar', qty: 5, unit: 'Kg' }]
  });
  await setDoc(doc(db, 'recipes/REC-1'), { id: 'REC-1', name: 'Latte', ingredients: [], createdBy: 'ownerUid' });
  await setDoc(doc(db, 'recipes/REC-MINE'), { id: 'REC-MINE', name: 'My Mocha', ingredients: [], createdBy: 'baristaUid' });
  await setDoc(doc(db, 'requests/REQ-1'), { id: 'REQ-1', items: [{ name: 'Sugar', qty: 1, unit: 'Kg' }] });
  await setDoc(doc(db, '_userSecrets/baristaUid'), { keyHash: 'x:y' });
});

let pass = 0; const fails = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name); console.log('  ✗ ' + name + '\n      ' + String(e.message).split('\n')[0]); }
}
const newRecipe = (id, by) => ({ id, name: 'Something new', ingredients: [{ name: 'Sugar', qty: 5, unit: 'gms' }], createdBy: by });

console.log('\nnot signed in');
await t('cannot list purchase orders', () => assertFails(getDocs(collection(anon, 'pos'))));
await t('cannot read the price book',  () => assertFails(getDoc(doc(anon, 'settings/main'))));
await t('cannot read recipes',         () => assertFails(getDoc(doc(anon, 'recipes/REC-1'))));
await t('cannot write a PO',           () => assertFails(setDoc(doc(anon, 'pos/EVIL'), { id: 'EVIL' })));

console.log('\nsigned in with no account record');
await t('is treated as a stranger', () => assertFails(getDoc(doc(ghost, 'settings/main'))));
await t('cannot add a recipe',      () => assertFails(setDoc(doc(ghost, 'recipes/X'), newRecipe('X', 'ghostUid'))));

console.log('\nsuspended account');
await t('cannot read the catalogue', () => assertFails(getDoc(doc(gone, 'settings/main'))));
await t('cannot raise a request',    () => assertFails(setDoc(doc(gone, 'requests/R9'), { id: 'R9', items: [{ name: 'Sugar' }] })));
await t('cannot read recipes',       () => assertFails(getDoc(doc(gone, 'recipes/REC-1'))));

console.log('\naccounts are function-managed only');
await t('a user cannot grant themselves a permission',
  () => assertFails(updateDoc(doc(barista, 'userIndex/baristaUid'), { perms: perms(...ALL) })));
await t('a user cannot un-suspend themselves',
  () => assertFails(updateDoc(doc(gone, 'userIndex/goneUid'), { status: 'active' })));
await t('a user cannot create an account',
  () => assertFails(setDoc(doc(barista, 'users/newguy'), { uid: 'x', status: 'active' })));
await t('even the owner cannot write accounts directly',
  () => assertFails(setDoc(doc(owner, 'users/newguy'), { uid: 'x', status: 'active' })));
await t('a user cannot read a colleague',
  () => assertFails(getDoc(doc(barista, 'userIndex/managerUid'))));
await t('the owner can list accounts', () => assertSucceeds(getDocs(collection(owner, 'users'))));

console.log('\naccess-key hashes');
await t('a user cannot read their own hash', () => assertFails(getDoc(doc(barista, '_userSecrets/baristaUid'))));
await t('the owner cannot read hashes',      () => assertFails(getDoc(doc(owner, '_userSecrets/baristaUid'))));

console.log('\nbarista — requests, add recipes, receive');
await t('reads the catalogue',        () => assertSucceeds(getDoc(doc(barista, 'settings/main'))));
await t('reads recipes',              () => assertSucceeds(getDoc(doc(barista, 'recipes/REC-1'))));
await t('raises a request',           () => assertSucceeds(setDoc(doc(barista, 'requests/REQ-N'), { id: 'REQ-N', items: [{ name: 'Sugar', qty: 2 }] })));
await t('adds a recipe',              () => assertSucceeds(setDoc(doc(barista, 'recipes/REC-N'), newRecipe('REC-N', 'baristaUid'))));
await t('books in a delivery',        () => assertSucceeds(updateDoc(doc(barista, 'pos/TCM-08-26-001'), { status: 'Delivered', receivedItems: [{ name: 'Sugar', receivedQty: 5 }], deliveryDate: '01/08/2026', receivedBy: 'Rahul' })));
await t('teaches the scanner a name', () => assertSucceeds(updateDoc(doc(barista, 'settings/main'), { aliases: { 'AMUL BUTTER 500G PKT.': 'Amul Butter' } })));

console.log('\nbarista — everything they were not given');
await t('CANNOT edit a recipe, even their own', () => assertFails(updateDoc(doc(barista, 'recipes/REC-MINE'), { name: 'Renamed' })));
await t('CANNOT delete their own recipe',       () => assertFails(deleteDoc(doc(barista, 'recipes/REC-MINE'))));
await t('CANNOT add a recipe as someone else',  () => assertFails(setDoc(doc(barista, 'recipes/REC-F'), newRecipe('REC-F', 'managerUid'))));
await t('CANNOT edit cost prices',              () => assertFails(updateDoc(doc(barista, 'settings/main'), { prices: { Sugar: { price: 1 } } })));
await t('CANNOT edit the catalogue',            () => assertFails(updateDoc(doc(barista, 'settings/main'), { inventory: { Hacked: [] } })));
// Write a value that genuinely differs from the seed: rewriting a field with
// the identical value produces an empty diff, which every hasOnly() accepts.
// That is harmless (nothing changes) but it does not test the rule.
await t('CANNOT edit vendors',                  () => assertFails(updateDoc(doc(barista, 'settings/main'), { suppliers: [{ name: 'Sneaky Supplies' }] })));
await t('CANNOT raise a PO',                    () => assertFails(setDoc(doc(barista, 'pos/TCM-08-26-099'), { id: 'x', status: 'Approved' })));
await t('CANNOT delete a PO',                   () => assertFails(deleteDoc(doc(barista, 'pos/TCM-08-26-001'))));
await t('CANNOT rewrite PO lines',              () => assertFails(updateDoc(doc(barista, 'pos/TCM-08-26-001'), { items: [{ name: 'Gold', qty: 99 }] })));
await t('CANNOT clear a request',               () => assertFails(deleteDoc(doc(barista, 'requests/REQ-1'))));

console.log('\nviewer — read the recipe book and nothing else');
await t('reads recipes',        () => assertSucceeds(getDoc(doc(viewer, 'recipes/REC-1'))));
await t('CANNOT add a recipe',  () => assertFails(setDoc(doc(viewer, 'recipes/REC-V'), newRecipe('REC-V', 'viewerUid'))));
await t('CANNOT raise a request', () => assertFails(setDoc(doc(viewer, 'requests/REQ-V'), { id: 'REQ-V', items: [{ name: 'Sugar' }] })));
await t('CANNOT receive goods',  () => assertFails(updateDoc(doc(viewer, 'pos/TCM-08-26-001'), { status: 'Delivered', receivedItems: [], deliveryDate: 'x', receivedBy: 'g' })));

console.log('\nmanager — purchasing and the catalogue, but not prices');
await t('raises a PO',           () => assertSucceeds(setDoc(doc(manager, 'pos/TCM-08-26-050'), { id: 'TCM/08-26/050', status: 'Approved', items: [] })));
await t('edits a recipe',        () => assertSucceeds(updateDoc(doc(manager, 'recipes/REC-1'), { name: 'Latte v2' })));
await t('edits the catalogue',   () => assertSucceeds(updateDoc(doc(manager, 'settings/main'), { inventory: { Groceries: ['Sugar'] } })));
await t('edits vendors',         () => assertSucceeds(updateDoc(doc(manager, 'settings/main'), { suppliers: [{ name: 'Acme' }] })));
await t('clears a request',      () => assertSucceeds(deleteDoc(doc(manager, 'requests/REQ-1'))));
await t('CANNOT edit cost prices', () => assertFails(updateDoc(doc(manager, 'settings/main'), { prices: { Sugar: { price: 9 } } })));

console.log('\nowner — everything');
await t('reads every PO',      () => assertSucceeds(getDocs(collection(owner, 'pos'))));
await t('edits cost prices',   () => assertSucceeds(updateDoc(doc(owner, 'settings/main'), { prices: { Sugar: { price: 50, unit: 'Kg' } } })));
await t('raises a PO',         () => assertSucceeds(setDoc(doc(owner, 'pos/TCM-08-26-002'), { id: 'TCM/08-26/002', status: 'Approved', items: [] })));
await t('deletes any recipe',  () => assertSucceeds(deleteDoc(doc(owner, 'recipes/REC-MINE'))));

console.log('\ndefaults');
await t('login throttle is closed to all', () => assertFails(getDoc(doc(owner, '_authThrottle/abc'))));
await t('unlisted collections are denied', () => assertFails(setDoc(doc(owner, 'anythingElse/x'), { a: 1 })));

await env.cleanup();
console.log('');
if (fails.length) {
  console.log(`FAILED ${fails.length} of ${pass + fails.length}`);
  fails.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log(`All ${pass} rules tests passed.`);
