/* =============================================================================
 * Events enquiry — events.html
 * Composes the enquiry and opens it in WhatsApp (or email) on the guest's own
 * phone, so nothing is stored and the conversation continues where the café
 * already answers messages.
 * ========================================================================== */
(function () {
  'use strict';

  var form = document.getElementById('event-form');
  var error = document.getElementById('ev-error');
  var info = null;
  function $(id) { return document.getElementById(id); }

  TCMSite.loadInfo().then(function (i) {
    info = i;
    if (!info.whatsapp && !info.email && !info.phone) {
      $('ev-how').textContent = 'Our contact details are being updated. Please visit or call the café.';
    } else if (!info.whatsapp && info.email) {
      $('ev-how').textContent = 'Your enquiry opens in your email app so you can check it before sending.';
    }
    var today = TCMSite.nowInJodhpur().date;
    $('ev-date').min = today;
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    error.hidden = true;
    var name = $('ev-name').value.trim();
    var phone = $('ev-phone').value.trim();
    if (name.length < 2 || phone.replace(/\D/g, '').length < 10) {
      error.textContent = 'Please add your name and mobile number so we can reply.';
      error.hidden = false;
      return;
    }
    var date = $('ev-date').value;
    var lines = [
      'Hello! I\'d like to plan an event at The Caffeine Ministry.',
      'Occasion: ' + $('ev-type').value,
      'Guests: ' + ($('ev-guests').value || 'not sure yet'),
      'Date: ' + (date ? new Date(date + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'flexible'),
      $('ev-notes').value.trim() ? 'Details: ' + $('ev-notes').value.trim() : '',
      'Name: ' + name,
      'Phone: ' + phone
    ].filter(Boolean).join('\n');

    if (info && info.whatsapp) {
      window.open('https://wa.me/' + TCMSite.waNumber(info.whatsapp) + '?text=' + encodeURIComponent(lines), '_blank', 'noopener');
    } else if (info && info.email) {
      location.href = 'mailto:' + info.email + '?subject=' + encodeURIComponent('Event enquiry — ' + $('ev-type').value) +
        '&body=' + encodeURIComponent(lines);
    } else if (info && info.phone) {
      location.href = 'tel:+' + TCMSite.waNumber(info.phone);
    } else {
      error.textContent = 'Our contact details are being updated. Please visit or call the café.';
      error.hidden = false;
    }
  });
})();
