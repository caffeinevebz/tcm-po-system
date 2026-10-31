# thecaffeineministry.in — the public website

The café's public face, and the guest experience around a visit:

- **Order from the table.** Scan the table QR code, add items, send. The
  order appears in BrewOps with the table number; the guest follows it live.
- **Order ahead.** Takeaway for a chosen pickup time today; pay on collection.
- **Book a table**, with WhatsApp confirmation.
- **Rewards card.** One stamp per visit, a reward when the card is full.
  Guests check their stamps online with their phone number.
- **Feedback.** "How was your visit?" Happy guests are invited to leave a
  Google review; anything less reaches the owner privately first.
- Home, menu, our story, events & private hire, visit/contact, privacy.

Plain HTML, CSS and a little JavaScript, with no build step.

Everything that changes day to day is run from the **guest desk** in BrewOps:
**Website & Guests** in the owner terminal, and **Guest Desk** in the staff
terminal for anyone given the *Guest orders, bookings & loyalty stamps*
permission (in Users & Access).

| Tab | Who | What it does |
|---|---|---|
| **Orders** | owner + staff | Today's table and takeaway orders, live, with a chime (press *Sound on* once). Start → Ready → Served/Collected; *Ready + WhatsApp* tells a takeaway guest their order is waiting. *+1 loyalty stamp* if they gave a number. |
| **Bookings** | owner + staff | Reservation requests. Confirm with a WhatsApp message, decline, seat, assign a table, mark no-show. |
| **Stamps** | owner + staff | Look up a guest by phone number, add a stamp, redeem a reward, undo a mistake. |
| **Feedback** | owner | Ratings and comments, average score, low ratings to follow up, private notes, reply on WhatsApp. |
| **Menu** | owner | Edit sections, items, prices, veg marks, *Signature*/*New* tags and *Sold out*, then **Publish**. *Import from recipe book* copies dish names in (names only, never costs). |
| **Café details** | owner | Phone, WhatsApp, email, Instagram, address, hours, closed days, announcement bar, booking rules, table ordering and takeaway on/off, takeaway prep time, rewards (stamps needed and the reward), and the Google review link. |
| **QR codes** | owner | A printable sheet with one QR code per table (`/menu?table=7`). |

Until you publish a menu, the website shows the **sample menu** in
`data/menu.json` with a "preview" note, and **ordering stays off** (the server
refuses orders against a menu that hasn't been published). Until you fill in
café details, phone/WhatsApp/email/Instagram links stay hidden and the hours
default to 9 AM–11 PM daily.

---

## Pages

| Path | File | |
|---|---|---|
| `/` | `index.html` | Home |
| `/menu` | `menu.html` | Menu: search, veg filter. With `?table=7` (the table QR code) guests can order |
| `/takeaway` | `takeaway.html` | Order ahead for pickup today |
| `/order` | `order.html` | The guest's own order, live (linked with a private key; not indexed) |
| `/reserve` | `reserve.html` | Booking form → `createReservation` Cloud Function |
| `/rewards` | `rewards.html` | How the rewards card works; check your stamps |
| `/feedback` | `feedback.html` | "How was your visit?" |
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
Guest's phone                         Firebase project: tcm-orders
─────────────                         ────────────────────────────
thecaffeineministry.in   ─ reads ─▶  site/info, site/menu          (public; owner writes)
  /reserve               ─ calls ─▶  createReservation  → reservations/
  /menu?table=, /takeaway ─ calls ─▶ placeOrder         → orders/
  /order                 ─ calls ─▶  trackOrder         (needs the order's private key)
  /feedback              ─ calls ─▶  submitFeedback     → feedback/
  /rewards               ─ calls ─▶  loyaltyCard        (reads loyalty/, count only)

BrewOps guest desk       ◀─ live ──  orders, reservations, loyalty  (`guests` permission)
                                     feedback                       (owner only)
```

- **No private data is public.** `site/info` and `site/menu` are the only
  documents a visitor can read. Orders, bookings, stamp cards, feedback,
  recipes, costs and suppliers stay closed (`firestore.rules`, tested in
  `tools/test-rules.mjs`).
- **Guests never write to the database directly.** Everything goes through
  the functions in `functions/website.js`, which validate against your settings
  (`functions/lib/reservation.js`, `functions/lib/guest.js`), drop bot
  submissions and rate-limit each connection (and each phone number).
- **Prices come from the published menu, never from the guest's phone.** An
  order carries item ids and quantities only; a tampered request cannot change
  what anything costs. Staff can move an order along but nobody can edit its
  lines or total.
- **Stamps are given by staff, not claimed by guests.** The rewards page only
  shows a count and a first name for a number.
- **Payment stays at the counter** (cash, card, UPI). Nothing on the site
  takes money.
- **No Firebase SDK on the website.** It reads over Firestore's REST API, so
  pages stay light on mobile data.

---

## Going live: one-time setup

You need the Firebase CLI (`npm i -g firebase-tools`) and to be signed in as
the project owner (`firebase login`). Run these from the repository root.

### 1. Deploy the database rules and the website functions

```bash
npm run deploy:rules                       # firestore.rules
cd functions && npm run deploy:website     # the five website functions
cd functions && npm run deploy:auth        # account functions (new `guests` permission)
```

`deploy:website` deploys `createReservation`, `placeOrder`, `trackOrder`,
`submitFeedback` and `loyaltyCard` by name. A bare `firebase deploy --only
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

### 5. Fill in the details, give staff access, print the QR codes

1. BrewOps → **Website & Guests → Café details**: phone, WhatsApp, Instagram,
   real hours, your **Google review link**, and check the ordering and
   rewards settings. **Save.**
2. **Menu** → build or import your menu, set prices → **Publish**. Ordering
   switches on once a menu is published.
3. **Users & Access** → tick *Guest orders, bookings & loyalty stamps* for
   everyone who works the floor. They'll find **Guest Desk** in the staff
   terminal.
4. **QR codes** → print one per table.
5. Test it: scan a table code and order, place a takeaway order, make a
   booking, leave feedback. Work each one from the guest desk on the
   counter's tablet with **Sound on**.

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
npm run test:site        # booking, ordering, feedback and loyalty rules (no emulator needed)
npm run test:rules       # includes the website, orders, feedback and loyalty rules (needs Java)
```
