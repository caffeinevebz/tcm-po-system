/* =============================================================================
 * Table booking — reserve.html
 * -----------------------------------------------------------------------------
 * Builds the date and time choices from the owner's settings (site/info) and
 * sends the request to the createReservation Cloud Function, which applies the
 * same rules again on the server (functions/lib/reservation.js). The booking
 * lands in the Website tab of BrewOps for the owner to confirm.
 * ========================================================================== */
(function () {
  'use strict';

  var form = document.getElementById('booking-form');
  var guestBox = document.getElementById('guest-chips');
  var dateIn = document.getElementById('date');
  var slotBox = document.getElementById('time-slots');
  var errorBox = document.getElementById('form-error');
  var submit = document.getElementById('submit-btn');
  var info = null;
  // Not form.name: that is the form's own name attribute, not the field.
  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function toMin(hhmm) { var p = hhmm.split(':').map(Number); return p[0] * 60 + p[1]; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function addDays(iso, n) {
    var d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function weekday(iso) { return new Date(iso + 'T00:00:00Z').getUTCDay(); }
  function prettyDate(iso) {
    return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC'
    });
  }

  // Same arithmetic as slotsFor() in functions/lib/reservation.js.
  function isClosed(iso) {
    return info.closedWeekdays.indexOf(weekday(iso)) !== -1 ||
           (info.reservations.closedDates || []).indexOf(iso) !== -1;
  }
  function slotsFor(iso) {
    var r = info.reservations;
    var now = TCMSite.nowInJodhpur();
    var first = toMin(info.open);
    var last = toMin(info.close) - r.lastSeatingMinutes;
    var earliest = iso === now.date ? now.minutes + r.leadMinutes : -1;
    var out = [];
    for (var m = Math.ceil(first / r.slotMinutes) * r.slotMinutes; m <= last; m += r.slotMinutes) {
      if (m >= earliest) out.push(pad(Math.floor(m / 60)) + ':' + pad(m % 60));
    }
    return out;
  }

  function chip(name, value, label, checked) {
    var l = el('label', 'chip-radio');
    var i = el('input');
    i.type = 'radio'; i.name = name; i.value = value; i.checked = !!checked;
    l.appendChild(i);
    l.appendChild(el('span', '', label));
    return l;
  }

  function renderGuests() {
    guestBox.innerHTML = '';
    var max = Math.min(info.reservations.maxGuests, 20);
    for (var n = 1; n <= max; n++) guestBox.appendChild(chip('guests', n, String(n), n === 2));
  }

  function renderSlots() {
    slotBox.innerHTML = '';
    var iso = dateIn.value;
    if (!iso) { slotBox.appendChild(el('p', 'muted small', 'Choose a date first.')); return; }
    if (isClosed(iso)) { slotBox.appendChild(el('p', 'muted small', 'We are closed on ' + prettyDate(iso) + '. Please pick another day.')); return; }
    var slots = slotsFor(iso);
    if (!slots.length) { slotBox.appendChild(el('p', 'muted small', 'No more tables can be booked for that day. Please pick another day.')); return; }
    slots.forEach(function (s) { slotBox.appendChild(chip('time', s, TCMSite.fmtTime(s))); });
  }

  function firstBookableDate() {
    var today = TCMSite.nowInJodhpur().date;
    for (var i = 0; i <= info.reservations.daysAhead; i++) {
      var d = addDays(today, i);
      if (!isClosed(d) && slotsFor(d).length) return d;
    }
    return today;
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = !msg;
    if (msg) errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function checked(name) {
    var c = form.querySelector('input[name="' + name + '"]:checked');
    return c ? c.value : '';
  }

  // Remember the guest's name and number on this device for next time.
  function remember(data) {
    try { localStorage.setItem('tcm:guest', JSON.stringify({ name: data.name, phone: data.phone, email: data.email })); } catch (e) { /* ignore */ }
  }
  function recall() {
    try {
      var g = JSON.parse(localStorage.getItem('tcm:guest') || 'null');
      if (g) {
        if (g.name) $('name').value = g.name;
        if (g.phone) $('phone').value = g.phone;
        if (g.email) $('email').value = g.email;
      }
    } catch (e) { /* ignore */ }
  }

  function icsFile(b) {
    var t = b.time.split(':').map(Number);
    var p = b.date.split('-').map(Number);
    // Jodhpur is UTC+05:30 all year.
    var start = new Date(Date.UTC(p[0], p[1] - 1, p[2], t[0], t[1]) - 330 * 60000);
    var end = new Date(start.getTime() + 90 * 60000);
    var stamp = function (d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); };
    var lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Caffeine Ministry//Booking//EN', 'BEGIN:VEVENT',
      'UID:' + b.ref + '@thecaffeineministry.in',
      'DTSTAMP:' + stamp(new Date()),
      'DTSTART:' + stamp(start), 'DTEND:' + stamp(end),
      'SUMMARY:Table at The Caffeine Ministry (' + b.guests + ')',
      'LOCATION:' + info.address.replace(/,/g, '\\,'),
      'DESCRIPTION:Booking reference ' + b.ref + ' (awaiting confirmation)',
      'END:VEVENT', 'END:VCALENDAR'
    ];
    return 'data:text/calendar;charset=utf-8,' + encodeURIComponent(lines.join('\r\n'));
  }

  function done(b) {
    form.hidden = true;
    var box = document.getElementById('booking-done');
    box.hidden = false;
    document.getElementById('done-ref').textContent = b.ref;
    var list = document.getElementById('done-summary');
    list.innerHTML = '';
    [['Name', b.name], ['Date', prettyDate(b.date)], ['Time', TCMSite.fmtTime(b.time)], ['Guests', String(b.guests)]]
      .forEach(function (row) {
        var li = el('li');
        li.appendChild(el('span', '', row[0]));
        li.appendChild(el('span', '', row[1]));
        list.appendChild(li);
      });
    document.getElementById('done-ics').href = icsFile(b);
    if (info.whatsapp) {
      var msg = 'Hello! I just requested a table on your website.\n' +
        'Ref: ' + b.ref + '\nName: ' + b.name + '\nDate: ' + prettyDate(b.date) +
        '\nTime: ' + TCMSite.fmtTime(b.time) + '\nGuests: ' + b.guests;
      var wa = document.getElementById('done-wa');
      wa.href = 'https://wa.me/' + TCMSite.waNumber(info.whatsapp) + '?text=' + encodeURIComponent(msg);
      wa.hidden = false;
    }
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    showError('');
    var data = {
      name: $('name').value.trim(),
      phone: $('phone').value.trim(),
      email: $('email').value.trim(),
      guests: Number(checked('guests')),
      date: dateIn.value,
      time: checked('time'),
      occasion: $('occasion').value,
      notes: $('notes').value.trim(),
      company: $('company').value
    };
    if (!data.guests) return showError('How many guests?');
    if (!data.date) return showError('Choose a date.');
    if (!data.time) return showError('Choose a time.');
    if (data.name.length < 2) { $('name').focus(); return showError('Tell us your name.'); }
    if (data.phone.replace(/\D/g, '').length < 10) { $('phone').focus(); return showError('Enter your mobile number so we can confirm.'); }

    submit.disabled = true;
    submit.textContent = 'Sending…';
    TCMSite.call('createReservation', data).then(function (res) {
      remember(data);
      done({ ref: res.ref, name: data.name, date: data.date, time: data.time, guests: data.guests });
    }).catch(function (err) {
      var fallback = info.whatsapp || info.phone
        ? ' If this keeps happening, please call or WhatsApp us.' : '';
      var msg = err && err.code && /^(INVALID_ARGUMENT|RESOURCE_EXHAUSTED)$/.test(err.code)
        ? err.message
        : 'We could not send your request just now.' + fallback;
      showError(msg);
    }).then(function () {
      submit.disabled = false;
      submit.textContent = 'Request this table';
    });
  });

  dateIn.addEventListener('change', renderSlots);

  TCMSite.loadInfo().then(function (i) {
    info = i;
    if (!info.reservations.enabled) return;
    var today = TCMSite.nowInJodhpur().date;
    dateIn.min = today;
    dateIn.max = addDays(today, info.reservations.daysAhead);
    var pre = new URLSearchParams(location.search).get('date');
    dateIn.value = pre && pre >= dateIn.min && pre <= dateIn.max ? pre : firstBookableDate();
    renderGuests();
    renderSlots();
    recall();
  });
})();
