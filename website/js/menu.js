/* =============================================================================
 * QR menu — menu.html
 * -----------------------------------------------------------------------------
 * Table QR codes point at /menu?table=7. The menu itself is site/menu, which
 * the owner publishes from the Website tab of BrewOps; until then the sample in
 * /data/menu.json is shown with a "preview" note.
 * ========================================================================== */
(function () {
  'use strict';

  var root = document.getElementById('menu-root');
  var tabs = document.getElementById('cat-tabs');
  var search = document.getElementById('menu-search');
  var vegBtn = document.getElementById('veg-toggle');
  var menu = null;
  var vegOnly = false;

  // Table number from the QR code.
  var params = new URLSearchParams(location.search);
  var table = String(params.get('table') || params.get('t') || '').replace(/[^0-9A-Za-z-]/g, '').slice(0, 6);
  if (table) {
    var chip = document.getElementById('table-chip');
    chip.textContent = 'Table ' + table;
    chip.hidden = false;
    document.title = 'Menu · Table ' + table + ' · The Caffeine Ministry';
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function slug(s, i) {
    return 'cat-' + (String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || i);
  }

  function matches(item, q) {
    if (vegOnly && item.veg !== true) return false;
    if (!q) return true;
    return (item.name + ' ' + (item.desc || '') + ' ' + (item.tags || []).join(' ')).toLowerCase().indexOf(q) !== -1;
  }

  function render() {
    var q = search.value.trim().toLowerCase();
    root.innerHTML = '';
    tabs.innerHTML = '';
    var shown = 0;

    (menu.categories || []).forEach(function (cat, ci) {
      if (cat.hidden) return;
      var items = (cat.items || []).filter(function (it) { return !it.hidden && it.name && matches(it, q); });
      if (!items.length) return;
      var id = slug(cat.id || cat.name, ci);

      var tab = el('a', '', cat.name);
      tab.href = '#' + id;
      tab.dataset.target = id;
      tabs.appendChild(tab);

      var sec = el('section', 'menu-section');
      sec.id = id;
      sec.appendChild(el('h2', '', cat.name));
      if (cat.note) sec.appendChild(el('p', 'cat-note', cat.note));

      items.forEach(function (it) {
        var row = el('article', 'menu-item' + (it.available === false ? ' sold-out' : ''));
        var diet = el('i', 'diet ' + (it.veg === true ? 'veg' : it.veg === false ? 'nonveg' : 'none'));
        diet.setAttribute('role', 'img');
        diet.setAttribute('aria-label', it.veg === true ? 'Vegetarian' : it.veg === false ? 'Non-vegetarian' : '');
        if (it.veg !== true && it.veg !== false) diet.setAttribute('aria-hidden', 'true');
        row.appendChild(diet);
        row.appendChild(el('h3', '', it.name));
        row.appendChild(el('span', 'price', TCMSite.money(it.price, menu.currency)));
        if (it.desc) row.appendChild(el('p', 'desc', it.desc));

        var tags = (it.tags || []).filter(Boolean);
        if (tags.length || it.available === false) {
          var t = el('div', 'tags');
          tags.forEach(function (tag) {
            var k = tag.toLowerCase() === 'signature' ? ' tag-signature' : tag.toLowerCase() === 'new' ? ' tag-new' : '';
            t.appendChild(el('span', 'tag' + k, tag));
          });
          if (it.available === false) t.appendChild(el('span', 'sold-label', 'Sold out today'));
          row.appendChild(t);
        }
        sec.appendChild(row);
        shown++;
      });
      root.appendChild(sec);
    });

    if (!shown) {
      root.appendChild(el('p', 'menu-empty', q || vegOnly ? 'Nothing matches that. Try another word.' : 'The menu is being updated. Please ask your server.'));
    }
    spy();
  }

  // Highlight the tab for the section in view, and keep it scrolled into sight.
  var observer = null;
  function spy() {
    if (observer) observer.disconnect();
    if (!('IntersectionObserver' in window)) return;
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        tabs.querySelectorAll('a').forEach(function (a) {
          var on = a.dataset.target === e.target.id;
          a.classList.toggle('active', on);
          if (on) tabs.scrollTo({ left: a.offsetLeft - 16, behavior: 'smooth' });
        });
      });
    }, { rootMargin: '-140px 0px -65% 0px' });
    root.querySelectorAll('.menu-section').forEach(function (s) { observer.observe(s); });
  }

  search.addEventListener('input', render);
  vegBtn.addEventListener('click', function () {
    vegOnly = !vegOnly;
    vegBtn.setAttribute('aria-pressed', vegOnly ? 'true' : 'false');
    render();
  });

  TCMSite.loadMenu().then(function (m) {
    menu = m || { categories: [] };
    document.getElementById('menu-footnote').textContent = menu.footnote || 'Prices are in Indian rupees.';
    document.getElementById('menu-sample').hidden = !menu.sample;
    render();
  }).catch(function () {
    root.innerHTML = '';
    root.appendChild(el('p', 'menu-empty', 'We could not load the menu. Please check your connection, or ask your server.'));
  });
})();
