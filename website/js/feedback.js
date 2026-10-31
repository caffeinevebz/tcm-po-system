/* =============================================================================
 * Feedback — feedback.html
 * Sent to submitFeedback, which stores it for the owner. Four or five stars,
 * and the owner has set a Google review link? Then we offer it.
 * ========================================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var form = $('fb-form');
  var CAPTIONS = ['', 'Not good', 'Could be better', 'It was fine', 'Really good', 'Loved it!'];
  var visit = String(new URLSearchParams(location.search).get('visit') || '').slice(0, 20);

  function rating() {
    var c = form.querySelector('input[name="rating"]:checked');
    return c ? Number(c.value) : 0;
  }

  form.querySelectorAll('input[name="rating"]').forEach(function (r) {
    r.addEventListener('change', function () {
      $('star-caption').textContent = CAPTIONS[rating()];
      $('stars').classList.add('rated');
      form.querySelectorAll('.star').forEach(function (s, i) { s.classList.toggle('on', i < rating()); });
    });
  });

  try {
    var g = JSON.parse(localStorage.getItem('tcm:guest') || 'null');
    if (g && g.name) $('fb-name').value = g.name;
  } catch (e) { /* ignore */ }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('fb-error');
    err.hidden = true;
    if (!rating()) { err.textContent = 'Tap a star to rate your visit.'; err.hidden = false; return; }
    var btn = $('fb-send');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    TCMSite.call('submitFeedback', {
      rating: rating(),
      tags: Array.prototype.map.call(form.querySelectorAll('input[name="tags"]:checked'), function (c) { return c.value; }),
      comment: $('fb-comment').value.trim(),
      name: $('fb-name').value.trim(),
      phone: $('fb-phone').value.trim(),
      visit: visit,
      company: $('fb-company').value
    }).then(function (res) {
      form.hidden = true;
      $('fb-done').hidden = false;
      if (rating() <= 3) {
        $('fb-done-title').textContent = 'Thank you for telling us';
        $('fb-done-text').textContent = $('fb-phone').value.trim()
          ? "We're sorry it wasn't perfect. The owner will read this and get back to you."
          : "We're sorry it wasn't perfect. The owner reads every message and we'll put it right.";
      }
      if (res && res.review) {
        $('fb-review-link').href = res.review;
        $('fb-review').hidden = false;
      }
    }).catch(function (e2) {
      err.textContent = e2 && /^(INVALID_ARGUMENT|RESOURCE_EXHAUSTED)$/.test(e2.code)
        ? e2.message : 'We could not send that just now. Please try again in a moment.';
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Send feedback';
    });
  });
})();
