/* =============================================================================
 * TCM BrewOps — boot guard
 * -----------------------------------------------------------------------------
 * MUST be the first script on every page, before any CDN tag.
 *
 * It is same-origin and has zero dependencies, so it is the one piece that still
 * runs when everything else has failed. Its job is to make sure a broken page
 * SAYS what broke instead of sitting on a loading message forever.
 *
 * Without this, a blocked CDN (ad blocker, café wifi portal, corporate filter,
 * an SRI hash that no longer matches what the CDN serves) produced a permanently
 * stuck "Verifying terminal…" screen with nothing in the UI to act on.
 * ========================================================================== */
(function (global) {
  'use strict';

  var LOADED_AT = Date.now();
  var reported = false;

  // Friendly names + what to do, keyed by the global each script defines.
  var DEPENDENCIES = [
    { global: 'firebase', label: 'Firebase SDK', host: 'www.gstatic.com' },
    { global: 'React', label: 'React', host: 'unpkg.com', jsxOnly: true },
    { global: 'ReactDOM', label: 'React DOM', host: 'unpkg.com', jsxOnly: true },
    { global: 'Babel', label: 'Babel (JSX compiler)', host: 'unpkg.com', jsxOnly: true },
    { global: 'TCM', label: 'BrewOps core (assets/tcm-core.js)', host: 'this site' }
  ];

  function el(tag, style, text) {
    var node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text) node.textContent = text;   // textContent, never innerHTML
    return node;
  }

  /**
   * Replace the page with a plain, readable failure panel.
   * Styled inline because Tailwind may itself be the thing that failed.
   */
  function showFailure(title, lines, detail) {
    if (reported) return;

    // A script in <head> can fail before <body> exists. Queue the panel rather
    // than throwing on a null document.body — and do NOT mark it reported yet,
    // or the real message would be suppressed by the failed attempt.
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () {
        showFailure(title, lines, detail);
      });
      return;
    }

    reported = true;

    var wrap = el('div', 'min-height:100vh;display:flex;align-items:center;justify-content:center;' +
      'padding:24px;background:#FAF8F5;font-family:system-ui,-apple-system,sans-serif;');
    var card = el('div', 'max-width:560px;width:100%;background:#fff;border:1px solid #e5ded4;' +
      'border-left:6px solid #8B2626;border-radius:14px;padding:28px;' +
      'box-shadow:0 8px 32px -4px rgba(19,42,27,.12);color:#132A1B;');

    card.appendChild(el('h1', 'margin:0 0 12px;font-size:19px;color:#8B2626;', title));

    lines.forEach(function (line) {
      card.appendChild(el('p', 'margin:0 0 10px;font-size:14px;line-height:1.55;', line));
    });

    if (detail && detail.length) {
      var list = el('ul', 'margin:14px 0 0;padding-left:20px;font-size:13px;line-height:1.7;color:#5b5044;');
      detail.forEach(function (d) { list.appendChild(el('li', null, d)); });
      card.appendChild(list);
    }

    var retry = el('button', 'margin-top:20px;padding:11px 20px;border:0;border-radius:10px;' +
      'background:#8b5e3c;color:#fff;font-weight:700;font-size:12px;letter-spacing:.12em;' +
      'text-transform:uppercase;cursor:pointer;', 'Try again');
    retry.onclick = function () { global.location.reload(); };
    card.appendChild(retry);

    var diag = el('a', 'margin-top:20px;margin-left:12px;font-size:12px;color:#8b5e3c;', 'Run diagnostics');
    diag.href = 'diagnostics.html';
    card.appendChild(diag);

    wrap.appendChild(card);
    document.body.innerHTML = '';
    document.body.appendChild(wrap);
  }

  // Safe crash reporter. Installed immediately, and NOT dependent on TCM —
  // the previous handler was installed by TCM.installCrashHandler(), so it could
  // never fire for the most common failure, which is TCM itself not loading.
  global.addEventListener('error', function (e) {
    // Resource load errors (a failed <script>) have no e.message; the
    // dependency sweep below reports those with far better context.
    if (!e.message) return;

    // "TCM is not defined", "firebase is not defined" and friends are symptoms
    // of a missing dependency, not useful messages in their own right. Let the
    // sweep explain what actually failed and what to do about it.
    if (missingDependencies().length) { sweep(); return; }

    showFailure('Something went wrong', [
      e.message,
      'Reload the page. If it keeps happening, note the message above.'
    ]);
  });

  /** Which required globals never showed up. */
  function missingDependencies() {
    var needsJsx = !!document.querySelector('script[type="text/babel"]');
    var missing = [];
    DEPENDENCIES.forEach(function (dep) {
      if (dep.jsxOnly && !needsJsx) return;
      if (typeof global[dep.global] === 'undefined') missing.push(dep);
    });
    return missing;
  }

  /** Report the missing globals and explain the consequence. */
  function sweep() {
    var missing = missingDependencies();
    if (!missing.length) return;

    var hosts = {};
    missing.forEach(function (m) { hosts[m.host] = true; });

    showFailure(
      'BrewOps could not finish loading',
      [
        'These parts of the app never arrived: ' +
          missing.map(function (m) { return m.label; }).join(', ') + '.',
        'The app itself is fine — something stopped the files from downloading.'
      ],
      [
        'Check the internet connection on this device.',
        'Disable any ad blocker or content blocker for this site.',
        'On café or guest wifi, open any other website first to clear the login portal.',
        Object.keys(hosts).indexOf('this site') > -1
          ? 'assets/tcm-core.js is missing — the site may have been uploaded incompletely.'
          : 'If this device is on a company network, ' + Object.keys(hosts).join(' and ') + ' may be blocked.'
      ]
    );
  }

  // Give slow connections a fair chance before declaring failure.
  global.addEventListener('load', function () { setTimeout(sweep, 1500); });
  setTimeout(function () { if (document.readyState === 'complete') sweep(); }, 12000);

  global.TCMBoot = {
    showFailure: showFailure,
    startedAt: LOADED_AT
  };
})(window);
