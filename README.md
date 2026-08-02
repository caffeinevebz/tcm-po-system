# ☕ TCM BrewOps

Purchase orders, raw-material inventory, recipe management and food costing for
**The Caffeine Ministry**, Jodhpur.

Two terminals — an owner command centre and a staff terminal — backed by
Firebase (Firestore + Cloud Functions).

**Signing in:** the owner uses an email address and password. Everyone else uses
a username and an access key the owner issued in *Users & Access*, together with
a tick-list of exactly what they may open. There is no SMS, no one-time code and
no self-registration. The session persists on the device; after 30 minutes idle
the app *locks* and asks for the access key again.

> **First time, or seeing "Login service not set up yet"?**
> Follow **[SETUP.md](SETUP.md)** — a ten-minute, browser-only walkthrough.
> The security model is explained in **[SECURITY.md](SECURITY.md)**.

---

## The two terminals

### `owner.html` — Owner Command Center
- **Dashboard** — recipe counts, open shipments, pending requests, top suppliers
- **Manage Orders & POs** — triage staff requests into purchase orders, amend
  open POs, dispatch to suppliers over WhatsApp, audit delivered invoices
- **Kitchen Recipe Book** — author recipes and see a live landed-cost breakdown
- **Prep Kitchen Engine** — map raw materials to prepped units
  (e.g. 18 gms of beans → one 30 ml espresso shot)
- **Vendor Directory** — suppliers and their WhatsApp numbers
- **Raw Material Master** — the catalogue plus the master price book (with GST)
- **Users & Access** — create accounts, issue access keys, set per-area permissions

### `staff.html` — Staff Terminal
- Draft material requests from the catalogue and send them to the owner
- Book in deliveries against an open PO, with AI invoice scanning
- Read the whole recipe book, and **add** new recipes
- Cannot edit or delete any recipe, and never sees cost prices

The owner can also use the staff terminal; staff cannot open the owner terminal.

---

## Architecture

| | |
|---|---|
| UI | React 18 (UMD) with JSX compiled in the browser by Babel Standalone |
| Styling | Tailwind Play CDN + a shared theme in `assets/tcm-theme.js` |
| Data | Cloud Firestore (live `onSnapshot` listeners) |
| Auth | Owner: Firebase Email/Password. Users: username + access key, verified server-side against a scrypt hash |
| Invoice OCR | `scanInvoice` callable Cloud Function |
| Hosting | Any static host (Firebase Hosting config included) |

There is no build step. The three HTML files can be edited directly and
uploaded.

```
├── index.html              Login terminal
├── owner.html              Owner command centre
├── staff.html              Staff terminal
├── sw.js                   Service worker (static assets only)
├── manifest.json           PWA manifest
├── diagnostics.html        Self-check page: reports exactly what is broken
├── firestore.rules         Role-based database rules  ← the security boundary
├── firebase.json           Rules, functions and hosting headers
├── assets/
│   ├── tcm-boot.js         Load guard; reports missing dependencies
│   ├── tcm-core.js         Firebase handles, unit maths, costing, ids, auth
│   ├── tcm-theme.js        Shared Tailwind theme
│   └── *.jpg, *.png        Web-sized image derivatives
├── functions/
│   ├── index.js            accounts, permissions, sign-in, rate limiting
│   └── lib/auth-guard.js   requireRole() for other callables
└── tools/
    ├── test-costing.mjs    Unit tests for the costing engine
    ├── test-rules.mjs      Security tests for firestore.rules
    ├── test-auth-flows.mjs Sign-in journeys against the emulators
    ├── sri.mjs             Regenerate/verify CDN integrity hashes
    └── optimize-images.mjs Rebuild the assets/ image derivatives
```

### `assets/tcm-core.js`

Shared by all three pages so the two terminals cannot drift apart. It owns:

- Firebase app, Firestore, Auth and Functions handles
- **Unit conversion** — dimension-aware (mass / volume / count), and explicitly
  refuses conversions it cannot make instead of guessing
- **Costing** — recipe explosion through batch preps and prep rules, with cycle
  detection, and per-line reasons when something cannot be costed
- **Id allocation** — transactional PO numbers, collision-resistant request ids
- **Accounts** — `signInOwner`, `signIn`, `changeMyKey`, `guard(permission)`,
  `can(permission)`, inactivity lock

---

## Data model

**`settings/main`** — one document holding the catalogue and configuration:

| Field | Meaning |
|---|---|
| `inventory` | `{ category: [item names] }` — the raw-material catalogue |
| `prices` | `{ itemName: { price, unit, gst } }` — the master price book |
| `suppliers` | `[{ name, phone }]` |
| `prepItems` | Prep-kitchen conversion rules |
| `poCounter` | `{ month, count }` — allocated transactionally |
| `aliases` | Invoice line text → catalogue item name, taught by the scanner |
| `ownerPhone` | Where staff request alerts are sent |

**`users/{username}`** — one document per account, with its permission flags.
Mirrored to **`userIndex/{uid}`** so the security rules can find it by uid. Both
are read-only to every client; only Cloud Functions write them.

**`requests/{id}`** — staff material requests awaiting triage.
**`pos/{id}`** — purchase orders (`Approved` → `Delivered`). The document id is
the PO number with `/` replaced by `-`.
**`recipes/{id}`** — recipes and batch preps.

> Everything is keyed by **item name**. Renaming a catalogue item is a migration:
> `handleEditInventoryItem` carries the rename into `prices`, `prepItems` and
> every affected recipe. Editing names directly in the Firebase console will
> orphan recipe ingredients.

---

## How costing works

A recipe ingredient can be a raw material, a **prep rule** output, or another
**Batch Prep** recipe. Costing explodes it to raw materials and prices each line
from the master price book.

```
Iced Latte
├── Espresso Shot   60 ml   → prep rule: 30 ml yields from 18 gms beans
│                            → 36 gms Arabica @ ₹2000/Kg = ₹72.00
└── Milk           180 ml   → @ ₹60/Ltr                  = ₹10.80
                                              Landed cost = ₹82.80
```

Quantities are converted before being summed, so `100 gms + 0.5 Kg` is `600 gms`,
and a sub-recipe is scaled by its yield in matching units.

When a line **cannot** be costed — no master price, or a unit that cannot be
converted to the purchase unit — the app says so and marks the total
`≥ ₹x` / *Incomplete*, rather than contributing a silent ₹0.

Run the tests for the engine:

```bash
npm test            # costing, unit conversion, id allocation  (23 tests)
npm run test:rules  # firestore.rules access boundary         (49 tests, needs Java)
npm run test:auth   # account journeys against the emulators  (33 tests, needs Java)
```

---

## Local development

```bash
npm install                       # sharp, for the image tooling only

npx serve .                       # or: python3 -m http.server 8000
```

Open `http://localhost:8000`. The app talks to the live Firebase project, so a
local session is a real session — sign out when you are done.

To rebuild the image derivatives after replacing a photo:

```bash
npm run images
```

To verify the CDN integrity hashes still match (do this after any version bump):

```bash
npm run sri:check
```

---

## Deploying

Static hosting of the repository root is all that is required. With Firebase
Hosting you also get the security headers defined in `firebase.json`:

```bash
firebase deploy --only hosting
```

Rules and functions deploy separately — see [SECURITY.md](SECURITY.md).

---

## Known limitations

- **Stock is not tracked.** The app manages purchasing and costing; it does not
  hold live on-hand quantities or deduct consumption from sales.
- **Recipe costs are current-price snapshots**, not point-in-time historical
  costs — re-costing a recipe uses today's price book.
- **Count units** (`Piece`, `Jar`, `Pkt`, `Carton`, `Tin`, `Bottle`, `bunch`) do
  not convert between each other, because no pack size is recorded. Price such
  items in the same unit the recipes use.
- **Recipes are add-only for staff.** A mistake in a staff-written recipe has to
  be corrected by the owner.
