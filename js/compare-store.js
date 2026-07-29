/*
 * compare-store.js — Tiny shared store for the "add to comparison" tray.
 * Persists up to 10 department slugs in localStorage so the selection follows the
 * user from the map/directory to the /compare page. Exposes window.FireCompareStore.
 */
(function () {
  'use strict';
  var KEY = 'fireCompare';
  var MAX = 10;
  var listeners = [];

  function read() {
    try { var a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a.slice(0, MAX) : []; }
    catch (e) { return []; }
  }
  function write(a) {
    try { localStorage.setItem(KEY, JSON.stringify(a.slice(0, MAX))); } catch (e) {}
    listeners.forEach(function (cb) { cb(a); });
  }
  var store = {
    MAX: MAX,
    list: read,
    has: function (slug) { return read().indexOf(slug) !== -1; },
    count: function () { return read().length; },
    add: function (slug) {
      var a = read();
      if (a.indexOf(slug) === -1 && a.length < MAX) { a.push(slug); write(a); }
      return a;
    },
    remove: function (slug) { write(read().filter(function (s) { return s !== slug; })); },
    toggle: function (slug) { return this.has(slug) ? (this.remove(slug), false) : (this.add(slug), true); },
    clear: function () { write([]); },
    onChange: function (cb) { listeners.push(cb); }
  };
  window.FireCompareStore = store;
})();
