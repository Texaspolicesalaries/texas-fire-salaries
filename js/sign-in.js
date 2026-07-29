/*
 * sign-in.js — Auth page. Google + email/password, email-verification prompt,
 * and the public-name preference (username vs "Anonymous contributor").
 * Emails are never displayed publicly.
 */
(function () {
  'use strict';
  var A = window.FireAuth;

  document.addEventListener('DOMContentLoaded', function () {
    var host = document.getElementById('auth-body');
    if (!host) return;

    if (!window.FireDB || !window.FireDB.configured) {
      // Wait for readiness state, then show config notice if still unconfigured.
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
    host.innerHTML =
      '<div class="stack">' +
        '<button class="btn btn-outline btn-block btn-lg" id="google-btn">Continue with Google</button>' +
        '<div class="divider-label">or</div>' +
        '<div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="email"></div>' +
        '<div class="field"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password"></div>' +
        '<div id="name-field" class="field" style="display:none"><label for="dname">Display name</label><input id="dname" placeholder="How you\'ll appear (or choose Anonymous later)"></div>' +
        '<div style="display:flex;gap:.6rem;flex-wrap:wrap">' +
          '<button class="btn btn-primary" id="signin-btn">Sign in</button>' +
          '<button class="btn btn-secondary" id="signup-btn">Create account</button>' +
          '<button class="btn btn-ghost btn-sm" id="reset-btn">Forgot password</button>' +
        '</div>' +
        '<div id="auth-status"></div>' +
      '</div>';
    var status = document.getElementById('auth-status');
    function msg(kind, t) { status.innerHTML = '<div class="notice ' + kind + '" style="margin-top:1rem"><span class="notice-icon">' + (kind === 'warn' ? '⚠' : 'ℹ') + '</span><div>' + t + '</div></div>'; }

    document.getElementById('google-btn').onclick = function () { A.signInWithGoogle().catch(function (e) { msg('warn', e.message); }); };
    document.getElementById('signin-btn').onclick = function () {
      A.signInWithEmail(val('email'), val('password')).catch(function (e) { msg('warn', e.message); });
    };
    document.getElementById('signup-btn').onclick = function () {
      document.getElementById('name-field').style.display = 'block';
      if (!val('dname')) { msg('info', 'Enter a display name above, then press Create account again.'); return; }
      A.signUpWithEmail(val('email'), val('password'), val('dname'))
        .then(function () { msg('info', 'Account created — check your email to verify before publishing.'); })
        .catch(function (e) { msg('warn', e.message); });
    };
    document.getElementById('reset-btn').onclick = function () {
      if (!val('email')) { msg('warn', 'Enter your email first.'); return; }
      A.resetPassword(val('email')).then(function () { msg('info', 'Password reset email sent.'); }).catch(function (e) { msg('warn', e.message); });
    };
  }

  function renderSignedIn(host, user) {
    var pref = (A.profile && A.profile.publicNamePreference) || 'username';
    host.innerHTML =
      '<div class="card">' +
        '<h3>Signed in</h3>' +
        (user.emailVerified ? '<div class="chip current" style="margin-bottom:1rem"><span class="chip-icon">◉</span> Email verified</div>'
          : '<div class="notice warn" style="margin-bottom:1rem"><span class="notice-icon">📧</span><div>Verify your email to publish. <button class="btn btn-outline btn-sm" id="resend">Resend</button></div></div>') +
        '<div class="field"><label for="pubname">Public display name</label><input id="pubname" value="' + esc((A.profile && A.profile.displayName) || '') + '"></div>' +
        '<div class="field"><label for="pubpref">Show my name as</label><select id="pubpref">' +
          '<option value="username"' + (pref === 'username' ? ' selected' : '') + '>My display name</option>' +
          '<option value="anonymous"' + (pref === 'anonymous' ? ' selected' : '') + '>Anonymous contributor</option></select></div>' +
        '<div style="display:flex;gap:.6rem;flex-wrap:wrap"><button class="btn btn-primary" id="save-name">Save</button>' +
        '<a class="btn btn-secondary" href="/submit.html">Submit data</a>' +
        '<button class="btn btn-ghost" id="signout">Sign out</button></div>' +
        '<div id="acct-status"></div>' +
      '</div>';
    var resend = document.getElementById('resend'); if (resend) resend.onclick = function () { A.sendVerification().then(function () { resend.textContent = 'Sent'; }); };
    document.getElementById('save-name').onclick = function () {
      A.updatePublicName(val('pubname'), val('pubpref')).then(function () { document.getElementById('acct-status').innerHTML = '<p class="field-hint" style="margin-top:.6rem">Saved.</p>'; });
    };
    document.getElementById('signout').onclick = function () { A.signOut(); location.reload(); };
  }

  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  function esc(s) { return String(s || '').replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
})();
