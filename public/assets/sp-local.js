/* ===========================================================================
   sp-local.js — the whole application, running on this computer only.

   Loaded AFTER sp-api.js. If sp-config.js has real Supabase values, sp-api.js
   has already configured itself and this file stands down completely. If it
   doesn't, this replaces window.SP with an implementation backed by
   localStorage that answers every call with the same shapes Supabase returns.

   That is the point: book.html and dashboard.html contain no local-mode code
   paths. They talk to window.SP either way. Migrating means pasting the project
   URL and anon key into sp-config.js — nothing in the pages changes.

   WHAT LOCAL MODE IS NOT
   ----------------------
   Everything lives in one browser on one machine. Progress does not follow a
   rep to another computer, and clearing site data erases it. The manager-only
   rules here are enforced by the interface, not by a database, so they are a
   convention rather than a security boundary. Both of those are exactly what
   the Supabase phase fixes. Use this to get the curriculum and the dashboard
   right, not to run a cohort.

   Use "Export everything" on the dashboard before you close the laptop on
   anything you'd mind losing.
=========================================================================== */
(function () {
  "use strict";

  /* Real Supabase config present? Then there is nothing for us to do. */
  if (window.SP && typeof window.SP.configured === "function" && window.SP.configured()) return;

  var KEY = "sp.academy.local.v1";
  var db = null;

  /* ------------------------------------------------------------- storage --- */

  function blank() {
    return {
      people: [],            /* profile rows */
      progress: {},          /* userId -> { day -> progress row } */
      drills: [],            /* drill attempt rows, append-only */
      signoffs: {},          /* userId -> { day -> signoff row } */
      sessionUserId: null
    };
  }

  function load() {
    if (db) return db;
    try {
      db = JSON.parse(localStorage.getItem(KEY) || "null") || blank();
    } catch (e) {
      db = blank();
    }
    /* tolerate a half-written or hand-edited file */
    if (!Array.isArray(db.people)) db.people = [];
    if (!Array.isArray(db.drills)) db.drills = [];
    if (!db.progress || typeof db.progress !== "object") db.progress = {};
    if (!db.signoffs || typeof db.signoffs !== "object") db.signoffs = {};
    return db;
  }

  var writeFailed = false;
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
      writeFailed = false;
    } catch (e) {
      writeFailed = true;
      return Promise.reject(new Error(
        "This browser refused to save — it may be full, or in private mode. " +
        "Export your data before you lose it."));
    }
    return Promise.resolve(true);
  }

  /* Every method returns a promise, like the real one, so callers that chain
     .then() behave identically. */
  function ok(v) { return Promise.resolve(v); }
  function no(msg) { return Promise.reject(new Error(msg)); }

  function newId() {
    var a = new Uint8Array(8);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
    else for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    var s = "";
    for (var j = 0; j < a.length; j++) s += ("0" + a[j].toString(16)).slice(-2);
    return "local-" + s;
  }

  function nowIso() { return new Date().toISOString(); }

  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  /* --------------------------------------------------------------- people -- */

  function personById(id) {
    load();
    for (var i = 0; i < db.people.length; i++) if (db.people[i].id === id) return db.people[i];
    return null;
  }

  function me() { return personById(load().sessionUserId); }

  function makePerson(name, role) {
    load();
    var p = {
      id: newId(),
      full_name: String(name || "").trim(),
      email: "",
      role: role === "manager" ? "manager" : "rep",
      cohort: null,
      started_on: null,
      active: true,
      created_at: nowIso()
    };
    db.people.push(p);
    return save().then(function () { return clone(p); });
  }

  /* ------------------------------------------------------------- progress -- */

  function progressFor(userId) {
    load();
    var byDay = db.progress[userId] || {};
    return Object.keys(byDay)
      .map(function (d) { return byDay[d]; })
      .sort(function (a, b) { return a.day - b.day; });
  }

  /* --------------------------------------------------------------- drills -- */

  function drillsFor(userId) {
    return load().drills.filter(function (r) { return r.user_id === userId; });
  }

  function activeReps() {
    return load().people.filter(function (p) { return p.role === "rep" && p.active; });
  }

  function pctOfAttempt(r) {
    return r.max_score ? (100 * r.score / r.max_score) : 0;
  }

  /* ------------------------------------------------------------- the view -- */
  /* Mirrors public.rep_overview. Kept deliberately close to the SQL so that a
     difference between local and hosted shows up as a bug in one of them
     rather than as two features that were never the same. */
  function repOverview() {
    return activeReps().map(function (p) {
      var rows = progressFor(p.id);
      var filled = 0, total = 0, daysDone = 0, last = null;
      rows.forEach(function (r) {
        filled += r.filled || 0;
        total += r.total || 0;
        if (r.rep_done) daysDone++;
        if (!last || r.updated_at > last) last = r.updated_at;
      });

      var signByDay = (load().signoffs[p.id]) || {};
      var signedDays = Object.keys(signByDay);
      var cleared = signedDays.some(function (d) {
        return Number(d) === 5 && signByDay[d].ready_for_live_calls;
      });

      var best = {};
      drillsFor(p.id).forEach(function (r) {
        var v = pctOfAttempt(r);
        if (best[r.drill_id] == null || v > best[r.drill_id]) best[r.drill_id] = v;
      });
      var ids = Object.keys(best);
      var avgBest = ids.length
        ? Math.round(ids.reduce(function (a, k) { return a + best[k]; }, 0) / ids.length)
        : null;

      return {
        id: p.id,
        full_name: p.full_name,
        email: p.email,
        cohort: p.cohort,
        started_on: p.started_on,
        filled: filled,
        total: total,
        pct: total ? Math.round(100 * filled / total) : 0,
        days_rep_done: daysDone,
        days_signed_off: signedDays.length,
        cleared_for_live_calls: !!cleared,
        last_active: last,
        drills_attempted: ids.length,
        avg_best_pct: avgBest
      };
    }).sort(function (a, b) {
      return String(a.full_name || "").localeCompare(String(b.full_name || ""));
    });
  }

  /* Mirrors public.drill_difficulty. */
  function drillDifficulty() {
    var repIds = {};
    activeReps().forEach(function (p) { repIds[p.id] = true; });
    var rows = load().drills.filter(function (r) { return repIds[r.user_id]; });

    var byDrill = {};
    rows.forEach(function (r) {
      var g = byDrill[r.drill_id] || (byDrill[r.drill_id] = { rows: [], best: {} });
      g.rows.push(r);
      var v = pctOfAttempt(r);
      if (g.best[r.user_id] == null || v > g.best[r.user_id]) g.best[r.user_id] = v;
    });

    return Object.keys(byDrill).map(function (id) {
      var g = byDrill[id];
      var pcts = g.rows.map(pctOfAttempt);
      var first = g.rows.filter(function (r) { return r.attempt_no === 1; }).map(pctOfAttempt);
      var bestVals = Object.keys(g.best).map(function (k) { return g.best[k]; });
      var mean = function (a) {
        return a.length ? Math.round(a.reduce(function (x, y) { return x + y; }, 0) / a.length) : null;
      };
      var users = {};
      g.rows.forEach(function (r) { users[r.user_id] = true; });
      return {
        drill_id: id,
        day: Math.min.apply(null, g.rows.map(function (r) { return r.day; })),
        drill_kind: g.rows[0].drill_kind,
        drill_title: g.rows[0].drill_title,
        attempts: g.rows.length,
        reps: Object.keys(users).length,
        avg_pct: mean(pcts),
        first_try_pct: mean(first),
        fail_rate: Math.round(100 * pcts.filter(function (v) { return v < 80; }).length / pcts.length),
        avg_best_pct: mean(bestVals)
      };
    }).sort(function (a, b) { return a.avg_pct - b.avg_pct; });
  }

  /* Mirrors public.day_completion. */
  function dayCompletion() {
    var byDay = {};
    activeReps().forEach(function (p) {
      progressFor(p.id).forEach(function (r) {
        var g = byDay[r.day] || (byDay[r.day] = { started: 0, done: 0, pcts: [] });
        g.started++;
        if (r.rep_done) g.done++;
        g.pcts.push(r.total ? 100 * r.filled / r.total : 0);
      });
    });
    return Object.keys(byDay).map(Number).sort(function (a, b) { return a - b; }).map(function (d) {
      var g = byDay[d];
      return {
        day: d,
        reps_started: g.started,
        reps_done: g.done,
        avg_pct: Math.round(g.pcts.reduce(function (x, y) { return x + y; }, 0) / g.pcts.length)
      };
    });
  }

  /* ------------------------------------------------------ export / import -- */

  function exportAll() {
    return JSON.stringify({
      format: "sp-academy-local",
      version: 1,
      exported_at: nowIso(),
      data: load()
    }, null, 2);
  }

  /* Replaces everything. Refuses anything that isn't one of our own exports,
     rather than half-loading it and leaving a mess behind. */
  function importAll(text) {
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { return no("That file isn't valid JSON."); }
    if (!parsed || parsed.format !== "sp-academy-local" || !parsed.data) {
      return no("That doesn't look like an academy export.");
    }
    var d = parsed.data;
    if (!Array.isArray(d.people) || !Array.isArray(d.drills)) {
      return no("That export is missing its people or drill records.");
    }
    db = {
      people: d.people,
      progress: d.progress || {},
      drills: d.drills,
      signoffs: d.signoffs || {},
      sessionUserId: null      /* always sign in again after an import */
    };
    return save().then(function () { return db.people.length; });
  }

  /* ------------------------------------------------------------------ api -- */

  var profile = null;

  function requireSession() {
    var p = me();
    if (!p) return no("Not signed in");
    return ok(p);
  }

  window.SP = {
    /* --- identity of the backend itself --- */
    configured: function () { return true; },
    isLocal: function () { return true; },
    storeLabel: function () { return "this computer"; },
    savedLabel: function () { return "Saved on this computer"; },
    writeFailed: function () { return writeFailed; },

    /* --- session --- */
    session: function () {
      var p = me();
      return p ? { user: { id: p.id, email: p.email }, local: true } : null;
    },
    signedIn: function () { return !!me(); },
    userId: function () { return load().sessionUserId; },
    profile: function () { return profile; },
    isManager: function () { return !!(profile && profile.role === "manager"); },

    /* Local sign-in is "say who you are". There is no password because there
       is nothing here to protect that a person with this laptop doesn't
       already have. Real identity arrives with Google in the next phase. */
    listPeople: function () {
      return ok(clone(load().people.filter(function (p) { return p.active; })));
    },
    createPerson: function (name, role) { return makePerson(name, role); },
    signInAs: function (id) {
      var p = personById(id);
      if (!p) return no("That person is no longer on this computer.");
      load().sessionUserId = id;
      return save().then(function () { return window.SP.loadProfile(); });
    },
    signOut: function () {
      load().sessionUserId = null;
      profile = null;
      return save().then(function () { return true; }, function () { return true; });
    },

    /* Present so the pages don't need to branch. Nothing here uses them. */
    signIn: function () { return no("Local mode signs in by picking your name."); },
    signInWithGoogle: function () { return no("Google sign-in arrives with the Supabase phase."); },
    finishSignIn: function () { return ok({ kind: "none" }); },
    requestPasswordReset: function () { return no("There are no passwords in local mode."); },
    setPassword: function () { return no("There are no passwords in local mode."); },
    loadUser: function () { return requireSession(); },

    /* --- profile --- */
    loadProfile: function () {
      var p = me();
      profile = p ? clone(p) : null;
      return ok(profile);
    },
    saveFullName: function (name) {
      var p = me();
      if (!p) return no("Not signed in");
      p.full_name = String(name || "").trim();
      if (profile) profile.full_name = p.full_name;
      return save();
    },

    /* --- progress --- */
    loadMyProgress: function () {
      var p = me();
      if (!p) return no("Not signed in");
      return ok(clone(progressFor(p.id)));
    },
    saveDay: function (day, answers, filled, total, repDone) {
      var p = me();
      if (!p) return no("Not signed in");
      var byDay = db.progress[p.id] || (db.progress[p.id] = {});
      byDay[day] = {
        day: day,
        answers: clone(answers) || {},
        filled: filled || 0,
        total: total || 0,
        rep_done: !!repDone,
        updated_at: nowIso()
      };
      return save();
    },

    /* --- drills --- */
    saveDrillAttempt: function (a) {
      var p = me();
      if (!p) return no("Not signed in");
      var prior = db.drills.filter(function (r) {
        return r.user_id === p.id && r.drill_id === a.drillId;
      });
      db.drills.push({
        user_id: p.id,
        day: a.day,
        drill_id: a.drillId,
        drill_kind: a.kind,
        drill_title: a.title || "",
        score: a.score,
        max_score: a.maxScore,
        detail: clone(a.detail) || {},
        attempt_no: prior.length + 1,
        attempted_at: nowIso()
      });
      return save();
    },
    loadMyDrillAttempts: function () {
      var p = me();
      if (!p) return no("Not signed in");
      return window.SP.loadDrillAttempts(p.id);
    },
    loadDrillAttempts: function (repId) {
      return ok(clone(drillsFor(repId).sort(function (a, b) {
        return a.day - b.day ||
               String(a.drill_id).localeCompare(String(b.drill_id)) ||
               a.attempt_no - b.attempt_no;
      })));
    },
    loadDrillDifficulty: function () { return ok(drillDifficulty()); },
    loadDayCompletion: function () { return ok(dayCompletion()); },

    /* --- manager side --- */
    loadOverview: function () { return ok(repOverview()); },
    loadRepProgress: function (repId) { return ok(clone(progressFor(repId))); },
    loadSignoffs: function (repId) {
      var byDay = load().signoffs[repId] || {};
      return ok(clone(Object.keys(byDay).map(function (d) { return byDay[d]; })
        .sort(function (a, b) { return a.day - b.day; })));
    },
    saveSignoff: function (repId, day, notes, readyForLiveCalls) {
      var p = me();
      if (!p) return no("Not signed in");
      if (p.role !== "manager") return no("Only a manager can sign off a day.");
      var byDay = db.signoffs[repId] || (db.signoffs[repId] = {});
      var row = {
        user_id: repId,
        day: day,
        signed_by: p.id,
        signed_at: nowIso(),
        notes: notes || "",
        ready_for_live_calls: byDay[day] ? byDay[day].ready_for_live_calls : null
      };
      if (day === 5) row.ready_for_live_calls = !!readyForLiveCalls;
      byDay[day] = row;
      return save();
    },

    /* --- people admin --- */
    loadPeople: function () {
      return ok(clone(load().people.slice().sort(function (a, b) {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return String(a.full_name || "").localeCompare(String(b.full_name || ""));
      })));
    },
    updatePerson: function (id, patch) {
      var p = personById(id);
      if (!p) return no("No such person on this computer.");
      var caller = me();
      if (!caller || caller.role !== "manager") return no("Only a manager can change this.");
      ["full_name", "role", "cohort", "started_on", "active", "email"].forEach(function (f) {
        if (Object.prototype.hasOwnProperty.call(patch, f)) p[f] = patch[f];
      });
      if (profile && profile.id === id) profile = clone(p);
      return save();
    },

    /* --- local only --- */
    exportAll: exportAll,
    importAll: importAll,
    stats: function () {
      var d = load();
      return {
        people: d.people.length,
        drills: d.drills.length,
        days: Object.keys(d.progress).reduce(function (a, u) {
          return a + Object.keys(d.progress[u]).length;
        }, 0)
      };
    }
  };
})();
