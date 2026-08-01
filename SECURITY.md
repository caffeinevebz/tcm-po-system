# BrewOps — security setup

**Read this before deploying.** The app in this repository expects a Cloud
Function and a set of Firestore rules that do not exist in your Firebase project
yet. Until you complete steps 1–3, **nobody will be able to log in.**

---

## What changed and why

The previous version had no authentication at all.

`index.html` compared the PIN in plain JavaScript:

```js
if (pin === '170117')      window.location.href = 'owner.html';
else if (pin === '1234')   window.location.href = 'staff.html';
```

Three consequences:

1. Both PINs were readable by anyone via **View Source**.
2. The check could be skipped entirely by typing `…/owner.html` in the address
   bar — there was no session to check.
3. Because nothing ever called `firebase.auth()`, your Firestore rules had to be
   in open mode for the app to function. The project id and web API key are
   public (they must be, they ship in the page), so **anyone on the internet
   could read, rewrite or delete every purchase order, supplier phone number,
   cost price and recipe** with a few lines of script.

The `scanInvoice` callable was also unauthenticated, so a stranger could run up
your AI bill.

Now: the PIN is verified server-side against a scrypt hash, login attempts are
rate-limited, a successful login returns a Firebase session carrying a `role`
claim, and `firestore.rules` enforces what each role may touch. The client-side
guard in each page is convenience; **the rules are the actual security boundary.**

---

## Assume the old PINs are compromised

`170117` and `1234` were committed to a public repository and served in page
source. Treat them as public knowledge. **Choose new PINs in step 1** — do not
re-use either of them.

Also worth knowing: `170117` reads like a date and `1234` is the single most
guessed PIN in existence. Pick something without a personal meaning, and make
the owner PIN at least 6 digits.

---

## 1. Set the PINs

Generate a hash for each role. The PIN itself is never stored anywhere.

```bash
cd functions
npm install

node scripts/hash-pin.js 481902     # your new OWNER pin
node scripts/hash-pin.js 730514     # your new STAFF pin
```

Each prints one line like `9f2c…:4a7b…`. Store them as Firebase secrets:

```bash
firebase functions:secrets:set OWNER_PIN_HASH   # paste the owner line
firebase functions:secrets:set STAFF_PIN_HASH   # paste the staff line
```

Do not commit these values. `.gitignore` already excludes `.env` files.

To change a PIN later, generate a new hash and re-run `functions:secrets:set`.

## 2. Deploy the login function

> **Deploy by name.** Your existing `scanInvoice` function's source is not in
> this repository. A bare `firebase deploy --only functions` would delete it.

```bash
firebase deploy --only functions:verifyPin
```

## 3. Publish the Firestore rules

```bash
firebase deploy --only firestore:rules
```

Then confirm in the Firebase console under **Firestore → Rules** that the
published rules match `firestore.rules`, and that the "open until" warning
banner is gone.

## 4. Verify

- [ ] Open the app in a private window. You get the PIN screen.
- [ ] Type `…/owner.html` directly. You are bounced back to the login screen.
- [ ] Sign in with the staff PIN, then type `…/owner.html`. Still bounced.
- [ ] Sign in with the owner PIN. The dashboard loads.
- [ ] Enter a wrong PIN nine times. The ninth is refused with a lockout message.
- [ ] In the browser console on the login page, run:
      `firebase.firestore().collection('pos').get().then(s => console.log(s.size))`
      — it must fail with `permission-denied`.

---

## 5. Still to do (not done for you)

**Harden `scanInvoice`.** It currently accepts calls from anyone. Move its source
into `functions/`, then add the guard:

```js
const { requireRole } = require('./lib/auth-guard');

exports.scanInvoice = functions.https.onCall(async (data, context) => {
  requireRole(context, ['owner', 'staff']);   // <- add this line
  // ...your existing implementation...
});
```

Once its source lives here, `firebase deploy --only functions` becomes safe.

**Turn on App Check** (Firebase console → App Check, reCAPTCHA v3 provider) to
stop scripted abuse of `verifyPin` and `scanInvoice` from outside your app.

**Set a budget alert** on the Google Cloud project so a runaway scan loop shows
up as an email rather than a bill.

---

## Residual risks

| Risk | Status |
|---|---|
| Tailwind Play CDN (`cdn.tailwindcss.com/3.4.16`) has no integrity hash | The Play CDN is not published to npm, so a hash cannot be pinned offline. Run `npm run sri` on a networked machine to add one, or move to a prebuilt stylesheet. |
| CSP allows `'unsafe-eval'` | Required by `@babel/standalone`, which compiles the JSX in the browser. Removing it means adding a build step. |
| Two shared role accounts, not per-person logins | Adequate for a two-role shop, but there is no per-staff audit trail. `firestore.rules` keys off the `role` claim, not the uid, so real user accounts can be introduced without touching the rules. |
| Sessions last for the browser tab, plus a 30-minute inactivity timeout | Tune `IDLE_LOGOUT_MS` in `assets/tcm-core.js`. |

## Reporting a problem

If you think data has been accessed improperly, rotate both PINs (step 1),
redeploy `verifyPin`, and check **Firestore → Usage** in the console for read
spikes that do not match shop hours.
