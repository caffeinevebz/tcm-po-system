# One-time setup — no software to install

Ten minutes, entirely in a browser tab. Nothing gets installed on your computer.

You need the Google account that owns the `tcm-orders` Firebase project.

---

## How signing in works now

- **You (the owner)** are identified by your mobile number. There is exactly one
  owner and it cannot be invited, changed from inside the app, or granted to
  anyone else.
- **Staff are invite-only.** You add someone's mobile number in **Team & Access**
  first. Only a number on that list can register — a stranger who enters their
  own number is refused even with a valid SMS code.
- Everyone signs in the **first time** with an SMS code, then picks their own
  **PIN**. After that it is just number + PIN, with no SMS and no waiting.

The old shared PINs are gone. Nothing about who can get in is stored in the web
page any more.

---

## Before you start

Your project must be on the **Blaze (pay-as-you-go)** plan. It already is if
invoice scanning works. Phone sign-in includes a free monthly SMS allowance;
because everyone switches to a PIN after registering, a shop of five people
sends only a handful of messages a month.

---

## Step 1 — Switch on phone sign-in

1. Open the [Firebase console](https://console.firebase.google.com/) and pick
   **tcm-orders**.
2. Go to **Build → Authentication**. Click **Get started** if you have never
   opened it.
3. Open the **Sign-in method** tab, click **Phone**, turn it **Enable** on, and
   **Save**.
4. Open the **Settings** tab → **Authorized domains** → **Add domain**, and add
   the web address where the app lives (for example `caffeinevebz.github.io`).
   Skip this and the SMS step fails with a security-check error.

## Step 2 — Open Cloud Shell

Go to **<https://shell.cloud.google.com>** and sign in with the same Google
account. A black terminal panel opens. Wait for a prompt ending in `$`. If it
asks you to authorise or pick a project, say yes and choose **tcm-orders**.

Everything below is typed into that panel. Copy-paste works — right-click, Paste.

## Step 3 — Get the code

```bash
git clone https://github.com/caffeinevebz/tcm-po-system.git
cd tcm-po-system
git checkout claude/app-security-effectiveness-review-gvwpx3
```

> Cloned it before? Run `cd tcm-po-system && git pull` instead.

## Step 4 — Upload the sign-in service

```bash
cd functions
npm install
cd ..
npm run deploy:auth
```

The first time, it asks:

```
Enter a value for OWNER_PHONE:
```

Type **your** mobile number in international form — `+919876543210` — and press
Enter. This is the number that gets owner access. Nobody else can claim it.

Wait for **`Deploy complete!`** (two or three minutes).

> ⚠️ Use `npm run deploy:auth`, which deploys the four sign-in functions by
> name. A plain `firebase deploy --only functions` would **delete your invoice
> scanner**, because its code is not in this repository.

## Step 5 — Lock the database

```bash
npm run deploy:rules
```

This is the step that stops strangers reading your purchase orders, cost prices
and supplier phone numbers. Until you run it, anyone on the internet who knows
the project name — which is visible in the page source — can read the lot.

## Step 6 — Publish the updated website

**If you upload files through the GitHub website**, merge the branch
`claude/app-security-effectiveness-review-gvwpx3` into `main`.

**If you use Firebase Hosting**:

```bash
firebase deploy --only hosting --project tcm-orders
```

## Step 7 — Sign in and add your team

1. Open the app. Enter **your** mobile number → you get an SMS code.
2. Enter the code, then choose a PIN. You land on the owner dashboard.
3. Open the menu → **Team & Access**.
4. Type a staff member's name and mobile number → **Add & send invite on
   WhatsApp**. Their invite message opens ready to send.
5. They open the link, enter their number, get a code, and pick their own PIN.

To remove someone, tap **Remove** next to their name. They are signed out
everywhere immediately and their PIN is deleted.

## Step 8 — Check it worked

Open `/diagnostics.html` on your site. You want a green **"Everything checks
out"**, and in particular:

- *Login service is deployed*
- *Database correctly refuses unauthenticated access*

---

## What staff can and cannot do

| | Owner | Staff |
|---|---|---|
| Raise material requests | ✓ | ✓ |
| Read the recipe book | ✓ | ✓ |
| **Add** a new recipe | ✓ | ✓ |
| **Edit or delete** a recipe | ✓ | ✗ |
| Book in a delivery against a PO | ✓ | ✓ |
| See cost prices and food cost | ✓ | ✗ |
| Create, change or cancel POs | ✓ | ✗ |
| Vendors, catalogue, prep rules | ✓ | ✗ |
| Add or remove team members | ✓ | ✗ |

These limits are enforced by the database itself, not just by hiding buttons —
40 automated tests check them on every change (`npm run test:rules`).

---

## If something goes wrong

**"This number has not been added to the team"**
Correct behaviour for an uninvited number. Add it in **Team & Access** first.

**"Phone sign-in is not switched on in Firebase yet"**
Step 1 was skipped or not saved.

**"Security check failed. Reload the page and try again"**
The site's domain is missing from **Authentication → Settings → Authorized
domains**. Add it, then reload.

**"Login service not set up yet"**
Step 4 has not run, or the browser is showing an old copy of the page. Open
`/diagnostics.html`, click *Clear cached app* if offered, then reload with
`Ctrl+Shift+R` (`Cmd+Shift+R` on a Mac).

**No SMS arrives**
Check the number, including the country code. Firebase limits how many codes go
to one number in a short period; wait a few minutes. Daily SMS quota is visible
under **Authentication → Usage**.

**"Number or PIN is wrong" but the PIN is right**
PINs are per person. If you cleared browser data or switched devices, tap
*Forgot PIN? Use SMS code* and set it again.

**"Too many attempts"**
The lockout after 8 wrong PINs. Wait 15 minutes, or sign in with an SMS code.

**`Error: HTTP Error: 403` during deploy**
The signed-in account does not own the project. Run `firebase login --reauth`
and pick the right Google account.

**Invoice scanning stopped working**
A plain `firebase deploy --only functions` was run and removed it. Re-deploy
`scanInvoice` from wherever its source lives, then follow the note in
[SECURITY.md](SECURITY.md) to move it into this repository so it cannot happen
again.

---

## Changing the owner number

Re-run `npm run deploy:auth`. To be prompted again, first clear the stored value:

```bash
rm -f functions/.env.tcm-orders
npm run deploy:auth
```
