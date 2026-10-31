/* =============================================================================
 * Menu & ordering — menu.html and takeaway.html
 * -----------------------------------------------------------------------------
 * Three modes, decided by the page:
 *   view      /menu                 read the menu
 *   table     /menu?table=7         the table QR code: order to the table
 *   takeaway  /takeaway             order ahead for pickup today
 *
 * The menu is site/menu, published from BrewOps (until then the sample in
 * /data/menu.json, which can be read but not ordered from). An order sends
 * only item ids and quantities; the placeOrder function prices it from the
 * published menu and the order appears live in BrewOps.
 * ========================================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var root = $('menu-root');
  var tabs = $('cat-tabs');
  var search = $('menu-search');
  var vegBtn = $('veg-toggle');

  var params = new URLSearchParams(location.search);
  var table = String(params.get('table') || params.get('t') || '').replace(/[^0-9A-Za-z-]/g, '').slice(0, 6);
  var mode = document.body.getAttribute('data-mode') === 'takeaway' ? 'takeaway' : table ? 'table' : 'view';

  var menu = null;
  var info = null;
  var index = {};          // item id -> item
  var vegOnly = false;
  var canOrder = false;
  var cart = {};           // id -> { qty, note }
  var CART_KEY = 'tcm:cart:' + mode + ':' + table;

  if (table) {
    var chip = $('table-chip');
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
  function money(n) { return TCMSite.money(n, menu && menu.currency); }
  function orderable(it) { return it && it.available !== false && typeof it.price === 'number' && isFinite(it.price); }
  function toMin(hhmm) { var p = hhmm.split(':').map(Number); return p[0] * 60 + p[1]; }
  function pad(n) { return String(n).padStart(2, '0'); }

  // ---------------------------------------------------------------------------
  // Cart
  // ---------------------------------------------------------------------------
  function loadCart() {
    try { cart = JSON.parse(localStorage.getItem(CART_KEY) || '{}') || {}; } catch (e) { cart = {}; }
    Object.keys(cart).forEach(function (id) {
      if (!orderable(index[id]) || !(cart[id].qty > 0)) delete cart[id];
    });
  }
  function saveCart() {
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) { /* private mode */ }
  }
  function setQty(id, qty) {
    qty = Math.max(0, Math.min(20, qty));
    if (!qty) delete cart[id];
    else cart[id] = { qty: qty, note: (cart[id] && cart[id].note) || '' };
    saveCart();
    refreshSteppers(id);
    renderBar();
    if (!$('cart-sheet').hidden) renderSheet();
  }
  function cartCount() { return Object.keys(cart).reduce(function (s, id) { return s + cart[id].qty; }, 0); }
  function cartTotal() {
    return Object.keys(cart).reduce(function (s, id) { return s + cart[id].qty * index[id].price; }, 0);
  }

  function stepper(id) {
    var wrap = el('div', 'stepper');
    wrap.dataset.id = id;
    fillStepper(wrap);
    return wrap;
  }
  function fillStepper(wrap) {
    var id = wrap.dataset.id;
    var q = cart[id] ? cart[id].qty : 0;
    wrap.innerHTML = '';
    if (!q) {
      var add = el('button', 'add-btn', 'Add');
      add.type = 'button';
      add.setAttribute('aria-label', 'Add ' + index[id].name);
      add.addEventListener('click', function () { setQty(id, 1); });
      wrap.appendChild(add);
      return;
    }
    var minus = el('button', 'step', '−'); minus.type = 'button';
    minus.setAttribute('aria-label', 'One fewer ' + index[id].name);
    minus.addEventListener('click', function () { setQty(id, q - 1); });
    var n = el('span', 'step-n', String(q)); n.setAttribute('aria-live', 'polite');
    var plus = el('button', 'step', '+'); plus.type = 'button';
    plus.setAttribute('aria-label', 'One more ' + index[id].name);
    plus.addEventListener('click', function () { setQty(id, q + 1); });
    wrap.appendChild(minus); wrap.appendChild(n); wrap.appendChild(plus);
  }
  function refreshSteppers(id) {
    document.querySelectorAll('.stepper[data-id="' + id + '"]').forEach(fillStepper);
  }

  function renderBar() {
    var bar = $('cart-bar');
    var n = cartCount();
    bar.hidden = !canOrder || !n;
    document.body.classList.toggle('has-cart', !bar.hidden);
    $('cart-bar-count').textContent = n + (n === 1 ? ' item' : ' items');
    $('cart-bar-total').textContent = money(cartTotal());
  }

  // ---------------------------------------------------------------------------
  // Menu
  // ---------------------------------------------------------------------------
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
        var row = el('article', 'menu-item' + (it.available === false ? ' sold-out' : '') + (canOrder ? ' can-order' : ''));
        var diet = el('i', 'diet ' + (it.veg === true ? 'veg' : it.veg === false ? 'nonveg' : 'none'));
        diet.setAttribute('role', 'img');
        diet.setAttribute('aria-label', it.veg === true ? 'Vegetarian' : it.veg === false ? 'Non-vegetarian' : '');
        if (it.veg !== true && it.veg !== false) diet.setAttribute('aria-hidden', 'true');
        row.appendChild(diet);
        row.appendChild(el('h3', '', it.name));
        row.appendChild(el('span', 'price', money(it.price)));
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
        if (canOrder) {
          if (orderable(it)) row.appendChild(stepper(String(it.id)));
          else if (it.available !== false) row.appendChild(el('span', 'ask-label', 'Ask us'));
        }
        sec.appendChild(row);
        shown++;
      });
      root.appendChild(sec);
    });

    if (!shown) {
      root.appendChild(el('p', 'menu-empty', q || vegOnly ? 'Nothing matches that. Try another word.' : 'The menu is being updated. Please ask a team member.'));
    }
    spy();
  }

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

  // ---------------------------------------------------------------------------
  // Ordering state: why ordering is or isn't possible right now
  // ---------------------------------------------------------------------------
  function pickupSlots() {
    // Same arithmetic as pickupSlots() in functions/lib/guest.js.
    var now = TCMSite.nowInJodhpur();
    if (info.closedWeekdays.indexOf(now.weekday) !== -1 ||
        (info.reservations.closedDates || []).indexOf(now.date) !== -1) return [];
    var prep = Number(info.ordering.prepMinutes) || 20;
    var out = [];
    var last = toMin(info.close) - 15;
    for (var m = Math.ceil(toMin(info.open) / 15) * 15; m <= last; m += 15) {
      if (m >= now.minutes + prep) out.push(pad(Math.floor(m / 60)) + ':' + pad(m % 60));
    }
    return out;
  }

  function orderingStatus() {
    if (mode === 'view') return { can: false };
    if (menu.sample) return { can: false, msg: 'Online ordering starts once our menu is published. Please order with a team member.' };
    if (mode === 'table') {
      if (info.ordering.tableEnabled === false) return { can: false, msg: 'Ordering from the table is paused. A team member will take your order.' };
      if (!TCMSite.openState(info).open) return { can: false, msg: 'The kitchen is closed right now. ' + TCMSite.openState(info).text + '.' };
      return { can: true };
    }
    if (info.ordering.takeawayEnabled === false) return { can: false, msg: 'Takeaway orders are paused right now. Please call us.' };
    if (!pickupSlots().length) return { can: false, msg: 'We are not taking more takeaway orders today. ' + TCMSite.openState(info).text + '.' };
    return { can: true };
  }

  // ---------------------------------------------------------------------------
  // Checkout sheet
  // ---------------------------------------------------------------------------
  function openSheet() {
    renderSheet();
    $('cart-sheet').hidden = false;
    document.body.classList.add('sheet-open');
    $('sheet-close').focus();
  }
  function closeSheet() {
    $('cart-sheet').hidden = true;
    document.body.classList.remove('sheet-open');
    $('cart-bar-open').focus();
  }

  function renderSheet() {
    var list = $('sheet-lines');
    list.innerHTML = '';
    var ids = Object.keys(cart);
    if (!ids.length) { closeSheet(); return; }
    ids.forEach(function (id) {
      var it = index[id];
      var li = el('li', 'sheet-line');
      var top = el('div', 'sheet-line-top');
      var name = el('div', 'sheet-line-name');
      name.appendChild(el('strong', '', it.name));
      name.appendChild(el('span', 'muted small', money(it.price) + ' each'));
      top.appendChild(name);
      top.appendChild(stepper(id));
      top.appendChild(el('span', 'sheet-line-total', money(it.price * cart[id].qty)));
      li.appendChild(top);
      var note = el('input', 'line-note');
      note.placeholder = 'Add a note (less sugar, oat milk…)';
      note.maxLength = 120;
      note.value = cart[id].note || '';
      note.setAttribute('aria-label', 'Note for ' + it.name);
      note.addEventListener('input', function () { cart[id].note = note.value; saveCart(); });
      li.appendChild(note);
      list.appendChild(li);
    });
    $('sheet-total').textContent = money(cartTotal());
  }

  function fillPickup() {
    var sel = $('pickup');
    if (!sel) return;
    var current = sel.value;
    sel.innerHTML = '';
    pickupSlots().forEach(function (s, i) {
      var o = el('option', '', (i === 0 ? 'Earliest · ' : '') + TCMSite.fmtTime(s));
      o.value = s;
      sel.appendChild(o);
    });
    if (current) sel.value = current;
  }

  function remember() {
    try {
      var g = JSON.parse(localStorage.getItem('tcm:guest') || 'null') || {};
      if (g.name && $('o-name')) $('o-name').value = g.name;
      if (g.phone && $('o-phone')) $('o-phone').value = g.phone;
    } catch (e) { /* ignore */ }
  }

  function showError(msg) {
    var box = $('sheet-error');
    box.textContent = msg;
    box.hidden = !msg;
  }

  function send(e) {
    e.preventDefault();
    showError('');
    var name = $('o-name') ? $('o-name').value.trim() : '';
    var phone = $('o-phone') ? $('o-phone').value.trim() : '';
    if (mode === 'takeaway') {
      if (name.length < 2) { $('o-name').focus(); return showError('Tell us your name for the order.'); }
      if (phone.replace(/\D/g, '').length < 10) { $('o-phone').focus(); return showError('We need your mobile number for a takeaway order.'); }
    }
    var payload = {
      type: mode,
      table: table,
      items: Object.keys(cart).map(function (id) { return { id: id, qty: cart[id].qty, note: cart[id].note || '' }; }),
      note: $('o-note').value.trim(),
      name: name,
      phone: phone,
      pickupTime: $('pickup') ? $('pickup').value : '',
      company: $('o-company').value
    };
    var btn = $('send-order');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    TCMSite.call('placeOrder', payload).then(function (res) {
      try {
        if (name || phone) {
          var g = JSON.parse(localStorage.getItem('tcm:guest') || 'null') || {};
          localStorage.setItem('tcm:guest', JSON.stringify({ name: name || g.name, phone: phone || g.phone, email: g.email }));
        }
        var mine = JSON.parse(localStorage.getItem('tcm:orders') || '[]');
        mine.unshift({ id: res.id, k: res.token, code: res.code, at: Date.now() });
        localStorage.setItem('tcm:orders', JSON.stringify(mine.slice(0, 10)));
        localStorage.removeItem(CART_KEY);
      } catch (err) { /* ignore */ }
      location.href = '/order?id=' + encodeURIComponent(res.id) + '&k=' + encodeURIComponent(res.token);
    }).catch(function (err) {
      showError(err && /^(INVALID_ARGUMENT|RESOURCE_EXHAUSTED)$/.test(err.code)
        ? err.message
        : 'We could not send your order just now. Please try again, or order with a team member.');
      btn.disabled = false;
      btn.textContent = mode === 'takeaway' ? 'Place pickup order' : 'Send order to the kitchen';
    });
  }

  // ---------------------------------------------------------------------------
  search.addEventListener('input', render);
  vegBtn.addEventListener('click', function () {
    vegOnly = !vegOnly;
    vegBtn.setAttribute('aria-pressed', vegOnly ? 'true' : 'false');
    render();
  });
  $('cart-bar-open').addEventListener('click', openSheet);
  $('sheet-close').addEventListener('click', closeSheet);
  $('cart-sheet').addEventListener('click', function (e) { if (e.target === $('cart-sheet')) closeSheet(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('cart-sheet').hidden) closeSheet(); });
  $('order-form').addEventListener('submit', send);

  Promise.all([TCMSite.loadMenu(), TCMSite.loadInfo()]).then(function (r) {
    menu = r[0] || { categories: [] };
    info = r[1];
    (menu.categories || []).forEach(function (c) {
      if (c.hidden) return;
      (c.items || []).forEach(function (it) { if (!it.hidden && it.id) index[String(it.id)] = it; });
    });

    var status = orderingStatus();
    canOrder = status.can;
    var note = $('order-note');
    if (note && status.msg) { note.textContent = status.msg; note.hidden = false; }
    if (canOrder) {
      $('order-hint').hidden = false;
      loadCart();
      fillPickup();
      remember();
    }

    $('menu-footnote').textContent = menu.footnote || 'Prices are in Indian rupees.';
    $('menu-sample').hidden = !menu.sample;
    render();
    renderBar();
  }).catch(function () {
    root.innerHTML = '';
    root.appendChild(el('p', 'menu-empty', 'We could not load the menu. Please check your connection, or ask a team member.'));
  });
})();
