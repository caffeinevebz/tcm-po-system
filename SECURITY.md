# BrewOps — security model

> **Setting up?** [SETUP.md](SETUP.md) is the click-by-click version.
> This page explains what is protecting what, and why.

Until the Cloud Functions and Firestore rules are deployed, **nobody can sign
in.** That is deliberate: there is no fallback path that works without them.

---

## What the app used to do

`index.html` compared a PIN in plain JavaScript:

```js
if (pin === '170117')      window.location.href = 'owner.html';
else if (pin === '1234')   window.location.href = 'staff.html';
```

Both PINs were readable via **View Source**; the check could be skipped by typing
`…/owner.html`; and because nothing ever called `firebase.auth()`, the Firestore
rules had to be wide open for the app to work at all. The project id and web API
key ship in the page, so **anyone on the internet could read, rewrite or delete
every purchase order, supplier phone number, cost price and recipe.**

Treat `170117` and `1234` as public knowledge. Neither is used any more.

---

## Who can get in

| | How they sign in | How the account is made |
|---|---|---|
| **Owner** | Email address + password | Fixed by `OWNER_EMAIL` at deploy time. Cannot be created, renamed or granted from inside the app. |
| **User** | Username + an access key the owner issued | The owner creates it in *Users & Access*. |
| **Everyone else** | — | No self-registration exists anywhere. |

There is **no SMS and no one-time code**. Users hold no email, no phone and no
Firebase provider credential of their own — the server mints their session after
checking the access key. That means the only sign-in provider this project needs
enabled is **Email/Password**, for the owner.

Access keys are stored as **scrypt hashes** (N=16384) in `_userSecrets`, a
collection no client can read — not the user, not the owner. Verification happens
only inside the `signIn` function. A key cannot be recovered, only reissued, and
a key the owner issued is marked *must change*, so the person replaces it on
first use and the owner no longer knows it.

The session persists on the device. After 30 minutes idle the app **locks**: the
session survives but the access key is demanded again and re-checked by the
server. A full sign-out discards the session.

### Rate limiting

Ten wrong keys for the same (network address + username) inside 15 minutes
triggers a 15-minute lockout, tracked in `_authThrottle`. An unknown username and
a wrong key return the identical message, so the sign-in screen cannot be used to
discover who works at the shop.

---

## What each account may touch

The owner ticks these per person. `firestore.rules` reads the same flags from the
account document on **every request**, so un-ticking a box refuses the write as
well as hiding the button, and takes effect on the very next operation — no
waiting for a cached token to expire.

| Permission | Grants |
|---|---|
| `requests` | Raise material requests |
| `recipesView` | Read the recipe book |
| `recipesAdd` | Add a recipe (stamped with their uid); never edit one |
| `recipesEdit` | Change or delete any recipe |
| `receive` | Mark an approved PO delivered and record what arrived |
| `poManage` | Create, amend and cancel purchase orders |
| `inventory` | Edit the catalogue and prep rules |
| `prices` | See and edit cost prices |
| `vendors` | Manage the vendor directory |
| `team` | **Owner only.** Can never be granted — a user who could grant permissions could grant themselves all the others. |

Accounts live in `users/{username}`, mirrored to `userIndex/{uid}` so the rules
can look someone up by uid without a query. **Both are read-only to every
client, including the owner.** All changes go through Cloud Functions, so a user
cannot tick their own boxes or un-suspend themselves.

**49 rules tests** and **33 account-flow tests** assert all of this against the
real Firestore and Auth emulators:

```bash
npm run test:rules
npm run test:auth
```

---

## Deploying

```bash
cd functions && npm install && cd ..
npm run deploy:auth      # prompts for OWNER_EMAIL on the first run
npm run deploy:rules
```

`deploy:auth` names each function explicitly. A bare
`firebase deploy --only functions` would delete `scanInvoice`, whose source is not
in this repository.

One console setting: **Authentication → Sign-in method → Email/Password →
Enable**, plus your domain under **Settings → Authorized domains**. Phone
sign-in, the SMS region policy and reCAPTCHA are no longer used at all.

### Verify

- [ ] A private window shows the sign-in screen.
- [ ] Typing `…/owner.html` directly bounces back to sign-in.
- [ ] A staff session typing `…/owner.html` still bounces.
- [ ] Suspending someone signs them out immediately.
- [ ] `/diagnostics.html` reports *Database correctly refuses unauthenticated access*.

---

## Still to do

**Harden `scanInvoice`.** It currently accepts calls from anyone on the
internet, so a stranger can run up your AI bill. Move its source into
`functions/`, then add two lines:

```js
const { requireRole } = require('./lib/auth-guard');

exports.scanInvoice = functions.https.onCall(async (data, context) => {
  requireRole(context, ['owner', 'staff']);   // <- add this
  // ...existing implementation...
});
```

Once its source lives here, `firebase deploy --only functions` becomes safe.

**Turn on App Check** (console → App Check, reCAPTCHA v3) to stop scripted abuse
of the callables from outside your app.

**Set a budget alert** on the Google Cloud project so a runaway invoice-scan
loop arrives as an email rather than a bill.

---

## Residual risks

| Risk | Status |
|---|---|
| Tailwind Play CDN has no integrity hash | The Play CDN is not published to npm, so a hash cannot be pinned offline. Run `npm run sri` on a networked machine to add one, or move to a prebuilt stylesheet. |
| CSP allows `'unsafe-eval'` | Required by `@babel/standalone`, which compiles the JSX in the browser. Removing it means adding a build step. |
| An access key is a shared secret until the person changes it | New accounts are flagged *must change*, so the owner stops knowing it after first use. |
| No second factor | An access key is one factor. For a shop terminal that is a deliberate trade for speed; the 30-minute lock limits the window. |
| Sessions persist on the device, with a 30-minute inactivity lock | Tune `IDLE_LOCK_MS` in `assets/tcm-core.js`. |
| Someone keeps prices they memorised | Nothing technical fixes this; **Suspend** cuts off future access immediately. |

## If you suspect a problem

Suspend the person in **Users & Access** — that clears their role and revokes
their sessions immediately. Then check **Firestore → Usage** in the console for
read spikes that do not match shop hours.
