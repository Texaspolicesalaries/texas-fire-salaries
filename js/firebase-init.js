/*
 * firebase-init.js — Firebase bootstrap for Texas Fire Salaries.
 *
 * HOW TO CONNECT (owner handoff):
 *   1. Create a Firebase project (Auth + Firestore + Storage).
 *   2. Enable Google and Email/Password sign-in providers; require email verification.
 *   3. Paste your web config into FIREBASE_CONFIG below.
 *
 * Until a real config is present the whole site still works READ-ONLY off the
 * static seed data. Auth + submissions degrade gracefully (see .ready).
 *
 * Uses the Firebase v10 modular SDK from the CDN via dynamic import, mirroring the
 * loading approach of the sibling police site. Exposes window.FireDB.
 */
(function () {
  'use strict';

  // ▼▼▼ OWNER: Firebase web config (public by design — safe to commit) ▼▼▼
  var FIREBASE_CONFIG = {
    apiKey: "AIzaSyBpnI8n2kY8as6fKC-RUZDRwyP8yZ5Mook",
    authDomain: "texas-fire-salaries.firebaseapp.com",
    projectId: "texas-fire-salaries",
    storageBucket: "texas-fire-salaries.firebasestorage.app",
    messagingSenderId: "298653291252",
    appId: "1:298653291252:web:22370a0d481ac9be8504a1"
  };
  // ▲▲▲ ------------------------------------------- ▲▲▲

  var SDK = "https://www.gstatic.com/firebasejs/10.12.0";
  var configured = FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey !== "REPLACE_ME";

  var FireDB = {
    ready: false,
    configured: configured,
    app: null, auth: null, db: null, storage: null,
    sdk: {},            // { auth: <module>, firestore: <module>, storage: <module> }
    _resolvers: [],
    // Await readiness (resolves even when unconfigured — check .configured/.ready)
    whenReady: function () {
      var self = this;
      return new Promise(function (resolve) {
        if (self._settled) return resolve(self);
        self._resolvers.push(resolve);
      });
    },
    _settle: function () {
      this._settled = true;
      var self = this;
      this._resolvers.splice(0).forEach(function (r) { r(self); });
    }
  };
  window.FireDB = FireDB;

  if (!configured) {
    // Read-only mode. Announce for UI gates.
    document.documentElement.setAttribute('data-firebase', 'unconfigured');
    console.info('[FireDB] Firebase not configured — running read-only from seed data.');
    FireDB._settle();
    return;
  }

  (async function () {
    try {
      var appMod = await import(SDK + "/firebase-app.js");
      var authMod = await import(SDK + "/firebase-auth.js");
      var fsMod = await import(SDK + "/firebase-firestore.js");
      var stMod = await import(SDK + "/firebase-storage.js");

      var app = appMod.initializeApp(FIREBASE_CONFIG);
      FireDB.app = app;
      FireDB.auth = authMod.getAuth(app);
      // ignoreUndefinedProperties: optional blank form fields become undefined;
      // without this Firestore's addDoc/setDoc throws on them.
      FireDB.db = fsMod.initializeFirestore(app, { ignoreUndefinedProperties: true });
      FireDB.storage = stMod.getStorage(app);
      FireDB.sdk = { auth: authMod, firestore: fsMod, storage: stMod };
      FireDB.ready = true;
      document.documentElement.setAttribute('data-firebase', 'ready');
    } catch (err) {
      console.error('[FireDB] init failed — falling back to read-only.', err);
      document.documentElement.setAttribute('data-firebase', 'error');
    } finally {
      FireDB._settle();
    }
  })();
})();
