/*
 * sign-in.js — Auth page. Google + email/password, email-verification prompt,
 * and the public-name preference (username vs "Anonymous contributor").
 * Emails are never displayed publicly.
 */
(function () {
  'use strict';
  var A = window.FireAuth;
  var params = new URLSearchParams(location.search);
  var mode = params.get('mode') === 'create' ? 'create' : 'signin';
  var next = safeNext(params.get('next'));

  document.addEventListener('DOMContentLoaded', function () {
    var host = document.getElementById('auth-body');
    if (!host) return;

    if (!window.FireDB || !window.FireDB.configured) {
      window.FireDB.whenReady().then(function () {
        if (!window.FireDB.configured) {
          host.innerHTML = '<div class="notice info"><span class="notice-icon">🔧</span><div><strong>Firebase isn\'t connected in this build.</strong> Add your Firebase web config to <span class="mono">js/firebase-init.js</span> to enable Google and email sign-in. The rest of the site works read-only meanwhile.</div></div>';
        } else { render(host); }
      });
      return;
    }
    render(host);
    A.onChange(function (user) { if (user) renderSignedIn(host, user); });
  });

  function render(host) {
    updateHeading();
    var creating = mode === 'create';
    host.innerHTML =
      '<div class="auth-tabs" role="tablist" aria-label="Account action">' +
        '<button type="button" role="tab" id="tab-signin" aria-selected="' + (!creating) + '" class="' + (!creating ? 'active' : '') + '">Sign in</button>' +
        '<button type="button" role="tab" id="tab-create" aria-selected="' + creating + '" class="' + (creating ? 'active' : '') + '">Create account</button>' +
      '</div>' +
      '<div class="stack" role="tabpanel" aria-labelledby="' + (creating ? 'tab-create' : 'tab-signin') + '">' +
        '<button class="btn btn-outline btn-block btn-lg" id="google-btn">Continue with Google</button>' +
        '<div class="divider-label">or use email</div>' +
        (creating ? '<div class="field"><label for="dname">Display name</label><input id="dname" autocomplete="nickname" placeholder="Shown publicly, unless you choose Anonymous"></div>' : '') +
        '<div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="email" required></div>' +
        '<div class="field"><label for="password">Password</label><input id="password" type="password" autocomplete="' + (creating ? 'new-password' : 'current-password') + '" required>' +
          (creating ? '<div class="field-hint">Use at least 6 characters.</div>' : '') + '</div>' +
        '<button class="btn btn-primary btn-block" id="email-action">' + (creating ? 'Create account' : 'Sign in') + '</button>' +
        (!creating ? '<button class="btn btn-ghost btn-sm" id="reset-btn">Forgot password?</button>' : '') +
        '<div id="auth-status" role="status" aria-live="polite"></div>' +
      '</div>';

    document.getElementById('tab-signin').onclick = function () { setMode('signin', host); };
    document.getElementById('tab-create').onclick = function () { setMode('create', host); };

    var status = document.getElementById('auth-status');
    function msg(kind, message) {
      status.innerHTML = '<div class="notice ' + kind + '" style="margin-top:1rem"><span class="notice-icon">' + (kind === 'warn' ? '⚠' : 'ℹ') + '</span><div>' + esc(message) + '</div></div>';
    }

    document.getElementById('google-btn').onclick = function () {
      A.signInWithGoogle().catch(function (e) { msg('warn', friendlyError(e)); });
    };
    document.getElementById('email-action').onclick = function () {
      var email = val('email'), password = val('password');
      if (!email || !password) { msg('warn', 'Enter your email and password.'); return; }
      if (creating) {
        var displayName = val('dname');
        if (!displayName) { msg('warn', 'Enter a display name. You can choose Anonymous contributor after creating the account.'); return; }
        if (password.length < 6) { msg('warn', 'Use a password with at least 6 characters.'); return; }
        A.signUpWithEmail(email, password, displayName)
          .then(function () { msg('info', 'Account created. Check your email and verify it before publishing.'); })
          .catch(function (e) { msg('warn', friendlyError(e)); });
      } else {
        A.signInWithEmail(email, password).catch(function (e) { msg('warn', friendlyError(e)); });
      }
    };
    var reset = document.getElementById('reset-btn');
    if (reset) reset.onclick = function () {
      if (!val('email')) { msg('warn', 'Enter your email first.'); return; }
      A.resetPassword(val('email')).then(function () { msg('info', 'Password reset email sent.'); }).catch(function (e) { msg('warn', friendlyError(e)); });
    };
  }

  function renderSignedIn(host, user) {
    updateHeading(true);
    var pref = (A.profile && A.profile.publicNamePreference) || 'username';
    var continueButton = user.emailVerified && next
      ? '<a class="btn btn-primary" href="' + esc(next) + '">Continue your submission →</a>'
      : '<a class="btn btn-secondary" href="/submit.html">Submit data</a>';
    host.innerHTML =
      '<div class="card auth-signed-in">' +
        '<h3>Signed in</h3>' +
        (user.emailVerified ? '<div class="chip current" style="margin-bottom:1rem"><span class="chip-icon">◉</span> Email verified</div>'
          : '<div class="notice warn" style="margin-bottom:1rem"><span class="notice-icon">📧</span><div><strong>One step left:</strong> verify your email to publish. <button class="btn btn-outline btn-sm" id="resend">Resend verification</button></div></div>') +
        (user.emailVerified && next ? '<p class="muted">Your saved form is ready. Continue to return to it.</p>' : '') +
        '<div class="field"><label for="pubname">Public display name</label><input id="pubname" value="' + esc((A.profile && A.profile.displayName) || '') + '"></div>' +
        '<div class="field"><label for="pubpref">Show my name as</label><select id="pubpref">' +
          '<option value="username"' + (pref === 'username' ? ' selected' : '') + '>My display name</option>' +
          '<option value="anonymous"' + (pref === 'anonymous' ? ' selected' : '') + '>Anonymous contributor</option></select></div>' +
        '<div class="auth-account-actions"><button class="btn btn-outline" id="save-name">Save profile</button>' +
        continueButton +
        '<button class="btn btn-ghost" id="signout">Sign out</button></div>' +
        '<div id="acct-status" role="status" aria-live="polite"></div>' +
      '</div>';
    var resend = document.getElementById('resend');
    if (resend) resend.onclick = function () {
      A.sendVerification().then(function () { resend.textContent = 'Sent'; }).catch(function () { resend.textContent = 'Try again'; });
    };
    document.getElementById('save-name').onclick = function () {
      A.updatePublicName(val('pubname'), val('pubpref')).then(function () { document.getElementById('acct-status').innerHTML = '<p class="field-hint" style="margin-top:.6rem">Saved.</p>'; });
    };
    document.getElementById('signout').onclick = function () { A.signOut(); location.reload(); };
  }

  function setMode(nextMode, host) {
    mode = nextMode;
    var url = new URL(location.href);
    if (mode === 'create') url.searchParams.set('mode', 'create');
    else url.searchParams.delete('mode');
    history.replaceState(null, '', url.pathname + url.search);
    render(host);
  }

  function updateHeading(signedIn) {
    var title = document.getElementById('auth-title');
    var lede = document.getElementById('auth-lede');
    if (signedIn) {
      if (title) title.textContent = 'Contributor account';
      if (lede) lede.textContent = next ? 'Your submission is saved and ready when your email is verified.' : 'Manage your public contributor name and account.';
      return;
    }
    if (title) title.textContent = mode === 'create' ? 'Create a contributor account' : 'Sign in to contribute';
    if (lede) lede.textContent = mode === 'create'
      ? 'Create a free account with Google or email. Email verification protects the public database from spam.'
      : 'Browsing needs no account. Sign in with a verified email to add a department or update salary information.';
  }

  function safeNext(value) {
    if (!value || value.charAt(0) !== '/' || value.slice(0, 2) === '//') return '';
    return value;
  }
  function friendlyError(e) {
    var code = (e && e.code) || '';
    if (code.indexOf('wrong-password') !== -1 || code.indexOf('invalid-credential') !== -1) return 'That email and password did not match.';
    if (code.indexOf('email-already-in-use') !== -1) return 'An account already uses that email. Choose Sign in instead.';
    if (code.indexOf('weak-password') !== -1) return 'Use a password with at least 6 characters.';
    return (e && e.message) || 'Something went wrong. Please try again.';
  }
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
})();
