/* =============================================================================
 * The Caffeine Ministry — shared site runtime
 * -----------------------------------------------------------------------------
 * Every page loads this. It
 *   - fetches the café's details (site/info) and fills in [data-info] slots,
 *   - works out whether the café is open right now, in Jodhpur time,
 *   - runs the mobile menu, the header-over-hero effect and scroll reveals,
 *   - exposes TCMSite.call() for the booking form.
 *
 * No Firebase SDK: the two public documents are read over Firestore's REST API
 * and the booking function is called over its HTTPS protocol, which keeps the
 * pages light on a phone signal. The owner edits everything here from the
 * Website tab of BrewOps (owner.html); the defaults below show until they do.
 * ========================================================================== */
(function () {
  'use strict';

  document.documentElement.classList.remove('no-js');

  var PROJECT = 'tcm-orders';
  // A Firebase web API key is a public project identifier, not a secret.
  var API_KEY = 'AIzaSyAcE76Pc46oOJ3FMqb4kcojbvq5ACPuwaE';
  var REGION = 'us-central1';
  var TZ = 'Asia/Kolkata';

  // Mirrors DEFAULT_SITE in functions/lib/reservation.js for the booking rules.
  var SITE_DEFAULTS = {
    name: 'The Caffeine Ministry',
    tagline: 'Specialty coffee & all-day plates in Sardarpura, Jodhpur',
    address: "'Parasudai', 672, 12th C Road, Sardarpura, Jodhpur, Rajasthan 342003",
    mapsQuery: 'The Caffeine Ministry, Sardarpura, Jodhpur',
    phone: '',
    whatsapp: '',
    email: '',
    instagram: '',
    open: '09:00',
    close: '23:00',
    closedWeekdays: [],
    hoursNote: '',
    announcement: '',
    reservations: {
      enabled: true, maxGuests: 12, slotMinutes: 30, lastSeatingMinutes: 60,
      daysAhead: 30, leadMinutes: 30, closedDates: []
    }
  };

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // ---------------------------------------------------------------------------
  // Firestore REST
  // ---------------------------------------------------------------------------
  function decode(v) {
    if (!v || typeof v !== 'object') return null;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('booleanValue' in v) return v.booleanValue;
    if ('nullValue' in v) return null;
    if ('timestampValue' in v) return v.timestampValue;
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
    if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
    return null;
  }
  function decodeFields(fields) {
    var out = {};
    Object.keys(fields).forEach(function (k) { out[k] = decode(fields[k]); });
    return out;
  }

  var CACHE_MS = 5 * 60 * 1000;
  function cacheGet(key) {
    try {
      var raw = sessionStorage.getItem('tcm:' + key);
      if (!raw) return undefined;
      var hit = JSON.parse(raw);
      return Date.now() - hit.t < CACHE_MS ? hit.v : undefined;
    } catch (e) { return undefined; }
  }
  function cacheSet(key, value) {
    try { sessionStorage.setItem('tcm:' + key, JSON.stringify({ t: Date.now(), v: value })); } catch (e) { /* private mode */ }
  }

  /** Read site/{id}. Resolves to the document, or null if it does not exist yet. */
  function getSiteDoc(id, fresh) {
    var cached = fresh ? undefined : cacheGet(id);
    if (cached !== undefined) return Promise.resolve(cached);
    var url = 'https://firestore.googleapis.com/v1/projects/' + PROJECT +
              '/databases/(default)/documents/site/' + id + '?key=' + API_KEY;
    return fetch(url, { cache: 'no-store' }).then(function (res) {
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json().then(function (j) { return decodeFields(j.fields || {}); });
    }).then(function (doc) { cacheSet(id, doc); return doc; });
  }

  /** Call an HTTPS callable Cloud Function without the Firebase SDK. */
  function call(name, data) {
    var url = 'https://' + REGION + '-' + PROJECT + '.cloudfunctions.net/' + name;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: data })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (res.ok && body && 'result' in body) return body.result;
        var err = new Error((body && body.error && body.error.message) || 'Something went wrong. Please try again.');
        err.code = (body && body.error && body.error.status) || ('HTTP_' + res.status);
        throw err;
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Café details
  // ---------------------------------------------------------------------------
  function merge(info) {
    var i = info || {};
    var out = {};
    Object.keys(SITE_DEFAULTS).forEach(function (k) {
      var v = i[k];
      out[k] = (v === undefined || v === null || (typeof v === 'string' && !v.trim() && typeof SITE_DEFAULTS[k] === 'string' && SITE_DEFAULTS[k]))
        ? SITE_DEFAULTS[k] : v;
    });
    out.reservations = Object.assign({}, SITE_DEFAULTS.reservations, i.reservations || {});
    out.closedWeekdays = Array.isArray(out.closedWeekdays) ? out.closedWeekdays.map(Number) : [];
    return out;
  }

  var infoPromise = null;
  function loadInfo() {
    if (!infoPromise) {
      infoPromise = getSiteDoc('info')
        .then(merge)
        .catch(function () { return merge(null); });
    }
    return infoPromise;
  }

  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function waNumber(s) {
    var d = digits(s);
    return d.length === 10 ? '91' + d : d;
  }
  function prettyPhone(s) {
    var d = digits(s);
    if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2);
    return d.length === 10 ? '+91 ' + d.slice(0, 5) + ' ' + d.slice(5) : s;
  }
  function instaHandle(s) {
    return String(s || '').trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/\/.*$/, '');
  }

  function fmtTime(hhmm) {
    var p = String(hhmm).split(':').map(Number);
    var h = p[0], m = p[1];
    var ap = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + (m ? ':' + String(m).padStart(2, '0') : '') + ' ' + ap;
  }

  function nowInJodhpur() {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23'
    }).formatToParts(new Date());
    var get = function (t) { return (parts.find(function (p) { return p.type === t; }) || {}).value; };
    var date = get('year') + '-' + get('month') + '-' + get('day');
    return {
      date: date,
      minutes: Number(get('hour')) * 60 + Number(get('minute')),
      weekday: new Date(date + 'T00:00:00Z').getUTCDay()
    };
  }

  function toMin(hhmm) { var p = hhmm.split(':').map(Number); return p[0] * 60 + p[1]; }

  function openState(info) {
    var now = nowInJodhpur();
    var closedToday = info.closedWeekdays.indexOf(now.weekday) !== -1 ||
                      (info.reservations.closedDates || []).indexOf(now.date) !== -1;
    var o = toMin(info.open), c = toMin(info.close);
    if (!closedToday && now.minutes >= o && now.minutes < c) {
      return { open: true, text: 'Open now · until ' + fmtTime(info.close) };
    }
    if (!closedToday && now.minutes < o) return { open: false, text: 'Opens today at ' + fmtTime(info.open) };
    return { open: false, text: 'Closed now · opens ' + fmtTime(info.open) };
  }

  function hoursSummary(info) {
    var closed = info.closedWeekdays.slice().sort();
    var range = fmtTime(info.open) + ' – ' + fmtTime(info.close);
    if (!closed.length) return 'Open daily, ' + range;
    return range + ' · closed ' + closed.map(function (d) { return DAYS[d]; }).join(' & ');
  }

  function renderHours(table, info) {
    var today = nowInJodhpur().weekday;
    var order = [1, 2, 3, 4, 5, 6, 0];
    table.innerHTML = '';
    order.forEach(function (d) {
      var tr = document.createElement('tr');
      var closed = info.closedWeekdays.indexOf(d) !== -1;
      if (d === today) tr.className = 'today';
      if (closed) tr.className += ' closed';
      var a = document.createElement('td'); a.textContent = DAYS[d];
      var b = document.createElement('td'); b.textContent = closed ? 'Closed' : fmtTime(info.open) + ' – ' + fmtTime(info.close);
      tr.appendChild(a); tr.appendChild(b); table.appendChild(tr);
    });
  }

  function mapsLink(info) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(info.mapsQuery || info.address);
  }

  /** Fill every [data-info] slot and show/hide [data-needs] blocks. */
  function hydrate(info) {
    var values = {
      name: info.name,
      tagline: info.tagline,
      address: info.address,
      phone: info.phone ? prettyPhone(info.phone) : '',
      whatsapp: info.whatsapp ? prettyPhone(info.whatsapp) : '',
      email: info.email,
      instagram: info.instagram ? '@' + instaHandle(info.instagram) : '',
      hours: hoursSummary(info),
      hoursNote: info.hoursNote,
      announcement: info.announcement,
      open: fmtTime(info.open),
      close: fmtTime(info.close),
      maxGuests: String(info.reservations.maxGuests)
    };
    var hrefs = {
      phone: info.phone ? 'tel:+' + waNumber(info.phone) : '',
      whatsapp: info.whatsapp ? 'https://wa.me/' + waNumber(info.whatsapp) : '',
      email: info.email ? 'mailto:' + info.email : '',
      instagram: info.instagram ? 'https://instagram.com/' + instaHandle(info.instagram) : '',
      maps: mapsLink(info)
    };

    document.querySelectorAll('[data-info]').forEach(function (el) {
      var v = values[el.getAttribute('data-info')];
      if (v !== undefined && v !== null && v !== '') el.textContent = v;
    });
    document.querySelectorAll('[data-href]').forEach(function (el) {
      var h = hrefs[el.getAttribute('data-href')];
      if (h) el.setAttribute('href', h);
    });
    document.querySelectorAll('[data-needs]').forEach(function (el) {
      var keys = el.getAttribute('data-needs').split(/\s+/);
      var any = keys.some(function (k) { return k === 'reservations' ? info.reservations.enabled : !!info[k]; });
      el.hidden = !any;
    });
    document.querySelectorAll('[data-needs-not]').forEach(function (el) {
      var k = el.getAttribute('data-needs-not');
      el.hidden = k === 'reservations' ? info.reservations.enabled : !!info[k];
    });
    document.querySelectorAll('[data-open-state]').forEach(function (el) {
      var s = openState(info);
      el.textContent = s.text;
      var dot = el.parentNode && el.parentNode.querySelector('.open-dot');
      if (dot) dot.classList.toggle('closed', !s.open);
    });
    document.querySelectorAll('table[data-hours]').forEach(function (t) { renderHours(t, info); });

    var bar = document.getElementById('announce');
    if (bar) { bar.hidden = !info.announcement; if (info.announcement) bar.textContent = info.announcement; }
  }

  // ---------------------------------------------------------------------------
  // Page chrome
  // ---------------------------------------------------------------------------
  function chrome() {
    var toggle = document.querySelector('.menu-toggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var open = document.body.classList.toggle('nav-open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      document.querySelectorAll('.nav a').forEach(function (a) {
        a.addEventListener('click', function () {
          document.body.classList.remove('nav-open');
          toggle.setAttribute('aria-expanded', 'false');
        });
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && document.body.classList.contains('nav-open')) {
          document.body.classList.remove('nav-open');
          toggle.setAttribute('aria-expanded', 'false');
          toggle.focus();
        }
      });
    }

    if (document.body.classList.contains('has-hero')) {
      var onScroll = function () { document.body.classList.toggle('scrolled', window.scrollY > 40); };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }

    var reveals = document.querySelectorAll('.reveal');
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
      reveals.forEach(function (el) { io.observe(el); });
    } else {
      reveals.forEach(function (el) { el.classList.add('in'); });
    }

    document.querySelectorAll('[data-year]').forEach(function (el) { el.textContent = new Date().getFullYear(); });
  }

  // ---------------------------------------------------------------------------
  // Signature items on the home page, from the published menu
  // ---------------------------------------------------------------------------
  var menuPromise = null;
  function loadMenu() {
    if (!menuPromise) {
      menuPromise = getSiteDoc('menu')
        .catch(function () { return null; })
        .then(function (doc) {
          if (doc && Array.isArray(doc.categories) && doc.categories.length) return doc;
          return fetch('/data/menu.json').then(function (r) { return r.json(); });
        });
    }
    return menuPromise;
  }

  function money(n, currency) {
    if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '';
    return (currency || '₹') + Number(n).toLocaleString('en-IN');
  }

  function renderSignatures(host) {
    loadMenu().then(function (menu) {
      var picks = [];
      (menu.categories || []).forEach(function (c) {
        (c.items || []).forEach(function (it) {
          if (it.available !== false && (it.tags || []).indexOf('Signature') !== -1) picks.push(it);
        });
      });
      picks = picks.slice(0, 6);
      if (!picks.length) { host.closest('section').hidden = true; return; }
      host.innerHTML = '';
      picks.forEach(function (it) {
        var row = document.createElement('div');
        row.className = 'feature-item';
        var left = document.createElement('div');
        var h = document.createElement('h3'); h.textContent = it.name; left.appendChild(h);
        if (it.desc) { var p = document.createElement('p'); p.textContent = it.desc; left.appendChild(p); }
        var price = document.createElement('span'); price.className = 'price'; price.textContent = money(it.price, menu.currency);
        row.appendChild(left); row.appendChild(price);
        host.appendChild(row);
      });
    });
  }

  // ---------------------------------------------------------------------------
  window.TCMSite = {
    DEFAULTS: SITE_DEFAULTS,
    loadInfo: loadInfo,
    loadMenu: loadMenu,
    getSiteDoc: getSiteDoc,
    call: call,
    fmtTime: fmtTime,
    nowInJodhpur: nowInJodhpur,
    waNumber: waNumber,
    prettyPhone: prettyPhone,
    money: money,
    DAYS: DAYS
  };

  function start() {
    chrome();
    loadInfo().then(hydrate);
    var sig = document.querySelector('[data-signatures]');
    if (sig) renderSignatures(sig);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
