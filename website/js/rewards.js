/* =============================================================================
 * Rewards card — rewards.html
 * Asks loyaltyCard for the stamp count on a phone number. Stamps are added by
 * staff in BrewOps when the guest pays; this page only shows them.
 * ========================================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function show(c) {
    var grid = $('card-grid');
    grid.innerHTML = '';
    var have = Math.min(c.stamps, c.target);
    for (var i = 0; i < c.target; i++) {
      var s = el('span', 'stamp' + (i < have ? ' on' : '') + (i === c.target - 1 ? ' reward' : ''));
      s.setAttribute('aria-hidden', 'true');
      if (i < have) {
        var img = el('img'); img.src = '/img/logo.png'; img.alt = ''; s.appendChild(img);
      } else if (i === c.target - 1) {
        s.textContent = '★';
      }
      grid.appendChild(s);
    }
    var rewards = Math.floor(c.stamps / c.target);
    $('card-name').textContent = c.name ? c.name + "'s card" : 'Your card';
    $('card-sub').textContent = c.stamps + ' of ' + c.target + ' stamps';
    grid.setAttribute('aria-label', c.stamps + ' of ' + c.target + ' stamps collected');
    grid.setAttribute('role', 'img');
    $('card-foot').textContent = !c.found
      ? "No stamps on this number yet. Give it to us when you pay and we'll start your card."
      : rewards > 0
        ? 'Your card is full! Ask for ' + c.reward + ' on your next visit.'
        : (c.target - c.stamps) + ' more to go until ' + c.reward + '.';
    $('card-result').hidden = false;
    $('card-result').classList.toggle('full', rewards > 0);
  }

  try {
    var g = JSON.parse(localStorage.getItem('tcm:guest') || 'null');
    if (g && g.phone) $('card-phone').value = g.phone;
  } catch (e) { /* ignore */ }

  $('card-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('card-error');
    err.hidden = true;
    var phone = $('card-phone').value.trim();
    if (phone.replace(/\D/g, '').length < 10) { err.textContent = 'Enter your 10-digit mobile number.'; err.hidden = false; return; }
    var btn = $('card-go');
    btn.disabled = true;
    TCMSite.call('loyaltyCard', { phone: phone }).then(function (c) {
      show(c);
      try {
        var g2 = JSON.parse(localStorage.getItem('tcm:guest') || 'null') || {};
        g2.phone = phone;
        localStorage.setItem('tcm:guest', JSON.stringify(g2));
      } catch (e2) { /* ignore */ }
    }).catch(function (e3) {
      err.textContent = e3 && /^(INVALID_ARGUMENT|RESOURCE_EXHAUSTED|FAILED_PRECONDITION)$/.test(e3.code)
        ? e3.message : 'We could not look that up just now. Please try again in a moment.';
      err.hidden = false;
    }).then(function () { btn.disabled = false; });
  });
})();
