/*
 * analytics.js — Lightweight, privacy-conscious event tracking.
 *
 * Writes directly to Firestore's `events` collection (open create, schema-
 * locked, no PII — see firestore.rules), which js/admin.js reads to build the
 * analytics dashboard. No PII, no cross-session tracking (sessionId lives in
 * sessionStorage, cleared when the tab closes), and every page-view-shaped
 * event is deduped to at most once per session so a single visitor can't
 * inflate the counts just by scrolling around.
 *
 * Deliberately narrow: a handful of meaningful signals (what got viewed,
 * searched, compared, submitted), not a raw pageview-per-load firehose — this
 * site already goes out of its way to keep Firestore usage low for visitors
 * (see js/data.js's LIVE_OVERLAY=false comment), and unauthenticated writes
 * cost real quota the same way reads do.
 *
 * Best-effort only: never throws, never blocks the page, no-ops entirely when
 * Firebase isn't configured.
 */
(function () {
  'use strict';

  function sessionId() {
    try {
      var id = sessionStorage.getItem('fireSessionId');
      if (!id) {
        id = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem('fireSessionId', id);
      }
      return id;
    } catch (e) { return 'sess_unknown'; }
  }

  // True the FIRST time this key is seen this session (and marks it seen) —
  // used to cap page-view-shaped events to once per session per subject.
  function firstThisSession(key) {
    try {
      var flag = 'fireSeen_' + key;
      if (sessionStorage.getItem(flag)) return false;
      sessionStorage.setItem(flag, '1');
      return true;
    } catch (e) { return true; } // sessionStorage unavailable — don't block tracking over it
  }

  function track(type, data) {
    var db = window.FireDB;
    if (!db || !db.configured) return;
    db.whenReady().then(function () {
      if (!db.ready) return;
      var F = db.sdk.firestore;
      var doc = Object.assign({
        type: type,
        sessionId: sessionId(),
        date: new Date().toISOString().slice(0, 10),
        timestamp: F.serverTimestamp(),
        // Firestore's TTL policy (console setting on the `events` collection
        // group, field `expiresAt`) garbage-collects each event ~90 days out.
        // The admin dashboard reads at most 30 days back, so older events are
        // pure storage cost. TTL needs a FUTURE timestamp — `timestamp` above
        // is the creation time and would delete everything immediately.
        expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000)
      }, data || {});
      F.addDoc(F.collection(db.db, 'events'), doc).catch(function () { /* best-effort only */ });
    });
  }

  window.FireAnalytics = {
    track: track,
    // Once per session per department — a visitor re-reading the same page
    // (or bouncing back via browser-back) doesn't inflate view counts.
    trackDepartmentView: function (slug) {
      if (!slug || !firstThisSession('dept_' + slug)) return;
      track('department_view', { page: 'department', departmentSlug: slug });
    },
    // Fired once per executed search (not per keystroke) by the caller.
    trackSearch: function (page, query, resultCount) {
      var q = String(query || '').trim();
      if (!q) return;
      track('search', { page: page, query: q.slice(0, 200), value: resultCount != null ? resultCount : undefined });
    },
    trackCompareAdd: function (slug) {
      if (!slug) return;
      track('compare_add', { page: 'compare', departmentSlug: slug });
    },
    trackSubmitComplete: function (slug, mode) {
      track('submit_complete', { page: 'submit', departmentSlug: slug || undefined, label: mode || undefined });
    }
  };
})();
