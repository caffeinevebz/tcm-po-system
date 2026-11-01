/* =============================================================================
 * Loyalty beans — rewards.html
 * The café's loyalty is the POS's: beans (points) earned on every bill, and
 * welcome beans for signing up on the table QR menu (/m, which opens the POS's
 * guest menu, where members see their beans). This only fills in how many
 * welcome beans, from the POS's public settings (settings/public).
 * ========================================================================== */
(function () {
  'use strict';

  var POS = 'https://firestore.googleapis.com/v1/projects/tcm-pos/databases/tcmpos/documents/settings/public' +
    '?key=AIzaSyA7zbfx4uJFQ-Az0u0vrbQAuSBPxNvDJCI';

  fetch(POS, { cache: 'no-store' })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (doc) {
      var loyalty = doc && doc.fields && doc.fields.loyalty && doc.fields.loyalty.mapValue.fields;
      var beans = loyalty && loyalty.welcomeBeans && Number(loyalty.welcomeBeans.integerValue || loyalty.welcomeBeans.doubleValue);
      if (!isFinite(beans) || beans <= 0) return;
      document.querySelectorAll('[data-pos-welcome]').forEach(function (el) { el.textContent = String(beans); });
    })
    .catch(function () { /* keep the default */ });
})();
