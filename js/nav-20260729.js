/*
 * nav.js — Injects the shared header + footer on every page so markup stays DRY.
 * Handles the mobile slide-out, active-link highlighting, the persistent footer
 * disclaimer, and reflecting auth state in the Sign In control.
 *
 * Usage: put <div id="site-header"></div> near the top and
 * <div id="site-footer"></div> near the bottom of each page, set
 * <body data-page="map"> to mark the active nav item.
 */
(function () {
  'use strict';

  // Bust redirect responses cached by browsers before the clean-route fix.
  // The marker is removed from the address bar as soon as the destination loads.
  var NAV_REV = '20260729';
  function navHref(path) { return path + '?nav=' + NAV_REV; }

  var LINKS = [
    { href: '/', key: 'home', label: 'Explore' },
    { href: navHref('/map'), key: 'map', label: 'Map' },
    { href: navHref('/compare'), key: 'compare', label: 'Compare' },
    { href: navHref('/departments'), key: 'departments', label: 'Departments' },
    { href: navHref('/submit'), key: 'submit', label: 'Submit Data' },
    { href: navHref('/how-it-works'), key: 'how', label: 'How It Works' }
  ];

  var BRAND_MARK =
    '<img class="brand-mark" src="/assets/branding/favicon-64.png" width="34" height="34" alt="" aria-hidden="true">';

  var DISCLAIMER = 'Texas Fire Salaries is a community-maintained database. Compensation information may be incomplete, outdated, or incorrect. Always confirm current pay, benefits, and employment terms directly with the hiring department.';
  var FOOTER_DISCLAIMER = 'Texas Fire Salaries is an independent community-maintained website and is not affiliated with or endorsed by any fire department, city, county, or government agency. Compensation information may be incomplete or outdated. Confirm all employment information directly with the hiring department.';

  function headerHTML(activeKey) {
    var links = LINKS.map(function (l) {
      return '<a href="' + l.href + '"' + (l.key === activeKey ? ' class="active" aria-current="page"' : '') + '>' + l.label + '</a>';
    }).join('');
    return '' +
    '<a class="skip-link" href="#main">Skip to content</a>' +
    '<header class="site-header">' +
      '<nav class="nav" aria-label="Primary">' +
        '<a class="brand" href="/">' + BRAND_MARK +
          '<span>Texas Fire Salaries<small>Community pay atlas</small></span>' +
        '</a>' +
        '<button class="nav-toggle" aria-expanded="false" aria-controls="nav-links" aria-label="Menu">☰</button>' +
        '<div class="nav-links" id="nav-links">' + links +
          '<a class="btn btn-outline btn-sm nav-cta" id="nav-auth" href="' + navHref('/sign-in') + '">Sign In</a>' +
        '</div>' +
      '</nav>' +
    '</header>';
  }

  function footerHTML() {
    return '' +
    '<footer class="site-footer">' +
      '<div class="footer-disclaimer"><div class="wrap">' + DISCLAIMER + '</div></div>' +
      '<div class="wrap"><div class="footer-inner">' +
        '<div>' +
          '<div class="brand" style="margin-bottom:.6rem">' + BRAND_MARK + '<span>Texas Fire Salaries</span></div>' +
          '<p class="faint" style="font-size:.85rem">A statewide, community-built firefighter compensation map and comparison database. Built and maintained by the Texas fire-service community.</p>' +
        '</div>' +
        '<div><h4>Explore</h4>' +
          '<a href="' + navHref('/map') + '">Interactive map</a><a href="' + navHref('/departments') + '">Department directory</a>' +
          '<a href="' + navHref('/compare') + '">Compare departments</a><a href="' + navHref('/submit') + '">Submit data</a>' +
        '</div>' +
        '<div><h4>About</h4>' +
          '<a href="' + navHref('/how-it-works') + '">How it works</a><a href="' + navHref('/community-policy') + '">Community policy</a>' +
          '<a href="' + navHref('/claim-policy') + '">Claim your department</a><a href="' + navHref('/disclaimer') + '">Disclaimer</a>' +
        '</div>' +
        '<div><h4>Legal</h4>' +
          '<a href="' + navHref('/terms') + '">Terms of Use</a><a href="' + navHref('/privacy-policy') + '">Privacy Policy</a>' +
          '<a href="' + navHref('/disclaimer') + '">Copyright &amp; removal</a>' +
        '</div>' +
      '</div></div>' +
      '<div class="footer-disclaimer" style="background:transparent;border-top:1px solid #2a3550;border-bottom:0"><div class="wrap"><small class="faint">' + FOOTER_DISCLAIMER + '</small></div></div>' +
      '<div class="wrap"><div class="footer-bottom">© ' + new Date().getFullYear() + ' Texas Fire Salaries · Community reported, not official.</div></div>' +
    '</footer>';
  }

  function ensureBrandAssets() {
    if (!document.querySelector('link[rel~="icon"]')) {
      var favicon = document.createElement('link');
      favicon.rel = 'icon';
      favicon.href = '/assets/branding/favicon.ico';
      favicon.sizes = 'any';
      document.head.appendChild(favicon);
    }
    if (!document.querySelector('link[rel="apple-touch-icon"]')) {
      var touchIcon = document.createElement('link');
      touchIcon.rel = 'apple-touch-icon';
      touchIcon.href = '/assets/branding/favicon-180.png';
      document.head.appendChild(touchIcon);
    }
  }

  function clearNavMarker() {
    var url = new URL(window.location.href);
    if (!url.searchParams.has('nav')) return;
    url.searchParams.delete('nav');
    var query = url.searchParams.toString();
    window.history.replaceState(null, '', url.pathname + (query ? '?' + query : '') + url.hash);
  }

  function mount() {
    clearNavMarker();
    ensureBrandAssets();
    var body = document.body;
    var active = body.getAttribute('data-page') || '';
    var h = document.getElementById('site-header');
    var f = document.getElementById('site-footer');
    if (h) h.innerHTML = headerHTML(active);
    if (f) f.innerHTML = footerHTML();

    // Mobile toggle
    var toggle = document.querySelector('.nav-toggle');
    var links = document.getElementById('nav-links');
    if (toggle && links) {
      toggle.addEventListener('click', function () {
        var open = links.classList.toggle('open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }

    // Reflect auth state
    if (window.FireAuth) {
      window.FireAuth.onChange(function (user) {
        var el = document.getElementById('nav-auth');
        if (!el) return;
        if (user) {
          el.textContent = window.FireAuth.publicName();
          el.href = navHref('/submit');
          el.classList.remove('btn-outline'); el.classList.add('btn-primary');
        } else {
          el.textContent = 'Sign In';
          el.href = navHref('/sign-in');
          el.classList.add('btn-outline'); el.classList.remove('btn-primary');
        }
      });
    }
  }

  window.FireNav = { DISCLAIMER: DISCLAIMER, FOOTER_DISCLAIMER: FOOTER_DISCLAIMER };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
