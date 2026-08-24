/* ===========================================================================
   sp-api.js — Supabase auth + data access with no SDK and no CDN.
   Plain fetch against the Auth and PostgREST endpoints. Exposes window.SP.

   Why no SDK: this runs in a call center. One less thing that can fail to
   load, and the whole data layer stays readable in one file.
=========================================================================== */
(function () {
  "use strict";

  var URL_BASE = (window.SP_URL || "").replace(/\/+$/, "");
  var ANON = window.SP_ANON_KEY || "";
  var SESSION_KEY = "sp.academy.session";
  var PKCE_KEY = "sp.academy.pkce";

  var configured = /^https:\/\/.+\.supabase\.co$/.test(URL_BASE) &&
                   ANON.length > 20 &&
                   ANON.indexOf("YOUR-") !== 0;

  var session = null;
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { session = null; }

  function saveSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* private mode — session lives in memory only */ }
  }

  function adopt(data) {
    saveSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at || (Math.floor(Date.now() / 1000) + (data.expires_in || 3600)),
      user: data.user || (session && session.user) || null
    });
    return session;
  }

  function expired() {
    if (!session || !session.expires_at) return true;
    return (session.expires_at * 1000) - Date.now() < 60000; /* refresh a minute early */
  }

  function authFetch(path, opts) {
    opts = opts || {};
    var headers = Object.assign({
      "apikey": ANON,
      "Content-Type": "application/json"
    }, opts.headers || {});
    if (session && session.access_token) {
      headers["Authorization"] = "Bearer " + session.access_token;
    }
    return fetch(URL_BASE + path, Object.assign({}, opts, { headers: headers }));
  }

  function readError(res) {
    return res.text().then(function (t) {
      var msg = t;
      try {
        var j = JSON.parse(t);
        msg = j.error_description || j.msg || j.message || j.error || j.hint || t;
      } catch (e) { /* plain text */ }
      var err = new Error(msg || ("Request failed (" + res.status + ")"));
      err.status = res.status;
      return Promise.reject(err);
    });
  }

  /* Rejections from the domain-lock trigger come back wrapped in whatever
     GoTrue felt like saying. Turn them into something a rep can act on. */
  function friendlyAuthError(raw) {
    var m = String(raw || "");
    if (/database error saving new user|only .* accounts can use|42501/i.test(m)) {
      return "That account isn't a Service Professionals account. " +
             "Sign in with your @service-professionals.com Google account.";
    }
    if (/access_denied|user cancelled|consent required/i.test(m)) {
      return "Sign-in was cancelled.";
    }
    return m;
  }

  /* ------------------------------------------------------- google sign-in --- */

  function b64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function makeVerifier() {
    var a = new Uint8Array(48);
    (window.crypto || {}).getRandomValues
      ? window.crypto.getRandomValues(a)
      : (function () { for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); })();
    return b64url(a);
  }

  function challengeFor(verifier) {
    var subtle = window.crypto && window.crypto.subtle;
    if (!subtle || !window.TextEncoder) {
      /* http://localhost or an ancient browser — GoTrue accepts the plain method */
      return Promise.resolve({ challenge: verifier, method: "plain" });
    }
    return subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(function (buf) {
      return { challenge: b64url(new Uint8Array(buf)), method: "s256" };
    }, function () {
      return { challenge: verifier, method: "plain" };
    });
  }

  function redirectTarget() {
    return location.origin + location.pathname.replace(/[^/]*$/, "") + "index.html";
  }

  /* Sends the browser to Google. Comes back to index.html either with tokens in
     the URL fragment (implicit) or ?code= (PKCE) — finishSignIn handles both. */
  function signInWithGoogle() {
    if (!configured) return Promise.reject(new Error("This site is not connected to Supabase yet. See assets/sp-config.js."));
    var verifier = makeVerifier();
    return challengeFor(verifier).then(function (c) {
      try { localStorage.setItem(PKCE_KEY, verifier); } catch (e) { /* memory only; implicit still works */ }
      var u = URL_BASE + "/auth/v1/authorize?provider=google" +
        "&redirect_to=" + encodeURIComponent(redirectTarget()) +
        "&code_challenge=" + encodeURIComponent(c.challenge) +
        "&code_challenge_method=" + c.method;
      location.href = u;
    });
  }

  function exchangeCode(code) {
    var verifier = null;
    try { verifier = localStorage.getItem(PKCE_KEY); } catch (e) { /* nothing stored */ }
    if (!verifier) {
      return Promise.reject(new Error(
        "This sign-in link was started in a different browser. Go back to the sign-in page and try again."));
    }
    return fetch(URL_BASE + "/auth/v1/token?grant_type=pkce", {
      method: "POST",
      headers: { "apikey": ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ auth_code: code, code_verifier: verifier })
    }).then(function (res) {
      if (!res.ok) return readError(res);
      return res.json();
    }).then(function (data) {
      try { localStorage.removeItem(PKCE_KEY); } catch (e) {}
      return adopt(data);
    });
  }

  /* ------------------------------------------------------ the callback ----- */
  /* Everything that can arrive back at index.html, named honestly:
       {kind:"recovery"}  password-reset link — show the new-password pane
       {kind:"signedin"}  a session was established
       {kind:"error", message}
       {kind:"none"}      an ordinary visit
     D3 in the PRD: the OAuth response shape was unconfirmed. Rather than
     guessing, this reads whichever shape actually arrives, and says so plainly
     if it is neither. */
  function finishSignIn() {
    var hash = new URLSearchParams((location.hash || "").replace(/^#/, ""));
    var query = new URLSearchParams(location.search || "");
    var clean = function () {
      if (history.replaceState) history.replaceState(null, "", location.pathname);
    };

    var err = hash.get("error_description") || hash.get("error") ||
              query.get("error_description") || query.get("error");
    if (err) {
      clean();
      return Promise.resolve({ kind: "error", message: friendlyAuthError(err) });
    }

    /* A password-reset link, and ONLY a password-reset link, gets the
       choose-a-new-password screen. Anything else carrying tokens is a normal
       sign-in. (PRD defect D1: this used to catch every token callback.) */
    var isRecovery = hash.get("type") === "recovery" || query.get("type") === "recovery";

    var at = hash.get("access_token");
    if (at) {
      saveSession({
        access_token: at,
        refresh_token: hash.get("refresh_token"),
        expires_at: Math.floor(Date.now() / 1000) + parseInt(hash.get("expires_in") || "3600", 10),
        user: null
      });
      clean();
      return Promise.resolve({ kind: isRecovery ? "recovery" : "signedin" });
    }

    var code = query.get("code");
    if (code) {
      return exchangeCode(code).then(function () {
        clean();
        return { kind: isRecovery ? "recovery" : "signedin" };
      }, function (e) {
        clean();
        return { kind: "error", message: friendlyAuthError(e.message) };
      });
    }

    /* Came back from the provider with neither shape — say so rather than
       sitting on a blank screen. */
    if (query.get("provider") || hash.get("provider_token") || /from=oauth/.test(location.search)) {
      clean();
      return Promise.resolve({ kind: "error", message: "Sign-in came back in an unexpected shape. Tell Lauren, and try email sign-in for now." });
    }

    return Promise.resolve({ kind: "none" });
  }

  /* ---------------------------------------------------------------- auth --- */

  function signIn(email, password) {
    if (!configured) return Promise.reject(new Error("This site is not connected to Supabase yet. See assets/sp-config.js."));
    return fetch(URL_BASE + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { "apikey": ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email: String(email || "").trim(), password: password || "" })
    }).then(function (res) {
      if (!res.ok) return readError(res);
      return res.json();
    }).then(function (data) {
      adopt(data);
      return loadProfile();
    });
  }

  function refresh() {
    if (!session || !session.refresh_token) return Promise.reject(new Error("No session"));
    return fetch(URL_BASE + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: { "apikey": ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    }).then(function (res) {
      if (!res.ok) { saveSession(null); return readError(res); }
      return res.json();
    }).then(adopt);
  }

  /* Every data call goes through here so an expired token refreshes silently. */
  function ready() {
    if (!configured || !session) return Promise.reject(new Error("Not signed in"));
    if (!expired()) return Promise.resolve(session);
    return refresh();
  }

  function signOut() {
    var done = function () {
      saveSession(null);
      profile = null;
      try { localStorage.removeItem(PKCE_KEY); } catch (e) {}
    };
    if (!session) { done(); return Promise.resolve(); }
    return authFetch("/auth/v1/logout", { method: "POST" }).then(done, done);
  }

  function requestPasswordReset(email) {
    if (!configured) return Promise.reject(new Error("Not connected to Supabase yet."));
    return fetch(URL_BASE + "/auth/v1/recover", {
      method: "POST",
      headers: { "apikey": ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email: String(email || "").trim(), gotrue_meta_security: {} })
    }).then(function (res) { return res.ok ? true : readError(res); });
  }

  function setPassword(newPassword) {
    return ready().then(function () {
      return authFetch("/auth/v1/user", {
        method: "PUT",
        body: JSON.stringify({ password: newPassword })
      });
    }).then(function (res) { return res.ok ? true : readError(res); });
  }

  function userId() {
    if (session && session.user && session.user.id) return session.user.id;
    /* fall back to the "sub" claim in the JWT — an implicit-flow callback
       hands over tokens without a user object */
    try {
      var payload = JSON.parse(atob(session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return payload.sub;
    } catch (e) { return null; }
  }

  function loadUser() {
    if (session && session.user) return Promise.resolve(session.user);
    return ready().then(function () {
      return authFetch("/auth/v1/user");
    }).then(function (res) {
      if (!res.ok) return readError(res);
      return res.json();
    }).then(function (u) {
      if (session) { session.user = u; saveSession(session); }
      return u;
    });
  }

  /* ------------------------------------------------------------- profile --- */

  var profile = null;

  function loadProfile() {
    return ready().then(function () {
      return authFetch("/rest/v1/profiles?select=*&id=eq." + encodeURIComponent(userId()));
    }).then(function (res) {
      if (!res.ok) return readError(res);
      return res.json();
    }).then(function (rows) {
      profile = rows && rows[0] ? rows[0] : null;
      /* first Google sign-in: the row exists but the name may not have landed */
      if (profile && !profile.full_name) {
        return loadUser().then(function (u) {
          var meta = (u && u.user_metadata) || {};
          var name = meta.full_name || meta.name || "";
          if (!name) return profile;
          return saveFullName(name).then(function () {
            profile.full_name = name;
            return profile;
          }, function () { return profile; });
        }, function () { return profile; });
      }
      return profile;
    });
  }

  function saveFullName(name) {
    return ready().then(function () {
      return authFetch("/rest/v1/profiles?id=eq." + encodeURIComponent(userId()), {
        method: "PATCH",
        headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({ full_name: name })
      });
    }).then(function (res) { return res.ok ? true : readError(res); });
  }

  /* ------------------------------------------------------------ progress --- */

  function getJson(path) {
    return ready().then(function () {
      return authFetch(path);
    }).then(function (res) {
      if (!res.ok) return readError(res);
      return res.json();
    });
  }

  var PROGRESS_COLS = "day,answers,filled,total,rep_done,updated_at";

  /** All of this rep's days: [{day, answers, filled, total, rep_done, updated_at}] */
  function loadMyProgress() {
    return getJson("/rest/v1/progress?select=" + PROGRESS_COLS +
      "&user_id=eq." + encodeURIComponent(userId()) + "&order=day.asc");
  }

  /** Upsert one day. Whole-day write, so it is idempotent and conflict-free. */
  function saveDay(day, answers, filled, total, repDone) {
    return ready().then(function () {
      return authFetch("/rest/v1/progress?on_conflict=user_id,day", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          user_id: userId(),
          day: day,
          answers: answers,
          filled: filled,
          total: total,
          rep_done: !!repDone
        })
      });
    }).then(function (res) { return res.ok ? true : readError(res); });
  }

  /* -------------------------------------------------------------- drills --- */

  var DRILL_COLS = "day,drill_id,drill_kind,drill_title,score,max_score,detail,attempt_no,attempted_at";

  /** Record one attempt. Insert-only: nothing overwrites an earlier score. */
  function saveDrillAttempt(a) {
    return ready().then(function () {
      return authFetch("/rest/v1/drill_attempts", {
        method: "POST",
        headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({
          user_id: userId(),
          day: a.day,
          drill_id: a.drillId,
          drill_kind: a.kind,
          drill_title: a.title || "",
          score: a.score,
          max_score: a.maxScore,
          detail: a.detail || {}
        })
      });
    }).then(function (res) { return res.ok ? true : readError(res); });
  }

  function loadMyDrillAttempts() {
    return loadDrillAttempts(userId());
  }

  function loadDrillAttempts(repId) {
    return getJson("/rest/v1/drill_attempts?select=" + DRILL_COLS +
      "&user_id=eq." + encodeURIComponent(repId) + "&order=day.asc,drill_id.asc,attempt_no.asc");
  }

  function loadDrillDifficulty() {
    return getJson("/rest/v1/drill_difficulty?select=*&order=avg_pct.asc");
  }

  function loadDayCompletion() {
    return getJson("/rest/v1/day_completion?select=*&order=day.asc");
  }

  /* -------------------------------------------------------- manager side --- */

  function isManager() { return !!(profile && profile.role === "manager"); }

  function loadOverview() {
    return getJson("/rest/v1/rep_overview?select=*&order=full_name.asc");
  }

  function loadRepProgress(repId) {
    return getJson("/rest/v1/progress?select=" + PROGRESS_COLS +
      "&user_id=eq." + encodeURIComponent(repId) + "&order=day.asc");
  }

  function loadSignoffs(repId) {
    return getJson("/rest/v1/signoffs?select=*&user_id=eq." + encodeURIComponent(repId) + "&order=day.asc");
  }

  function saveSignoff(repId, day, notes, readyForLiveCalls) {
    return ready().then(function () {
      var row = {
        user_id: repId,
        day: day,
        signed_by: userId(),
        notes: notes || "",
        signed_at: new Date().toISOString()
      };
      if (day === 5) row.ready_for_live_calls = !!readyForLiveCalls;
      return authFetch("/rest/v1/signoffs?on_conflict=user_id,day", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(row)
      });
    }).then(function (res) { return res.ok ? true : readError(res); });
  }

  /* ---------------------------------------------------------- people admin - */
  /* Everyone, including managers and deactivated people — the roster view
     deliberately shows only active reps. */
  function loadPeople() {
    return getJson("/rest/v1/profiles?select=id,full_name,email,role,cohort,started_on,active,created_at" +
      "&order=active.desc,full_name.asc");
  }

  /** patch: any of {role, cohort, started_on, active, full_name} */
  function updatePerson(id, patch) {
    return ready().then(function () {
      return authFetch("/rest/v1/profiles?id=eq." + encodeURIComponent(id), {
        method: "PATCH",
        headers: { "Prefer": "return=minimal" },
        body: JSON.stringify(patch)
      });
    }).then(function (res) { return res.ok ? true : readError(res); });
  }

  /* ---------------------------------------------------------------- api ---- */

  window.SP = {
    configured: function () { return configured; },
    session: function () { return session; },
    signedIn: function () { return !!session; },
    userId: userId,
    profile: function () { return profile; },
    isManager: isManager,

    signIn: signIn,
    signInWithGoogle: signInWithGoogle,
    finishSignIn: finishSignIn,
    signOut: signOut,
    requestPasswordReset: requestPasswordReset,
    setPassword: setPassword,

    loadUser: loadUser,
    loadProfile: loadProfile,
    saveFullName: saveFullName,

    loadMyProgress: loadMyProgress,
    saveDay: saveDay,

    saveDrillAttempt: saveDrillAttempt,
    loadMyDrillAttempts: loadMyDrillAttempts,
    loadDrillAttempts: loadDrillAttempts,
    loadDrillDifficulty: loadDrillDifficulty,
    loadDayCompletion: loadDayCompletion,

    loadOverview: loadOverview,
    loadRepProgress: loadRepProgress,
    loadSignoffs: loadSignoffs,
    saveSignoff: saveSignoff,

    loadPeople: loadPeople,
    updatePerson: updatePerson
  };
})();
