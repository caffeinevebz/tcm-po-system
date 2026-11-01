/* =============================================================================
 * The table QR codes — thecaffeineministry.in/m/T4?k=… — open the café POS's
 * guest menu: signing up for loyalty beans, ordering to the table. The POS
 * (caffeinevebz/tcm-pos) prints the codes from Owner Dashboard → Menu QR;
 * each carries its table and that table's key, kept as they are here.
 * ========================================================================== */
(function () {
  'use strict';
  var MENU = 'https://tcm-pos-menu.web.app';
  var to = MENU + location.pathname + location.search + location.hash;
  location.replace(to);
  document.addEventListener('DOMContentLoaded', function () {
    var a = document.getElementById('menu-link');
    if (a) a.href = to;
  });
})();
