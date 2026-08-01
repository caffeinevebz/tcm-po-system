# One-time setup — no software to install

If you are seeing **"Login service not set up yet"** on the sign-in screen, this
page is what you need. It takes about ten minutes and runs entirely in a browser
tab, using Google Cloud Shell. Nothing gets installed on your computer.

You need the Google account that owns the `tcm-orders` Firebase project.

> **Why is this needed?** The PIN used to be compared inside the web page, so it
> was readable by anyone who viewed the page source, and the dashboard could be
> opened by typing its address. The PIN is now checked by a small program on
> Google's servers. That program has to be uploaded once — that is what you are
> about to do.

---

## Before you start

Your project must be on the **Blaze (pay-as-you-go)** plan. It already is if
invoice scanning works, since that also runs on Cloud Functions. Setup costs
nothing extra; the login check is far below the free monthly allowance.

---

## Step 1 — Open Cloud Shell

Go to **<https://shell.cloud.google.com>** and sign in with the Google account
that owns the project.

A black terminal panel opens at the bottom of the browser. Wait until it shows a
prompt ending in `$`. If it asks you to authorise or pick a project, say yes and
pick **tcm-orders**.

Everything below is typed into that black panel. Press **Enter** after each
block. Copy-paste works — right-click, then Paste.

## Step 2 — Get the code

```bash
git clone https://github.com/caffeinevebz/tcm-po-system.git
cd tcm-po-system
git checkout claude/app-security-effectiveness-review-gvwpx3
```

> Already cloned it before? Run `cd tcm-po-system && git pull` instead.

## Step 3 — Choose your PINs

Pick two new numeric PINs — one for you, one for the staff terminal.

**Do not re-use `170117` or `1234`.** Both were published in the page source and
in this repository's history, so they should be considered public. Make the owner
PIN at least 6 digits and avoid dates and birthdays.

Generate the owner PIN's fingerprint, replacing `481902` with your chosen PIN:

```bash
cd functions
npm install
node scripts/hash-pin.js 481902
```

It prints one long line of letters and numbers, like
`3f9a…c21b:7d40…9e6f`. **Select that whole line and copy it.**

Now store it:

```bash
firebase functions:secrets:set OWNER_PIN_HASH --project tcm-orders
```

It waits with a blank line — **paste the copied line and press Enter**. If it
asks about enabling the Secret Manager API, answer **yes**.

Repeat for the staff PIN:

```bash
node scripts/hash-pin.js 730514
firebase functions:secrets:set STAFF_PIN_HASH --project tcm-orders
```

> Your actual PIN is never stored anywhere — only this one-way fingerprint. That
> means nobody, including Google, can read your PIN back out. It also means if
> you forget it, you simply repeat this step with a new one.

## Step 4 — Upload the login checker

```bash
cd ~/tcm-po-system
firebase deploy --only functions:verifyPin --project tcm-orders
```

This takes two or three minutes. Wait for **`Deploy complete!`**.

> ⚠️ Type this command exactly. The `--only functions:verifyPin` part matters:
> plain `firebase deploy --only functions` would **delete your invoice scanner**,
> because its code is not in this repository.

## Step 5 — Lock the database

```bash
firebase deploy --only firestore:rules --project tcm-orders
```

This is the step that stops strangers reading your purchase orders, cost prices
and supplier phone numbers. Until you run it, your database is readable by anyone
on the internet who knows the project name — which is visible in the page source.

## Step 6 — Publish the updated website

How you do this depends on where the app is hosted.

**If you upload files to GitHub through the website**, merge the branch
`claude/app-security-effectiveness-review-gvwpx3` into `main` on GitHub, and your
host will pick it up.

**If you use Firebase Hosting**, run:

```bash
firebase deploy --only hosting --project tcm-orders
```

## Step 7 — Check it worked

Open the app and add `/diagnostics.html` to the address, for example
`https://your-site/diagnostics.html`.

You want a green **"Everything checks out"**. In particular:

- *Login service is deployed and rejecting bad PINs* — Step 4 worked
- *Database correctly refuses unauthenticated access* — Step 5 worked

Then sign in with your **new** owner PIN.

---

## If something goes wrong

**"Login service not set up yet" is still showing**
Your browser is probably still running the old page. Open `/diagnostics.html`,
and if it offers *Clear cached app*, click it. Otherwise reload with
`Ctrl+Shift+R` (`Cmd+Shift+R` on a Mac).

**"Terminal denied"**
The function is working — the PIN is simply wrong. Redo Step 3 with a PIN you are
sure of. Note there is no space or extra line when you paste the fingerprint.

**"Too many attempts"**
The lockout after 8 wrong tries. Wait 15 minutes, or use a different device.

**`Error: HTTP Error: 403` during deploy**
The signed-in account does not own the project. In Cloud Shell run
`firebase login --reauth` and pick the right Google account.

**Diagnostics says the database is readable without signing in**
Step 5 did not take effect. Re-run it, then check
**Firebase console → Firestore → Rules** to confirm the published rules mention
`role`.

**Invoice scanning stopped working**
A plain `firebase deploy --only functions` was run and removed it. Re-deploy
`scanInvoice` from wherever its source lives, then follow the note in
[SECURITY.md](SECURITY.md) to move it into this repository so it cannot happen
again.

---

## Changing a PIN later

Repeat Step 3 with the new PIN, then Step 4. Takes about two minutes. Do this
whenever someone who knew the staff PIN leaves.
