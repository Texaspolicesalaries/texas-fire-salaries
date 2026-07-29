/*
 * auth.js — Sign-in + contributor identity for Texas Fire Salaries.
 *
 * Google + Email/Password with an EMAIL-VERIFICATION gate before a user may
 * publish submissions. Minimal profile only (display name, public-name
 * preference, counts, trust status) — email is never displayed publicly.
 *
 * Exposes window.FireAuth. When Firebase is unconfigured, everything no-ops
 * gracefully and canContribute() returns false.
 */
(function () {
  'use strict';

  // Client-side admin list — MUST mirror isAdmin() in firestore.rules. Emails are
  // not secret; the rules are the real enforcement. This just unlocks the admin UI.
  var ADMIN_EMAILS = ['dfwfiresalaries@gmail.com', 'fastford19@gmail.com'];

  var FireAuth = {
    user: null,           // firebase user or null
    profile: null,        // firestore users/{uid} doc data or null
    _cbs: [],
    onChange: function (cb) { this._cbs.push(cb); if (this.user !== undefined) cb(this.user, this.profile); },
    _emit: function () { var self = this; this._cbs.forEach(function (cb) { cb(self.user, self.profile); }); },
    isSignedIn: function () { return !!this.user; },
    isVerified: function () { return !!(this.user && this.user.emailVerified); },
    // A verified, signed-in, non-suspended user may publish.
    canContribute: function () {
      return this.isVerified() && !(this.profile && this.profile.suspended);
    },
    isAdmin: function () {
      if (this.profile && this.profile.role === 'admin') return true;
      var email = this.user && this.user.emailVerified && this.user.email;
      return !!(email && ADMIN_EMAILS.indexOf(email) !== -1);
    },
    publicName: function () {
      if (!this.profile) return 'Contributor';
      return this.profile.publicNamePreference === 'anonymous'
        ? 'Anonymous contributor'
        : (this.profile.displayName || 'Contributor');
    }
  };
  window.FireAuth = FireAuth;

  FireDB.whenReady().then(function (db) {
    if (!db.ready) { FireAuth.user = null; FireAuth._emit(); return; }
    var A = db.sdk.auth, F = db.sdk.firestore;

    A.onAuthStateChanged(db.auth, async function (user) {
      FireAuth.user = user || null;
      if (user) {
        try { FireAuth.profile = await ensureProfile(db, F, user); }
        catch (e) { console.warn('[FireAuth] profile load failed', e); FireAuth.profile = null; }
      } else {
        FireAuth.profile = null;
      }
      FireAuth._emit();
    });

    // ---- Sign-in methods ----
    FireAuth.signInWithGoogle = async function () {
      var provider = new A.GoogleAuthProvider();
      return A.signInWithPopup(db.auth, provider);
    };
    FireAuth.signUpWithEmail = async function (email, password, displayName) {
      var cred = await A.createUserWithEmailAndPassword(db.auth, email, password);
      if (displayName) await A.updateProfile(cred.user, { displayName: displayName });
      await A.sendEmailVerification(cred.user);
      return cred;
    };
    FireAuth.signInWithEmail = function (email, password) {
      return A.signInWithEmailAndPassword(db.auth, email, password);
    };
    FireAuth.sendVerification = function () {
      return FireAuth.user ? A.sendEmailVerification(FireAuth.user) : Promise.reject('not signed in');
    };
    FireAuth.resetPassword = function (email) { return A.sendPasswordResetEmail(db.auth, email); };
    FireAuth.signOut = function () { return A.signOut(db.auth); };
    FireAuth.updatePublicName = async function (name, preference) {
      if (!FireAuth.user) return;
      var ref = F.doc(db.db, 'users', FireAuth.user.uid);
      await F.updateDoc(ref, { displayName: name, publicNamePreference: preference });
      if (FireAuth.profile) { FireAuth.profile.displayName = name; FireAuth.profile.publicNamePreference = preference; }
      FireAuth._emit();
    };
  });

  async function ensureProfile(db, F, user) {
    var ref = F.doc(db.db, 'users', user.uid);
    var snap = await F.getDoc(ref);
    if (snap.exists()) return snap.data();
    var fresh = {
      displayName: user.displayName || (user.email ? user.email.split('@')[0] : 'Contributor'),
      publicNamePreference: 'username',   // or 'anonymous'
      emailVerified: !!user.emailVerified,
      role: 'contributor',
      trustStatus: 'new',
      submissionCount: 0,
      confirmationCount: 0,
      suspended: false,
      createdAt: F.serverTimestamp()
    };
    await F.setDoc(ref, fresh);
    return fresh;
  }
})();
