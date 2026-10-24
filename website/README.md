# thecaffeineministry.in — the public website

The café's public face: home page, QR menu, table reservations, story, events
and contact pages. Plain HTML, CSS and a little JavaScript, with no build step.
Edit a file, deploy it, done.

Everything that changes day to day is managed from **BrewOps → Website &
Bookings** (owner terminal), not from these files:

| In BrewOps | What it changes on the website |
|---|---|
| **Reservations** | Booking requests arrive here live. Confirm, decline, seat or mark no-show, and message the guest on WhatsApp in one tap. |
| **Menu** | The QR menu. Edit sections, items, prices, veg marks, *Signature*/*New* tags and *Sold out*, then press **Publish**. *Import from recipe book* copies your dish names in (names only, never costs). |
| **Café details** | Phone, WhatsApp, email, Instagram, address, opening hours, closed days, the announcement bar, and the booking rules (largest party, time slots, how far ahead). |
| **QR codes** | Opens a printable sheet with one QR code per table (`/menu?table=7`). |

Until you publish a menu, the website shows the **sample menu** in
`data/menu.json`, with a note telling guests it's a preview. Until you fill in
café details, phone/WhatsApp/email/Instagram links stay hidden and the hours
default to 9 AM–11 PM daily.

---

## Pages

| Path | File | |
|---|---|---|
| `/` | `index.html` | Home |
| `/menu` | `menu.html` | QR menu: search, veg filter, table number from `?table=` |
| `/reserve` | `reserve.html` | Booking form → `createReservation` Cloud Function |
| `/about` | `about.html` | Our story |
| `/events` | `events.html` | Events & private hire; enquiry opens in WhatsApp/email |
| `/visit` | `visit.html` | Hours, map, contact, FAQ |
| `/privacy` | `privacy.html` | What we do with booking details |
| `/qr` | `qr.html` | Printable table QR codes (not indexed by search engines) |

`/book`, `/reservations` and `/contact` redirect to the right page.

Photos are web-sized copies made by `npm run images` from the originals in
the repository root. To swap a photo, replace the original and re-run it.

---

## How it fits together

```
Guest's phone                      Firebase project: tcm-orders
─────────────                      ────────────────────────────
thecaffeineministry.in  ─ reads ─▶ site/info, site/menu   (public, owner-only writes)
  /reserve              ─ calls ─▶ createReservation()    (validates + rate-limits)
                                        │
                                        ▼
BrewOps owner terminal  ◀─ live ── reservations/*        (owner-only)
```

- **No private data is public.** `site/info` and `site/menu` are the only
  documents a visitor can read. Recipes, costs, suppliers and bookings stay
  closed (`firestore.rules`, tested in `tools/test-rules.mjs`).
- **Guests cannot write to the database directly.** Bookings go through
  `createReservation` (`functions/website.js`), which checks them against your
  hours and booking rules (`functions/lib/reservation.js`), drops bot
  submissions, and limits each connection to 6 requests an hour and each phone
  number to 4 a day.
- **No Firebase SDK on the website.** It reads over Firestore's REST API, so
  pages stay light on mobile data.

---

## Going live: one-time setup

You need the Firebase CLI (`npm i -g firebase-tools`) and to be signed in as
the project owner (`firebase login`). Run these from the repository root.

### 1. Deploy the database rules and the booking function

```bash
npm run deploy:rules                       # firestore.rules
cd functions && npm run deploy:website     # createReservation only
```

Deploy the function by name like this. A bare `firebase deploy --only
functions` would delete `scanInvoice`, whose source isn't in this repository.

### 2. Create the website's Hosting site

Firebase console → **Hosting** → **Add another site** → site ID
`thecaffeineministry`.

If that ID is taken (site IDs are unique across all of Firebase), choose
another and put it in `.firebaserc` under `targets → tcm-orders → hosting →
website`.

### 3. Deploy the website

```bash
firebase deploy --only hosting:website
```

It is now live at `https://thecaffeineministry.web.app`. Check it there first.
After this, every push to `main` deploys it automatically
(`.github/workflows/deploy-hosting.yml`).

### 4. Point thecaffeineministry.in at it (GoDaddy)

1. Firebase console → Hosting → the **thecaffeineministry** site →
   **Add custom domain** → `thecaffeineministry.in`. Firebase shows you a
   **TXT** record and one or more **A** records.
2. In GoDaddy: **My Products → Domains → thecaffeineministry.in → DNS**.
   - Delete any existing **A** record for `@` (GoDaddy's "Parked" record) and
     turn off any domain **forwarding**.
   - Add the **TXT** record Firebase gave you (Name `@`).
   - Add each **A** record Firebase gave you (Name `@`).
3. Back in Firebase, press **Verify**. DNS can take a few minutes to a few
   hours to update. The SSL certificate is issued automatically after that,
   which can take up to 24 hours.
4. Add `www.thecaffeineministry.in` the same way and choose **Redirect to
   thecaffeineministry.in**. In GoDaddy, that's a **CNAME** (or A) record for
   `www` as Firebase instructs.

### 5. Fill in the details and print the QR codes

1. BrewOps → **Website & Bookings → Café details**: add phone, WhatsApp,
   Instagram and your real hours. **Save.**
2. **Menu** → build or import your menu, set prices → **Publish**.
3. **QR codes** → print one per table.
4. Make a test booking at `/reserve` and confirm it from **Reservations**.

> **If the website shows only defaults** after you've saved details: in
> Google Cloud console → APIs & Services → Credentials, check whether the
> *Browser key* has website restrictions. If it does, add
> `thecaffeineministry.in/*` and `www.thecaffeineministry.in/*`.

---

## Local preview

```bash
npx serve website        # http://localhost:3000, with clean URLs like /menu
```

Locally the pages read the live café details and menu (or fall back to the
sample). Bookings made locally are real bookings.

## Tests

```bash
npm run test:site        # booking validation (no emulator needed)
npm run test:rules       # includes the website and reservation rules (needs Java)
```
