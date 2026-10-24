/* =============================================================================
 * Printable table QR codes — qr.html
 * Each code opens https://thecaffeineministry.in/menu?table=N. Drawn locally
 * with qrcode-generator (MIT, vendored in js/vendor), so nothing is sent anywhere.
 * ========================================================================== */
(function () {
  'use strict';

  var BASE = 'https://thecaffeineministry.in/menu';
  var grid = document.getElementById('qr-grid');
  var form = document.getElementById('qr-form');

  function svgFor(url) {
    var qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }

  function card(label, url) {
    var c = document.createElement('div');
    c.className = 'qr-card';
    var badge = document.createElement('img');
    badge.className = 'badge'; badge.src = '/img/logo.png'; badge.alt = '';
    var h = document.createElement('h3'); h.textContent = 'Scan for our menu';
    var box = document.createElement('div'); box.className = 'qr';
    box.innerHTML = svgFor(url);   // markup generated locally from a fixed URL
    var t = document.createElement('p'); t.className = 'tno'; t.textContent = label;
    var u = document.createElement('p'); u.textContent = 'thecaffeineministry.in/menu';
    c.appendChild(badge); c.appendChild(h); c.appendChild(box); c.appendChild(t); c.appendChild(u);
    return c;
  }

  function build() {
    var from = Math.max(1, Math.min(200, Number(document.getElementById('qr-from').value) || 1));
    var to = Math.max(from, Math.min(200, Number(document.getElementById('qr-to').value) || from));
    grid.innerHTML = '';
    if (document.getElementById('qr-plain').checked) grid.appendChild(card('Welcome', BASE));
    for (var n = from; n <= to; n++) grid.appendChild(card('Table ' + n, BASE + '?table=' + n));
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); build(); });
  document.getElementById('qr-print').addEventListener('click', function () { window.print(); });
  build();
})();
