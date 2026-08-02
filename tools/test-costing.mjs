/**
 * Unit tests for the costing engine in assets/tcm-core.js.
 *
 *   node tools/test-costing.mjs
 *
 * tcm-core.js is a browser script, so this stubs the handful of globals it
 * touches at load time (firebase, window, crypto) and then exercises the pure
 * functions. Every case below is a bug that existed in the previous
 * implementation — keep them passing.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'assets', 'tcm-core.js'), 'utf8');

// --- minimal browser/firebase stubs ----------------------------------------
const noop = () => {};
const firebaseStub = {
  apps: [{}],
  initializeApp: noop,
  firestore: () => ({ collection: () => ({ doc: () => ({}) }), runTransaction: noop }),
  auth: Object.assign(() => ({
    setPersistence: () => Promise.resolve(),
    onAuthStateChanged: noop,
    signInWithCustomToken: noop,
    signOut: () => Promise.resolve()
  }), { Auth: { Persistence: { SESSION: 'session' } } }),
  functions: () => ({ httpsCallable: () => noop })
};

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  document: { createElement: () => ({ style: {}, appendChild: noop, getContext: () => ({ drawImage: noop }) }) },
  navigator: {},
  location: { href: '', pathname: '/', protocol: 'https:', hostname: 'localhost', replace: noop },
  crypto: globalThis.crypto, // real WebCrypto, so the id test means something
  firebase: firebaseStub,
  Promise, Image: class {}, FileReader: class {}, Uint8Array, Number, Math, Date, String, Object, Array, isFinite, JSON
};
sandbox.window = sandbox;
sandbox.addEventListener = noop;

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'tcm-core.js' });
const TCM = sandbox.TCM;

// --- test harness -----------------------------------------------------------
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failures.push(name); console.log('  ✗ ' + name + '\n      ' + err.message.split('\n')[0]); }
}
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `expected ${b}, got ${a}`);

console.log('\nunit conversion');

test('converts within mass', () => near(TCM.convertQty(500, 'gms', 'Kg').qty, 0.5));
test('converts within volume', () => near(TCM.convertQty(2, 'Ltr', 'ml').qty, 2000));
test('converts spoons to ml', () => near(TCM.convertQty(3, 'tbsp', 'ml').qty, 45));
test('identity conversion needs no table entry', () => near(TCM.convertQty(7, 'bunch', 'bunch').qty, 7));

test('refuses mass -> volume', () =>
  assert.equal(TCM.convertQty(1, 'Kg', 'Ltr').ok, false));

test('refuses Jar -> Piece (no pack size is knowable)', () =>
  assert.equal(TCM.convertQty(1, 'Jar', 'Piece').ok, false));

console.log('\ncosting');

test('gms priced per Kg costs correctly', () => {
  // The old engine had no gms->Kg rule in the direction it needed and fell
  // through with factor 1, costing 30 gms as if it were 30 Kg.
  const c = TCM.costOf(30, 'gms', { price: 2000, unit: 'Kg' });
  assert.ok(c.ok); near(c.landed, 60);
});

test('applies GST on top of base', () => {
  const c = TCM.costOf(1, 'Kg', { price: 100, unit: 'Kg', gst: 18 });
  near(c.base, 100); near(c.landed, 118);
});

test('unpriced item reports a reason instead of costing 0', () => {
  const c = TCM.costOf(5, 'Kg', undefined);
  assert.equal(c.ok, false); assert.equal(c.reason, 'unpriced'); assert.equal(c.landed, 0);
});

test('incompatible unit reports a reason instead of costing 0', () => {
  const c = TCM.costOf(2, 'Ltr', { price: 50, unit: 'Kg' });
  assert.equal(c.ok, false); assert.equal(c.reason, 'unit-mismatch');
});

console.log('\nrecipe explosion');

const prices = {
  'Milk (Full Cream)': { price: 60, unit: 'Ltr' },
  'Full House Green (Arabica)': { price: 2000, unit: 'Kg' },
  Sugar: { price: 45, unit: 'Kg' }
};

test('sums the same raw item across different units', () => {
  // Previously `rawTotals[x].qty += qty` added the bare numbers, so
  // 100 gms + 0.5 Kg came out as 100.5 <unit of whichever arrived first>.
  const r = TCM.explodeRecipe(
    [{ name: 'Sugar', qty: 100, unit: 'gms' }, { name: 'Sugar', qty: 0.5, unit: 'Kg' }],
    { prepItems: [], recipes: [] }
  );
  assert.equal(r.lines.length, 1);
  near(r.lines[0].qty, 600);            // 100 gms + 500 gms
  assert.equal(r.lines[0].unit, 'gms');
});

test('scales a batch prep by unit-aware ratio', () => {
  // 200 ml drawn from a batch yielding 1 Ltr is 0.2 of the batch. The old code
  // computed 200 / 1 = 200, overstating the ingredient by 1000x.
  const recipes = [{
    name: 'Vanilla Syrup', category: 'Batch Prep', yieldQty: 1, yieldUnit: 'Ltr',
    ingredients: [{ name: 'Sugar', qty: 800, unit: 'gms' }]
  }];
  const r = TCM.explodeRecipe([{ name: 'Vanilla Syrup', qty: 200, unit: 'ml' }], { prepItems: [], recipes });
  assert.equal(r.lines.length, 1);
  near(r.lines[0].qty, 160);            // 0.2 * 800 gms
});

test('follows a prep-kitchen conversion rule to its raw material', () => {
  const prepItems = [{
    name: 'Espresso Shot', yieldQty: 30, yieldUnit: 'ml', rawItem: 'Full House Green (Arabica)', rawQty: 18, rawUnit: 'gms'
  }];
  const r = TCM.explodeRecipe([{ name: 'Espresso Shot', qty: 60, unit: 'ml' }], { prepItems, recipes: [] });
  assert.equal(r.lines[0].name, 'Full House Green (Arabica)');
  near(r.lines[0].qty, 36);             // 2 shots * 18 gms
});

test('detects a circular batch prep instead of overflowing the stack', () => {
  const recipes = [
    { name: 'A', category: 'Batch Prep', yieldQty: 1, yieldUnit: 'Ltr', ingredients: [{ name: 'B', qty: 1, unit: 'Ltr' }] },
    { name: 'B', category: 'Batch Prep', yieldQty: 1, yieldUnit: 'Ltr', ingredients: [{ name: 'A', qty: 1, unit: 'Ltr' }] }
  ];
  const r = TCM.explodeRecipe([{ name: 'A', qty: 1, unit: 'Ltr' }], { prepItems: [], recipes });
  assert.equal(r.warnings.length >= 1, true);
  assert.match(r.warnings[0], /Circular reference/);
});

test('reports an unscalable sub-recipe rather than inventing a ratio', () => {
  const recipes = [{
    name: 'Cookie Dough', category: 'Batch Prep', yieldQty: 2, yieldUnit: 'Kg',
    ingredients: [{ name: 'Sugar', qty: 500, unit: 'gms' }]
  }];
  const r = TCM.explodeRecipe([{ name: 'Cookie Dough', qty: 100, unit: 'ml' }], { prepItems: [], recipes });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /cannot scale/);
});

test('ignores custom (non-catalogue) ingredients', () => {
  const r = TCM.explodeRecipe(
    [{ name: 'Sugar', qty: 10, unit: 'gms' }, { name: 'Secret Dust', qty: 1, unit: 'tsp', isCustom: true }],
    { prepItems: [], recipes: [] }
  );
  assert.equal(r.lines.length, 1);
});

console.log('\nfull recipe costing');

test('costs a latte end to end', () => {
  const prepItems = [{ name: 'Espresso Shot', yieldQty: 30, yieldUnit: 'ml', rawItem: 'Full House Green (Arabica)', rawQty: 18, rawUnit: 'gms' }];
  const c = TCM.costRecipe(
    [{ name: 'Espresso Shot', qty: 60, unit: 'ml' }, { name: 'Milk (Full Cream)', qty: 180, unit: 'ml' }],
    { prepItems, recipes: [], prices }
  );
  // 36 gms beans @ Rs2000/Kg = 72.00 ; 180 ml milk @ Rs60/Ltr = 10.80
  near(c.total, 82.8, 1e-9);
  assert.equal(c.complete, true);
});

test('flags the total as incomplete when an ingredient cannot be costed', () => {
  const c = TCM.costRecipe(
    [{ name: 'Sugar', qty: 10, unit: 'gms' }, { name: 'Matcha (Premium)', qty: 5, unit: 'gms' }],
    { prepItems: [], recipes: [], prices }
  );
  assert.equal(c.complete, false);
  assert.equal(c.lines.find(l => l.name === 'Matcha (Premium)').cost.reason, 'unpriced');
});

console.log('\nidentifiers & phone numbers');

test('request ids are unique across a tight loop', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(TCM.newRequestId());
  assert.equal(seen.size, 2000);
});

test('PO document ids strip slashes', () =>
  assert.equal(TCM.poDocId('TCM/08-26/001'), 'TCM-08-26-001'));

test('normalises a bare Indian mobile', () =>
  assert.equal(TCM.normalizePhone('98765 43210'), '919876543210'));

test('leaves an already-international number alone', () =>
  assert.equal(TCM.normalizePhone('+91 98765 43210'), '919876543210'));

test('rejects an obviously bad number', () =>
  assert.equal(TCM.isPlausiblePhone('123'), false));


// --- access keys and usernames ----------------------------------------------
// These mirror keyProblem() and usernameProblem() in functions/index.js. If the
// two drift, the owner's form accepts something the server then refuses.
console.log('\naccess keys');

test('rejects weak keys', () => {
  ['', 'abc', '12345', 'aaaaaa', '123456', '654321', 'password', 'qwerty']
    .forEach(k => assert.ok(TCM.keyProblem(k), 'should reject: ' + JSON.stringify(k)));
});
test('accepts reasonable keys', () => {
  ['BrewOps24!', 'K7M-QP2-XRT', 'coffee-bean-42', 'Rahul2026']
    .forEach(k => assert.equal(TCM.keyProblem(k), null, 'should accept: ' + k));
});
test('says what is wrong', () => {
  assert.match(TCM.keyProblem('abc'), /6 characters/i);
  assert.match(TCM.keyProblem('aaaaaa'), /repeated/i);
});

console.log('\nusernames');
test('rejects bad usernames', () => {
  ['ab', 'owner', 'admin', 'has space', 'UPPER CASE!', '']
    .forEach(u => assert.ok(TCM.usernameProblem(u), 'should reject: ' + JSON.stringify(u)));
});
test('accepts ordinary usernames', () => {
  ['rahul', 'priya.k', 'bar_staff', 'kitchen-2']
    .forEach(u => assert.equal(TCM.usernameProblem(u), null, 'should accept: ' + u));
});
test('is case-insensitive, like the server', () =>
  assert.equal(TCM.usernameProblem('Rahul'), null));

// --- summary ----------------------------------------------------------------
console.log('');
if (failures.length) {
  console.log(`FAILED: ${failures.length} of ${passed + failures.length}`);
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log(`All ${passed} tests passed.`);
