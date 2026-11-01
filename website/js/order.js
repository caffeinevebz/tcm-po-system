/* =============================================================================
 * Order status — order.html?id=…&k=…
 * Polls the trackOrder function until the order is finished. The id and the
 * random key together are the guest's receipt: nobody else can see it.
 * ========================================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var id = params.get('id') || '';
  var key = params.get('k') || '';

  var STEPS = {
    table:    [['new', 'Received'], ['preparing', 'Being made'], ['ready', 'On its way'], ['served', 'Served']],
    takeaway: [['new', 'Received'], ['preparing', 'Being made'], ['ready', 'Ready to collect'], ['collected', 'Collected']]
  };
  var HEADLINES = {
    table: {
      new: 'Thank you! The bar has your order.',
      preparing: 'Your order is being made right now.',
      ready: 'Your order is ready and on its way to your table.',
      served: 'Enjoy! Pay at the counter whenever you are ready to leave.',
      cancelled: 'This order was cancelled. Please speak to a team member.'
    },
    takeaway: {
      new: 'Thank you! We have your order and will start it in good time.',
      preparing: 'Your order is being made.',
      ready: 'Your order is ready. Come and collect it at the counter.',
      collected: 'Collected. Enjoy, and see you again soon!',
      cancelled: 'This order was cancelled. Please call us if this is unexpected.'
    }
  };
  var FINAL = ['served', 'collected', 'cancelled'];
  var timer = null;
  var lastStatus = '';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function missing() {
    $('order-loading').hidden = true;
    $('order-body').hidden = true;
    $('order-missing').hidden = false;
  }

  function show(o) {
    $('order-loading').hidden = true;
    $('order-body').hidden = false;
    $('order-code').textContent = o.code;
    $('order-kind').textContent = o.type === 'takeaway'
      ? 'Pickup at ' + TCMSite.fmtTime(o.pickupTime)
      : 'Table ' + o.table;
    $('order-headline').textContent = (HEADLINES[o.type] || HEADLINES.table)[o.status] || '';
    document.title = 'Order ' + o.code + ' · The Caffeine Ministry';

    var steps = $('order-steps');
    steps.innerHTML = '';
    steps.hidden = o.status === 'cancelled';
    var order = (STEPS[o.type] || STEPS.table).map(function (s) { return s[0]; });
    var at = order.indexOf(o.status);
    (STEPS[o.type] || STEPS.table).forEach(function (s, i) {
      var li = el('li', i < at ? 'done' : i === at ? 'current' : '');
      li.appendChild(el('span', 'dot'));
      li.appendChild(el('span', 'step-label', s[1]));
      if (i === at) li.setAttribute('aria-current', 'step');
      steps.appendChild(li);
    });

    var items = $('order-items');
    items.innerHTML = '';
    (o.items || []).forEach(function (it) {
      var li = el('li');
      li.appendChild(el('span', '', it.name));
      li.appendChild(el('span', '', '× ' + it.qty));
      items.appendChild(li);
    });
    $('order-total').textContent = TCMSite.money(o.total);
    $('order-pay').textContent = o.type === 'takeaway'
      ? 'Pay when you collect: cash, card or UPI. Please quote order ' + o.code + '.'
      : 'Pay at the counter when you leave. Your order number is ' + o.code + '.';
    $('order-more').href = o.type === 'takeaway' ? '/takeaway' : '/menu?table=' + encodeURIComponent(o.table);
    $('order-feedback').href = '/feedback?visit=' + encodeURIComponent(o.code);

    // A gentle buzz when the order changes, if the phone allows it.
    if (lastStatus && lastStatus !== o.status && navigator.vibrate) navigator.vibrate(200);
    lastStatus = o.status;
  }

  function poll() {
    TCMSite.call('trackOrder', { id: id, token: key }).then(function (o) {
      show(o);
      if (FINAL.indexOf(o.status) === -1) timer = setTimeout(poll, document.hidden ? 30000 : 10000);
    }).catch(function (err) {
      if (err && err.code === 'INVALID_ARGUMENT') return missing();
      // A dropped connection: keep trying, more slowly.
      timer = setTimeout(poll, 20000);
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && timer && FINAL.indexOf(lastStatus) === -1) { clearTimeout(timer); poll(); }
  });

  if (!id || !key) missing(); else poll();
})();
