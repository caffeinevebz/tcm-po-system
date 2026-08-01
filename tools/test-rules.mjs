/**
 * Security-rule tests for firestore.rules.
 *
 * These assert the boundary that actually protects the data — not the
 * client-side guard in each page, which a determined visitor can bypass.
 *
 *   npm install --save-dev @firebase/rules-unit-testing firebase
 *   npm run test:rules
 *
 * Requires Java (the Firestore emulator is a JAR) and the Firebase CLI. The
 * npm script wraps this in `firebase emulators:exec`, which starts and stops
 * the emulator around the run.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  initializeTestEnvironment, assertFails, assertSucceeds
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-tcm',
  firestore: { rules: fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8085 }
});

const anon  = env.unauthenticatedContext().firestore();
const owner = env.authenticatedContext('owner', { role: 'owner' }).firestore();
const staff = env.authenticatedContext('staff', { role: 'staff' }).firestore();
// Someone who signed in some other way but has no role claim.
const noRole = env.authenticatedContext('mystery', {}).firestore();

// Seed through the admin (rules-bypassing) context.
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'settings/main'), { inventory: {}, prices: { Sugar: { price: 45, unit: 'Kg' } }, aliases: {}, suppliers: [], poCounter: { month: '08-26', count: 1 } });
  await setDoc(doc(db, 'pos/TCM-08-26-001'), { id: 'TCM/08-26/001', status: 'Approved', supplier: 'Acme', items: [{ name: 'Sugar', qty: 5, unit: 'Kg' }] });
  await setDoc(doc(db, 'recipes/REC-1'), { id: 'REC-1', name: 'Latte', ingredients: [] });
  await setDoc(doc(db, 'requests/REQ-1'), { id: 'REQ-1', items: [{ name: 'Sugar', qty: 1, unit: 'Kg' }] });
});

let pass = 0; const fails = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name); console.log('  ✗ ' + name + '\n      ' + String(e.message).split('\n')[0]); }
}

console.log('\nunauthenticated visitor (the old wide-open case)');
await t('cannot list purchase orders', () => assertFails(getDocs(collection(anon, 'pos'))));
await t('cannot read the price book',  () => assertFails(getDoc(doc(anon, 'settings/main'))));
await t('cannot read recipes',         () => assertFails(getDoc(doc(anon, 'recipes/REC-1'))));
await t('cannot delete a PO',          () => assertFails(deleteDoc(doc(anon, 'pos/TCM-08-26-001'))));
await t('cannot write a PO',           () => assertFails(setDoc(doc(anon, 'pos/EVIL'), { id: 'EVIL', status: 'Approved' })));

console.log('\nsigned in but with no role claim');
await t('is treated as a stranger', () => assertFails(getDoc(doc(noRole, 'settings/main'))));

console.log('\nstaff');
await t('reads the catalogue',            () => assertSucceeds(getDoc(doc(staff, 'settings/main'))));
await t('reads recipes',                  () => assertSucceeds(getDoc(doc(staff, 'recipes/REC-1'))));
await t('submits a material request',     () => assertSucceeds(setDoc(doc(staff, 'requests/REQ-NEW'), { id: 'REQ-NEW', items: [{ name: 'Sugar', qty: 2, unit: 'Kg' }] })));
await t('cannot submit an empty request', () => assertFails(setDoc(doc(staff, 'requests/REQ-EMPTY'), { id: 'REQ-EMPTY', items: [] })));
await t('books in a delivery',            () => assertSucceeds(updateDoc(doc(staff, 'pos/TCM-08-26-001'), { status: 'Delivered', receivedItems: [{ name: 'Sugar', receivedQty: 5 }], deliveryDate: '01/08/2026' })));
await t('teaches the scanner an alias',   () => assertSucceeds(updateDoc(doc(staff, 'settings/main'), { aliases: { 'AMUL BUTTER 500G PKT.': 'Amul Butter' } })));

await t('CANNOT edit the master price book', () => assertFails(updateDoc(doc(staff, 'settings/main'), { prices: { Sugar: { price: 1, unit: 'Kg' } } })));
await t('CANNOT edit the catalogue',         () => assertFails(updateDoc(doc(staff, 'settings/main'), { inventory: { Hacked: [] } })));
await t('CANNOT raise a PO',                 () => assertFails(setDoc(doc(staff, 'pos/TCM-08-26-099'), { id: 'x', status: 'Approved', items: [] })));
await t('CANNOT delete a PO',                () => assertFails(deleteDoc(doc(staff, 'pos/TCM-08-26-001'))));
await t('CANNOT rewrite PO line items',      () => assertFails(updateDoc(doc(staff, 'pos/TCM-08-26-001'), { items: [{ name: 'Gold', qty: 99, unit: 'Kg' }] })));
await t('CANNOT author a recipe',            () => assertFails(setDoc(doc(staff, 'recipes/REC-2'), { id: 'REC-2', name: 'Mine' })));
await t('CANNOT delete a recipe',            () => assertFails(deleteDoc(doc(staff, 'recipes/REC-1'))));
await t('CANNOT delete a staff request',     () => assertFails(deleteDoc(doc(staff, 'requests/REQ-1'))));

console.log('\nowner');
await t('reads everything',        () => assertSucceeds(getDocs(collection(owner, 'pos'))));
await t('edits the price book',    () => assertSucceeds(updateDoc(doc(owner, 'settings/main'), { prices: { Sugar: { price: 50, unit: 'Kg' } } })));
await t('raises a PO',             () => assertSucceeds(setDoc(doc(owner, 'pos/TCM-08-26-002'), { id: 'TCM/08-26/002', status: 'Approved', items: [] })));
await t('authors a recipe',        () => assertSucceeds(setDoc(doc(owner, 'recipes/REC-3'), { id: 'REC-3', name: 'Mocha' })));
await t('clears a staff request',  () => assertSucceeds(deleteDoc(doc(owner, 'requests/REQ-1'))));
await t('deletes a PO',            () => assertSucceeds(deleteDoc(doc(owner, 'pos/TCM-08-26-002'))));

console.log('\nlogin throttle collection is off limits to every client');
await t('owner cannot read it', () => assertFails(getDoc(doc(owner, '_authThrottle/abc'))));
await t('staff cannot write it', () => assertFails(setDoc(doc(staff, '_authThrottle/abc'), { fails: 0 })));

console.log('\nunlisted collections are denied by default');
await t('owner cannot invent a collection', () => assertFails(setDoc(doc(owner, 'anythingElse/x'), { a: 1 })));

await env.cleanup();
console.log('');
if (fails.length) { console.log(`FAILED ${fails.length} of ${pass + fails.length}`); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log(`All ${pass} rules tests passed.`);
