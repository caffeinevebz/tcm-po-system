# BrewOps — security model

> **Setting up?** [SETUP.md](SETUP.md) is the click-by-click version.
> This page explains what is protecting what, and why.

Until the Cloud Functions and Firestore rules are deployed, **nobody can sign
in.** That is deliberate: there is no fallback path that works without them.

---

## What the app used to do

`index.html` compared the PIN in plain JavaScript:

```js
if (pin === '170117')      window.location.href = 'owner.html';
else if (pin === '1234')   window.location.href = 'staff.html';
```

Three consequences:

1. Both PINs were readable by anyone via **View Source**.
2. The check could be skipped entirely by typing `…/owner.html` in the address
   bar — there was no session to check.
3. Because nothing ever called `firebase.auth()`, the Firestore rules had to be
   in open mode for the app to work at all. The project id and web API key are
   public (they must be — they ship in the page), so **anyone on the internet
   could read, rewrite or delete every purchase order, supplier phone number,
   cost price and recipe.**

`170117` and `1234` were served in page source and committed to a public
repository. Treat both as public knowledge. Neither is used any more.

---

## Who can get in now

| | How they are identified | How they are added |
|---|---|---|
| **Owner** | The number in `OWNER_PHONE`, set at deploy time | Cannot be added, changed or granted from inside the app |
| **Staff** | Their own mobile number | Invite-only — the owner adds the number first |
| **Everyone else** | — | Refused, even with a valid SMS code |

Sign-in is two-stage by design:

- **First time, new device, or forgotten PIN** → mobile number + SMS one-time
  code. Firebase Phone Authentication sends the message and runs the anti-abuse
  checks; this app never sees or stores a code.
- **Every day after that** → mobile number + a PIN the person chose themselves.
  No SMS, no cost, no waiting.

PINs are stored as **scrypt hashes** (N=16384) in `_staffSecrets`, a collection
no client can read — not staff, not the owner. Verification happens only inside
`pinSignIn`. A PIN cannot be recovered, only replaced.

`pinSignIn` re-derives the role from current data on every call rather than
trusting the token, which is what makes **Remove** take effect immediately
rather than whenever a cached session happens to expire.

### Rate limiting

Eight wrong PINs for the same (network address + number) inside 15 minutes
triggers a 15-minute lockout, tracked in `_authThrottle`. An unknown number and
a wrong PIN return the identical message, so the login screen cannot be used to
discover who works at the shop.

---

## What each role may touch

Enforced by `firestore.rules` — the database refuses the write regardless of
what the page offers.

| | Owner | Staff |
|---|---|---|
| Raise material requests | ✓ | ✓ |
| Read the recipe book | ✓ | ✓ |
| **Add** a recipe | ✓ | ✓ (stamped with their uid) |
| **Edit or delete** a recipe | ✓ | ✗ — including their own |
| Book in a delivery against an approved PO | ✓ | ✓ status/received lines only |
| Teach the invoice scanner an alias | ✓ | ✓ |
| Cost prices, vendors, catalogue, prep rules | ✓ | ✗ |
| Create, amend, cancel POs | ✓ | ✗ |
| Add or remove team members | ✓ (via function) | ✗ |
| Read another person's team record | ✓ | ✗ |
| Read any PIN hash | ✗ | ✗ |

`staffMembers` is **read-only to every client**. Membership changes go through
`inviteStaff` and `setStaffStatus`, so a staff member cannot invite themselves
or flip their own status back to active after being removed.

**40 automated tests** assert all of this against the real Firestore rules
engine: `npm run test:rules`.

---

## Deploying

```bash
cd functions && npm install && cd ..
npm run deploy:auth     # prompts for OWNER_PHONE on the first run
npm run deploy:rules
```

`deploy:auth` names each function explicitly. A bare
`firebase deploy --only functions` would delete `scanInvoice`, whose source is
not in this repository.

Phone sign-in must also be enabled once in the Firebase console
(**Authentication → Sign-in method → Phone**), and the site's domain added under
**Authentication → Settings → Authorized domains**.

### Verify

- [ ] A private window shows the sign-in screen.
- [ ] Typing `…/owner.html` directly bounces back to sign-in.
- [ ] A staff session typing `…/owner.html` still bounces.
- [ ] An uninvited number is refused after a valid SMS code.
- [ ] `/diagnostics.html` reports *Database correctly refuses unauthenticated
      access*.

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

**Set a budget alert** on the Google Cloud project so a runaway scan or SMS loop
arrives as an email rather than a bill.

---

## Residual risks

| Risk | Status |
|---|---|
| Tailwind Play CDN has no integrity hash | The Play CDN is not published to npm, so a hash cannot be pinned offline. Run `npm run sri` on a networked machine to add one, or move to a prebuilt stylesheet. |
| CSP allows `'unsafe-eval'` | Required by `@babel/standalone`, which compiles the JSX in the browser. Removing it means adding a build step. |
| SMS costs money | Only on first registration, a new device, or a forgotten PIN. Daily usage is PIN-only. |
| Sessions last for the browser tab, plus a 30-minute inactivity timeout | Tune `IDLE_LOGOUT_MS` in `assets/tcm-core.js`. |
| A staff member keeps read access to prices they memorised | Nothing technical fixes this; **Remove** cuts off future access immediately. |

## If you suspect a problem

Remove the person in **Team & Access** — that revokes their sessions and deletes
their PIN straight away. Then check **Firestore → Usage** in the console for
read spikes that do not match shop hours.
