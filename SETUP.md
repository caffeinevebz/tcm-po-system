# One-time setup — no software to install

About ten minutes, entirely in a browser tab.

You need the Google account that owns the `tcm-orders` Firebase project.

---

## How signing in works

**There is no SMS, no one-time code and no self-registration.** Two doors, and
only two:

- **You (the owner)** sign in with an **email address and password**. Exactly one
  owner account, fixed when the app is deployed. It cannot be created, renamed or
  granted from inside the app.
- **Everyone else** signs in with a **username and an access key you issue**. You
  create every account yourself in *Users & Access*, decide what each person can
  open, and can suspend or delete them at any time.

Nobody can sign themselves up. There is no "forgot password" path for staff — if
someone loses their key, you issue a new one in two taps.

The sign-in then stays on the device. After 30 minutes idle the app *locks*
rather than signing out, so getting back in is just the access key, re-checked by
the server.

---

## Before you start

Your project must be on the **Blaze (pay-as-you-go)** plan. It already is if
invoice scanning works. Nothing here sends SMS, so there is no per-message cost.

---

## Step 1 — Switch on email sign-in

1. Open the [Firebase console](https://console.firebase.google.com/) and pick
   **tcm-orders**.
2. **Build → Authentication**. Click *Get started* if you have never opened it.
3. **Sign-in method** tab → **Email/Password** → turn the first toggle **Enable**
   on → **Save**. Leave *Email link* off; it is not used.
4. **Settings → Authorized domains → Add domain** and enter the web address where
   the app lives, for example `tcm-po-system.vercel.app`.

That is the whole console setup. **Phone sign-in is no longer used** — if you
enabled it before, you can switch it off, along with the SMS region policy.

## Step 2 — Open Cloud Shell

Go to **<https://shell.cloud.google.com>** and sign in with the same Google
account. A black terminal panel opens. Wait for a prompt ending in `$`, and pick
**tcm-orders** if asked.

## Step 3 — Get the code

```bash
git clone https://github.com/caffeinevebz/tcm-po-system.git
cd tcm-po-system
git checkout claude/app-security-effectiveness-review-gvwpx3
firebase use tcm-orders
```

> Cloned it before? `cd tcm-po-system && git pull` instead.

## Step 4 — Upload the account service

```bash
cd functions
npm install
cd ..
npm run deploy:auth
```

The first time it asks:

```
Enter a value for OWNER_EMAIL:
```

Type **your** email address. That address, and only that address, gets owner
access. Wait for **`Deploy complete!`**.

> ⚠️ Use `npm run deploy:auth`, which deploys the account functions by name. A
> plain `firebase deploy --only functions` would **delete your invoice scanner**,
> whose source is not in this repository.

## Step 5 — Lock the database

```bash
npm run deploy:rules
```

This is what stops strangers reading your purchase orders and cost prices. Until
you run it, anyone who knows the project name — visible in the page source — can
read everything.

## Step 6 — Publish the website

Merge the branch `claude/app-security-effectiveness-review-gvwpx3` into `main`
and your host will rebuild. (On Firebase Hosting:
`firebase deploy --only hosting --project tcm-orders`.)

## Step 7 — Create your owner account

1. Open the app.
2. Tap **Owner sign-in**, then **First time? Create the owner account**.
3. Enter the same email you gave in step 4, and choose a password of at least
   10 characters. This works **once**.
4. You land on the owner dashboard.

## Step 8 — Add your team

Menu → **Users & Access**.

1. Type their name and pick a username (`rahul`).
2. Choose a role — **staff**, **manager** or **viewer** — which ticks a sensible
   starting set of boxes. Adjust any box you like.
3. Tap **Generate** for a readable access key, or type your own.
4. **Create account.** The key is shown **once** — write it down or send it now.
   It is stored only as a hash, so it can never be shown again; if it is lost you
   issue a new one.
5. They open the app, enter that username and key, and are asked to choose their
   own key on first use.

Tap **Access** next to anyone to change what they can open, issue a new key,
suspend them, or delete them. Suspending signs them out everywhere immediately.

## Step 9 — Check it worked

Open `/diagnostics.html` on your site. You want:

- *Sign-in service is deployed*
- *This domain is authorised for sign-in*
- *Database correctly refuses unauthenticated access*

---

## What each person can open

You tick these per account. The database enforces every one of them, so
un-ticking a box refuses the write as well as hiding the button.

| Permission | What it allows |
|---|---|
| Raise material requests | Send an order list to the owner |
| Read the recipe book | View recipes and methods |
| Add new recipes | Write a new recipe (never edit an existing one) |
| Change or delete recipes | Correct or remove any recipe |
| Book in deliveries | Mark an approved PO delivered and record what arrived |
| Create and manage POs | Raise, amend and cancel purchase orders |
| Edit the catalogue and prep rules | Raw materials, categories, conversions |
| See and edit cost prices | The price book and food-cost figures |
| Manage vendors | Supplier list and contact numbers |

**Managing users is owner-only** and can never be granted — otherwise a user
could grant themselves everything else.

Presets: **staff** = requests, read + add recipes, receive. **manager** = that
plus edit recipes, POs, catalogue and vendors. **viewer** = read recipes only.

Anyone with *Create and manage POs* gets the full command centre; everyone else
gets the shop-floor terminal.

---

## If something goes wrong

**"Username or access key is wrong"**
Deliberately the same message whether the username is unknown or the key is
wrong, so the screen cannot be used to discover who works here. Check both, or
issue a new key from *Users & Access*.

**"Sign-in service not deployed"**
Step 4 has not run, or the browser is showing an old copy of the page. Open
`/diagnostics.html` and use **Clear cached app & reload**.

**"Email sign-in is not switched on in Firebase yet"**
Step 1.3 was skipped or not saved.

**"That address is not the configured owner address"**
The email typed in step 7 does not match `OWNER_EMAIL` from step 4.

**"The owner account already exists"**
Step 7 has been done. Just sign in. Forgotten the password? Use *Email me a
password reset* on the owner screen.

**"Too many attempts"**
Ten wrong access keys from the same place locks that account for 15 minutes.

**`Error: HTTP Error: 403` during deploy**
The signed-in account does not own the project. Run `firebase login --reauth`.

**Invoice scanning stopped working**
A plain `firebase deploy --only functions` removed it. Re-deploy `scanInvoice`
from wherever its source lives, then follow the note in [SECURITY.md](SECURITY.md)
so it cannot happen again.

---

## Changing the owner email

```bash
rm -f functions/.env.tcm-orders
npm run deploy:auth
```

Then create the new owner account in the Firebase console, or re-run step 7 after
deleting the old account under **Authentication → Users**.
