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

  var LINKS = [
    { href: '/index.html', key: 'home', label: 'Explore' },
    { href: '/map.html', key: 'map', label: 'Map' },
    { href: '/compare.html', key: 'compare', label: 'Compare' },
    { href: '/departments.html', key: 'departments', label: 'Departments' },
    { href: '/submit.html', key: 'submit', label: 'Submit Data' },
    { href: '/how-it-works.html', key: 'how', label: 'How It Works' }
  ];

  var BRAND_MARK =
    '<svg class="brand-mark" viewBox="0 0 32 32" role="img" aria-label="Texas Fire Salaries">' +
      '<rect x="1" y="1" width="30" height="30" rx="8" fill="#1C232E"/>' +
      '<path d="M8 21c2.5-3 4-6.5 8-6.5S22 18 24 21" fill="none" stroke="#2A7268" stroke-width="2" stroke-linecap="round"/>' +
      '<path d="M9.5 15.5C11.5 13 13 11 16 11s4.5 2.5 6.5 4.5" fill="none" stroke="#B94E1E" stroke-width="2" stroke-linecap="round"/>' +
      '<circle cx="16" cy="9" r="2.4" fill="#D2632B"/>' +
    '</svg>';

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
        '<a class="brand" href="/index.html">' + BRAND_MARK +
          '<span>Texas Fire Salaries<small>Community pay atlas</small></span>' +
        '</a>' +
        '<button class="nav-toggle" aria-expanded="false" aria-controls="nav-links" aria-label="Menu">☰</button>' +
        '<div class="nav-links" id="nav-links">' + links +
          '<a class="btn btn-outline btn-sm nav-cta" id="nav-auth" href="/sign-in.html">Sign In</a>' +
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
          '<a href="/map.html">Interactive map</a><a href="/departments.html">Department directory</a>' +
          '<a href="/compare.html">Compare departments</a><a href="/submit.html">Submit data</a>' +
        '</div>' +
        '<div><h4>About</h4>' +
          '<a href="/how-it-works.html">How it works</a><a href="/community-policy.html">Community policy</a>' +
          '<a href="/claim-policy.html">Claim your department</a><a href="/disclaimer.html">Disclaimer</a>' +
        '</div>' +
        '<div><h4>Legal</h4>' +
          '<a href="/terms.html">Terms of Use</a><a href="/privacy-policy.html">Privacy Policy</a>' +
          '<a href="/disclaimer.html">Copyright &amp; removal</a>' +
        '</div>' +
      '</div></div>' +
      '<div class="footer-disclaimer" style="background:transparent;border-top:1px solid var(--border);border-bottom:0"><div class="wrap"><small class="faint">' + FOOTER_DISCLAIMER + '</small></div></div>' +
      '<div class="wrap"><div class="footer-bottom">© ' + new Date().getFullYear() + ' Texas Fire Salaries · Community reported, not official.</div></div>' +
    '</footer>';
  }

  function mount() {
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
          el.href = '/submit.html';
          el.classList.remove('btn-outline'); el.classList.add('btn-primary');
        } else {
          el.textContent = 'Sign In';
          el.href = '/sign-in.html';
          el.classList.add('btn-outline'); el.classList.remove('btn-primary');
        }
      });
    }
  }

  window.FireNav = { DISCLAIMER: DISCLAIMER, FOOTER_DISCLAIMER: FOOTER_DISCLAIMER };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
