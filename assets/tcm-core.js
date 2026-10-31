/* =============================================================================
 * TCM BrewOps — shared core
 * -----------------------------------------------------------------------------
 * Plain ES5-compatible JavaScript (NOT JSX) so it can be loaded with an ordinary
 * <script src> tag ahead of the Babel-compiled page bundles.
 *
 * Everything in here used to be copy-pasted into owner.html and staff.html.
 * Keeping one copy means a fix lands on both terminals at once.
 *
 * Exposes: window.TCM
 * ========================================================================== */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Firebase
  // ---------------------------------------------------------------------------
  // NOTE: a Firebase web apiKey is a public project identifier, not a secret.
  // It is safe in source ONLY because access is now gated by Firebase Auth and
  // Firestore security rules (see firestore.rules). Do not remove those.
  var firebaseConfig = {
    apiKey: 'AIzaSyAcE76Pc46oOJ3FMqb4kcojbvq5ACPuwaE',
    authDomain: 'tcm-orders.firebaseapp.com',
    projectId: 'tcm-orders',
    storageBucket: 'tcm-orders.firebasestorage.app',
    messagingSenderId: '994764639663',
    appId: '1:994764639663:web:2b0a682f2cb1001d37335a'
  };

  // If the Firebase SDK never arrived there is nothing useful to do here.
  // Return quietly rather than throwing: assets/tcm-boot.js detects the missing
  // global and shows the user a message that names the real problem, whereas a
  // raw throw only produced "firebase compat SDK must load before tcm-core.js".
  if (!global.firebase || !global.firebase.initializeApp) {
    if (global.console) console.error('TCM core: Firebase SDK unavailable — see the on-page report.');
    return;
  }
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

  var db = firebase.firestore();
  var auth = firebase.auth();
  // Callable functions use the project default region (us-central1). If you ever
  // redeploy verifyPin/scanInvoice to another region, change it here in one place:
  //   var fns = firebase.app().functions('asia-south1');
  var fns = firebase.functions();

  // The sign-in persists on the device, so nobody re-authenticates every visit.
  // Security comes from the app LOCK instead: after IDLE_LOCK_MS the app locks
  // and the person must present their access key again, which the SERVER checks
  // against a stored hash. A shared tablet therefore cannot be picked up and
  // used, and getting back in is one field, not an email round trip.
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function () {});

  var IDLE_LOCK_MS = 30 * 60 * 1000;   // lock after 30 min of no input
  var LOCK_KEY = 'tcm.locked';

  // ---------------------------------------------------------------------------
  // Units & measurement
  // ---------------------------------------------------------------------------
  // Every unit maps to a dimension plus a factor into that dimension's base unit
  // (mass -> gms, volume -> ml). "count" units are discrete containers: a Jar is
  // NOT interchangeable with a Piece, so they only convert to themselves.
  var UNITS = ['Kg', 'gms', 'Piece', 'Pkt', 'Jar', 'Carton', 'Tin', 'bunch', 'Ltr', 'ml', 'tsp', 'tbsp', 'Bottle'];

  var UNIT_DEFS = {
    gms: { dim: 'mass', factor: 1 },
    Kg: { dim: 'mass', factor: 1000 },
    ml: { dim: 'volume', factor: 1 },
    Ltr: { dim: 'volume', factor: 1000 },
    tsp: { dim: 'volume', factor: 5 },
    tbsp: { dim: 'volume', factor: 15 },
    Piece: { dim: 'count', factor: 1 },
    Pkt: { dim: 'count', factor: 1 },
    Jar: { dim: 'count', factor: 1 },
    Carton: { dim: 'count', factor: 1 },
    Tin: { dim: 'count', factor: 1 },
    bunch: { dim: 'count', factor: 1 },
    Bottle: { dim: 'count', factor: 1 }
  };

  function dimensionOf(unit) {
    var def = UNIT_DEFS[unit];
    return def ? def.dim : 'unknown';
  }

  /**
   * Convert a quantity between units.
   * Returns { ok: true, qty } or { ok: false, reason }. Never guesses: an
   * unconvertible pair is reported, not silently treated as a 1:1 factor.
   */
  function convertQty(qty, fromUnit, toUnit) {
    var n = Number(qty);
    if (!isFinite(n)) return { ok: false, reason: 'bad-quantity' };
    if (fromUnit === toUnit) return { ok: true, qty: n };

    var from = UNIT_DEFS[fromUnit];
    var to = UNIT_DEFS[toUnit];
    if (!from || !to) return { ok: false, reason: 'unknown-unit' };
    if (from.dim !== to.dim) return { ok: false, reason: 'incompatible-units' };
    // Two different discrete containers cannot be related without a pack size.
    if (from.dim === 'count') return { ok: false, reason: 'incompatible-units' };

    return { ok: true, qty: (n * from.factor) / to.factor };
  }

  /**
   * Cost of `qty` `unit` of an item, given its master price record.
   * Always reports WHY a cost could not be computed so the UI can flag it
   * instead of quietly rendering a confident-looking zero.
   */
  function costOf(qty, unit, priceObj) {
    var miss = { base: 0, landed: 0, ok: false };

    if (!priceObj || priceObj.price === undefined || priceObj.price === null || !isFinite(Number(priceObj.price)) || Number(priceObj.price) <= 0) {
      miss.reason = 'unpriced';
      return miss;
    }

    var conv = convertQty(qty, unit, priceObj.unit);
    if (!conv.ok) {
      miss.reason = conv.reason === 'unknown-unit' ? 'unknown-unit' : 'unit-mismatch';
      miss.priceUnit = priceObj.unit;
      return miss;
    }

    var base = conv.qty * Number(priceObj.price);
    var gst = Number(priceObj.gst) || 0;
    return { base: base, landed: base * (1 + gst / 100), ok: true };
  }

  var COST_WARNINGS = {
    unpriced: 'No master price set for this item',
    'unit-mismatch': 'Recipe unit cannot be converted to the purchase unit',
    'unknown-unit': 'Unrecognised unit',
    'bad-quantity': 'Quantity is not a number'
  };

  // ---------------------------------------------------------------------------
  // Recipe explosion (recipe -> raw purchasable materials)
  // ---------------------------------------------------------------------------
  var MAX_RECIPE_DEPTH = 24;

  // Separator for internal grouping keys. Written as an escape rather than a
  // raw byte so this file stays plain text; item names cannot contain it.
  var SEP = '\u0000';

  /**
   * Explode a recipe's ingredient list down to raw materials, following Batch
   * Prep sub-recipes and Prep Kitchen conversion rules.
   *
   * Returns { lines: [{ name, qty, unit }], warnings: [string] }.
   *
   * Guarantees the old implementation did not make:
   *   - cycles (A uses B uses A) are detected and reported, not stack-overflowed
   *   - quantities are only summed after unit conversion; incompatible units are
   *     kept as separate lines rather than added as bare numbers
   *   - a sub-recipe whose yield unit cannot be reconciled with the call site is
   *     reported and left un-exploded, instead of producing a 1000x ratio
   */
  function explodeRecipe(ingredients, opts) {
    opts = opts || {};
    var prepItems = opts.prepItems || [];
    var recipes = opts.recipes || [];

    var totals = {};        // key -> { name, qty, unit }
    var warnings = [];
    var seenWarning = {};

    function warn(msg) {
      if (seenWarning[msg]) return;
      seenWarning[msg] = true;
      warnings.push(msg);
    }

    function addRaw(name, qty, unit) {
      var n = Number(qty);
      if (!isFinite(n)) return;
      var key = name + SEP + dimensionOf(unit);
      var existing = totals[key];

      if (!existing) {
        totals[key] = { name: name, qty: n, unit: unit };
        return;
      }

      var conv = convertQty(n, unit, existing.unit);
      if (conv.ok) {
        existing.qty += conv.qty;
        return;
      }
      // Same dimension but not interchangeable (e.g. Jar vs Piece): keep apart.
      var altKey = key + SEP + unit;
      if (totals[altKey]) totals[altKey].qty += n;
      else totals[altKey] = { name: name, qty: n, unit: unit };
    }

    function walk(name, qty, unit, path, depth) {
      if (depth > MAX_RECIPE_DEPTH) {
        warn('"' + name + '" nests deeper than ' + MAX_RECIPE_DEPTH + ' levels — stopped.');
        return;
      }
      if (path.indexOf(name) !== -1) {
        warn('Circular reference: ' + path.concat(name).join(' → ') + '. Left un-exploded.');
        addRaw(name, qty, unit);
        return;
      }

      var batch = null;
      for (var i = 0; i < recipes.length; i++) {
        if (recipes[i] && recipes[i].category === 'Batch Prep' && recipes[i].name === name) { batch = recipes[i]; break; }
      }
      var prep = null;
      for (var j = 0; j < prepItems.length; j++) {
        if (prepItems[j] && prepItems[j].name === name) { prep = prepItems[j]; break; }
      }

      if (batch && Number(batch.yieldQty) > 0) {
        var bConv = convertQty(qty, unit, batch.yieldUnit);
        if (!bConv.ok) {
          warn('"' + name + '" is measured in ' + unit + ' but the batch yields ' +
               batch.yieldUnit + ' — cannot scale, costed as a raw item.');
          addRaw(name, qty, unit);
          return;
        }
        var bRatio = bConv.qty / Number(batch.yieldQty);
        var subs = batch.ingredients || [];
        for (var k = 0; k < subs.length; k++) {
          var s = subs[k];
          if (!s || s.isCustom) continue;
          walk(s.name, Number(s.qty) * bRatio, s.unit, path.concat(name), depth + 1);
        }
        return;
      }

      if (prep && Number(prep.yieldQty) > 0) {
        var pConv = convertQty(qty, unit, prep.yieldUnit);
        if (!pConv.ok) {
          warn('"' + name + '" is measured in ' + unit + ' but the prep rule yields ' +
               prep.yieldUnit + ' — cannot scale, costed as a raw item.');
          addRaw(name, qty, unit);
          return;
        }
        var pRatio = pConv.qty / Number(prep.yieldQty);
        addRaw(prep.rawItem, pRatio * Number(prep.rawQty), prep.rawUnit);
        return;
      }

      addRaw(name, qty, unit || 'unit');
    }

    var list = ingredients || [];
    for (var idx = 0; idx < list.length; idx++) {
      var ing = list[idx];
      if (!ing || ing.isCustom) continue;
      walk(ing.name, Number(ing.qty), ing.unit, [], 0);
    }

    var lines = Object.keys(totals).map(function (key) { return totals[key]; });
    lines.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    return { lines: lines, warnings: warnings };
  }

  /**
   * Full costing for a recipe. Returns the exploded lines each annotated with a
   * cost result, the landed total, and whether the total is trustworthy.
   */
  function costRecipe(ingredients, opts) {
    opts = opts || {};
    var prices = opts.prices || {};
    var exploded = explodeRecipe(ingredients, opts);
    var total = 0;
    var complete = true;

    var lines = exploded.lines.map(function (line) {
      var cost = costOf(line.qty, line.unit, prices[line.name]);
      if (cost.ok) total += cost.landed;
      else complete = false;
      return { name: line.name, qty: line.qty, unit: line.unit, cost: cost };
    });

    return {
      lines: lines,
      total: total,
      complete: complete && exploded.warnings.length === 0,
      warnings: exploded.warnings
    };
  }

  // ---------------------------------------------------------------------------
  // Identifiers
  // ---------------------------------------------------------------------------
  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  function monthKey(date) {
    var d = date || new Date();
    return pad(d.getMonth() + 1, 2) + '-' + String(d.getFullYear()).slice(-2);
  }

  function randomToken(bytes) {
    var buf = new Uint8Array(bytes || 5);
    (global.crypto || global.msCrypto).getRandomValues(buf);
    var out = '';
    for (var i = 0; i < buf.length; i++) out += pad(buf[i].toString(36), 2);
    return out.toUpperCase();
  }

  /**
   * Allocate the next PO number atomically.
   *
   * The previous version read the counter from React state, then wrote back
   * count+1 with a plain update(). Two POs raised at the same time got the same
   * number, and the second .set() silently overwrote the first PO document.
   * A transaction makes read-modify-write atomic.
   */
  function nextPoNumber() {
    var ref = db.collection('settings').doc('main');
    return db.runTransaction(function (tx) {
      return tx.get(ref).then(function (snap) {
        var mk = monthKey();
        var counter = (snap.exists && snap.data().poCounter) || { month: '', count: 1 };
        var count = counter.month === mk ? (Number(counter.count) || 1) : 1;
        tx.set(ref, { poCounter: { month: mk, count: count + 1 } }, { merge: true });
        return 'TCM/' + mk + '/' + pad(count, 3);
      });
    });
  }

  // Firestore document ids cannot contain "/".
  function poDocId(poId) {
    return String(poId || '').replace(/\//g, '-');
  }

  /**
   * Sortable, collision-resistant request id.
   *
   * Old scheme was 'REQ-' + a random number in [1000,9999] — only 9000 possible
   * ids, and requests are written with .set(), so a collision destroyed an
   * existing request.
   *
   * Three independent components now: a millisecond timestamp (which also keeps
   * the owner's newest-first sort working), an in-tab sequence counter that
   * guarantees uniqueness for anything submitted from this browser, and 24 bits
   * of randomness to separate concurrent tabs.
   */
  var requestSeq = Math.floor(Math.random() * 1296);
  function newRequestId() {
    requestSeq = (requestSeq + 1) % 1296;            // 1296 = 36^2
    var seq = pad(requestSeq.toString(36).toUpperCase(), 2);
    return 'REQ-' + Date.now().toString(36).toUpperCase() + '-' + seq + randomToken(3);
  }

  // ---------------------------------------------------------------------------
  // Phone numbers
  // ---------------------------------------------------------------------------
  function normalizePhone(raw) {
    var digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length === 10) return '91' + digits;          // bare Indian mobile
    if (digits.length === 11 && digits.charAt(0) === '0') return '91' + digits.slice(1);
    if (digits.length === 12 && digits.slice(0, 2) === '91') return digits;
    return digits;                                            // already international
  }

  function isPlausiblePhone(raw) {
    var d = normalizePhone(raw);
    return d.length >= 10 && d.length <= 15;
  }

  function splitPhones(value) {
    return String(value || '')
      .split(',')
      .map(function (p) { return p.trim(); })
      .filter(Boolean);
  }

  // ---------------------------------------------------------------------------
  // Image capture for invoice scanning
  // ---------------------------------------------------------------------------
  var MAX_SCAN_FILES = 8;
  var MAX_SOURCE_BYTES = 25 * 1024 * 1024;
  var SCAN_TARGET_WIDTH = 1500;

  /**
   * Downscale + JPEG-compress an image file, returning bare base64 (no data:
   * prefix). Unlike the previous version this never UPSCALES a small photo to
   * 1500px, which used to inflate uploads and AI cost for no added detail.
   */
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) {
        return reject(new Error('Not an image file'));
      }
      if (file.size > MAX_SOURCE_BYTES) {
        return reject(new Error('Image is larger than 25 MB'));
      }

      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read file')); };
      reader.onload = function (event) {
        var img = new Image();
        img.onerror = function () { reject(new Error('Could not decode image')); };
        img.onload = function () {
          var scale = Math.min(1, SCAN_TARGET_WIDTH / img.width);
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.8).split(',')[1]);
        };
        img.src = event.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------------------------------------------------------------------------
  // Accounts and access
  // ---------------------------------------------------------------------------
  // No SMS, no one-time codes, no self-registration. The owner signs in with an
  // email and password; everyone else signs in with a username and an access key
  // the owner issued, which the server checks against a stored hash.
  var LOGIN_PAGE = 'index.html';

  var PERMISSIONS = ['requests', 'recipesView', 'recipesAdd', 'recipesEdit', 'receive',
                     'poManage', 'inventory', 'prices', 'vendors', 'guests', 'team'];

  var PERMISSION_LABELS = {
    requests:    'Raise material requests',
    recipesView: 'Read the recipe book',
    recipesAdd:  'Add new recipes',
    recipesEdit: 'Change or delete recipes',
    receive:     'Book in deliveries',
    poManage:    'Create and manage purchase orders',
    inventory:   'Edit the catalogue and prep rules',
    prices:      'See and edit cost prices',
    vendors:     'Manage vendors',
    guests:      'Guest orders, bookings & loyalty stamps',
    team:        'Manage users'
  };

  // Filled in by guard(); the pages read it to decide what to show.
  var session = { role: null, name: '', perms: {}, isOwner: false, username: '' };

  function currentSession() { return session; }

  /** May the signed-in person do this? The rules enforce the same answer. */
  function can(permission) {
    if (session.isOwner) return true;
    return session.perms && session.perms[permission] === true;
  }

  // --- owner ----------------------------------------------------------------

  /** One-time bootstrap: create the owner's email/password account. */
  function setupOwner(email, password) {
    return fns.httpsCallable('setupOwner')({ email: email, password: password })
      .then(function (res) { return (res && res.data) || {}; });
  }

  /** Owner sign-in. Plain email and password — no codes, no reCAPTCHA. */
  function signInOwner(email, password) {
    return auth.signInWithEmailAndPassword(String(email || '').trim(), String(password || ''))
      .then(function () { return fns.httpsCallable('claimOwner')({}); })
      .then(function (res) {
        // The role arrives as a custom claim, so the ID token must be refreshed
        // before it carries it.
        return auth.currentUser.getIdToken(true).then(function () { return (res && res.data) || {}; });
      });
  }

  function sendOwnerPasswordReset(email) {
    return auth.sendPasswordResetEmail(String(email || '').trim());
  }

  // --- users ----------------------------------------------------------------

  /** Sign in with the username and access key the owner issued. */
  function signIn(username, accessKey) {
    return fns.httpsCallable('signIn')({ username: username, accessKey: accessKey })
      .then(function (res) {
        var out = (res && res.data) || {};
        if (!out.token) throw new Error('Malformed response');
        return auth.signInWithCustomToken(out.token).then(function () { return out; });
      });
  }

  function changeMyKey(current, next) {
    return fns.httpsCallable('changeMyKey')({ current: current, next: next })
      .then(function () { return true; });
  }

  /** Who is this session, and what may they open? */
  function whoAmI() {
    return fns.httpsCallable('me')({}).then(function (res) { return (res && res.data) || {}; });
  }

  // --- owner-only account administration ------------------------------------
  function createUser(payload) {
    return fns.httpsCallable('createUser')(payload).then(function (r) { return (r && r.data) || {}; });
  }
  function updateUser(payload) {
    return fns.httpsCallable('updateUser')(payload).then(function (r) { return (r && r.data) || {}; });
  }
  function resetAccessKey(username, accessKey) {
    return fns.httpsCallable('resetAccessKey')({ username: username, accessKey: accessKey })
      .then(function (r) { return (r && r.data) || {}; });
  }
  function deleteUser(username) {
    return fns.httpsCallable('deleteUser')({ username: username }).then(function (r) { return (r && r.data) || {}; });
  }
  function suggestAccessKey() {
    return fns.httpsCallable('suggestAccessKey')({}).then(function (r) { return (r && r.data && r.data.accessKey) || ''; });
  }

  // --- validation mirrors ---------------------------------------------------
  // These must agree with keyProblem() and usernameProblem() in
  // functions/index.js, so the form can object while the owner is still typing
  // rather than only after they submit.

  var COMMON_KEYS = ['password', 'passw0rd', 'qwerty', 'abc123', 'letmein', 'welcome',
                     'admin1', 'iloveyou', 'monkey', 'dragon', 'brewops', 'caffeine'];

  function keyProblem(key) {
    var k = String(key || '');
    if (k.length < 6) return 'Use at least 6 characters';
    if (k.length > 64) return 'Use at most 64 characters';
    if (/^(.)\1+$/.test(k)) return 'Not the same character repeated';
    if (/^\d+$/.test(k)) {
      if ('01234567890123456789'.indexOf(k) !== -1) return 'Not a run like 123456';
      if ('09876543210987654321'.indexOf(k) !== -1) return 'Not a run like 654321';
    }
    if (COMMON_KEYS.indexOf(k.toLowerCase()) !== -1) return 'That one is too widely used';
    return null;
  }

  function usernameProblem(name) {
    var u = String(name || '').trim().toLowerCase();
    if (u.length < 3) return 'Username needs at least 3 characters';
    if (u.length > 32) return 'Username is too long';
    if (!/^[a-z0-9._-]+$/.test(u)) return 'Letters, numbers, dot, dash and underscore only';
    if (u === 'owner' || u === 'admin') return 'That username is reserved';
    return null;
  }

  // --- session --------------------------------------------------------------
  // The sign-in persists on the device, so nobody re-authenticates on every
  // visit. After IDLE_LOCK_MS the app locks instead of signing out: the session
  // survives, but the access key is demanded again and re-checked by the server.

  function signOut() {
    unlock();
    return auth.signOut().then(function () { global.location.href = LOGIN_PAGE; });
  }

  function goToLogin() {
    if (global.location.pathname.indexOf(LOGIN_PAGE) === -1) {
      global.location.replace(LOGIN_PAGE);
    }
  }

  function isLocked() {
    try { return global.localStorage.getItem(LOCK_KEY) === '1'; } catch (e) { return false; }
  }
  function lock() {
    try { global.localStorage.setItem(LOCK_KEY, '1'); } catch (e) {}
    goToLogin();
  }
  function unlock() {
    try { global.localStorage.removeItem(LOCK_KEY); } catch (e) {}
  }

  var idleTimer = null;
  function armIdleLock() {
    function reset() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(lock, IDLE_LOCK_MS);
    }
    ['click', 'keydown', 'touchstart', 'pointerdown'].forEach(function (evt) {
      global.addEventListener(evt, reset, { passive: true });
    });
    reset();
  }

  var GUARD_TIMEOUT_MS = 15000;

  /**
   * Block a page until the session is confirmed and holds `required`.
   *
   * `required` is either the string 'owner' or a permission name. Resolves with
   * the session; never resolves when the check fails — it redirects instead, so
   * callers can render unconditionally.
   */
  function guard(required) {
    return new Promise(function (resolve) {
      var settled = false;

      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        if (global.TCMBoot) {
          global.TCMBoot.showFailure('Could not verify this terminal', [
            'The app loaded, but it could not reach the server to check your sign-in.'
          ], [
            'Check this device\'s internet connection.',
            'Disable any ad blocker or VPN for this site, then reload.',
            'If it still fails, open diagnostics.html for a detailed report.'
          ]);
        } else {
          goToLogin();
        }
      }, GUARD_TIMEOUT_MS);

      function finish(fn) { settled = true; clearTimeout(timer); fn(); }

      auth.onAuthStateChanged(function (user) {
        if (settled) return;
        if (!user) return finish(goToLogin);
        if (isLocked()) return finish(goToLogin);

        whoAmI().then(function (info) {
          if (settled) return;
          if (!info || !info.signedIn) return finish(goToLogin);

          session = {
            role: info.role,
            name: info.name || '',
            username: info.username || '',
            perms: info.perms || {},
            isOwner: !!info.isOwner
          };

          // `required` is 'owner', a permission name, or a list meaning any-of.
          var allowed;
          if (required === 'owner') {
            allowed = session.isOwner;
          } else if (Object.prototype.toString.call(required) === '[object Array]') {
            allowed = session.isOwner || required.some(can);
          } else {
            allowed = can(required);
          }
          if (!allowed) return finish(goToLogin);

          finish(function () { armIdleLock(); resolve(session); });
        }).catch(function () { if (!settled) finish(goToLogin); });
      }, function () {
        if (!settled) finish(goToLogin);
      });
    });
  }

  // --- device memory --------------------------------------------------------
  var LAST_USER_KEY = 'tcm.lastUser';

  function rememberUser(username) {
    try { global.localStorage.setItem(LAST_USER_KEY, String(username || '')); } catch (e) {}
  }
  function lastUser() {
    try { return global.localStorage.getItem(LAST_USER_KEY) || ''; } catch (e) { return ''; }
  }

  // ---------------------------------------------------------------------------
  // Misc helpers
  // ---------------------------------------------------------------------------
  function today() {
    return new Date().toLocaleDateString('en-GB');
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (global.location.protocol !== 'https:' && global.location.hostname !== 'localhost') return;
    navigator.serviceWorker.register('sw.js').catch(function () { /* non-fatal */ });
  }

  global.TCM = {
    db: db,
    auth: auth,
    fns: fns,

    // measurement + costing
    UNITS: UNITS,
    UNIT_DEFS: UNIT_DEFS,
    COST_WARNINGS: COST_WARNINGS,
    dimensionOf: dimensionOf,
    convertQty: convertQty,
    costOf: costOf,
    explodeRecipe: explodeRecipe,
    costRecipe: costRecipe,

    // ids, records
    nextPoNumber: nextPoNumber,
    poDocId: poDocId,
    newRequestId: newRequestId,
    monthKey: monthKey,
    today: today,

    // suppliers / messaging
    normalizePhone: normalizePhone,
    isPlausiblePhone: isPlausiblePhone,
    splitPhones: splitPhones,

    // invoice scanning
    MAX_SCAN_FILES: MAX_SCAN_FILES,
    compressImage: compressImage,

    // accounts and access
    PERMISSIONS: PERMISSIONS,
    PERMISSION_LABELS: PERMISSION_LABELS,
    session: currentSession,
    can: can,
    guard: guard,
    signOut: signOut,
    lock: lock,
    unlock: unlock,
    isLocked: isLocked,
    whoAmI: whoAmI,

    setupOwner: setupOwner,
    signInOwner: signInOwner,
    sendOwnerPasswordReset: sendOwnerPasswordReset,

    signIn: signIn,
    changeMyKey: changeMyKey,
    rememberUser: rememberUser,
    lastUser: lastUser,

    createUser: createUser,
    updateUser: updateUser,
    resetAccessKey: resetAccessKey,
    deleteUser: deleteUser,
    suggestAccessKey: suggestAccessKey,

    keyProblem: keyProblem,
    usernameProblem: usernameProblem,

    registerServiceWorker: registerServiceWorker
  };
})(window);
