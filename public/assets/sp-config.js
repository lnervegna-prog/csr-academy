/* ---------------------------------------------------------------------------
   Two values decide which mode the academy runs in.

   LEFT AS THEY ARE  →  LOCAL MODE.
     Everything saves to this browser, on this computer. No accounts, no
     network, nothing to set up — open public/index.html and start. This is the
     mode for getting the curriculum and the dashboard right.

     Local mode is not a rollout. Progress does not follow a rep to another
     computer, and clearing site data erases it. The manager-only rules are
     enforced by the interface rather than a database, so they are a convention,
     not a security boundary.

   FILLED IN         →  HOSTED MODE.
     Google sign-in, one shared database, real Row Level Security. Nothing else
     in the project changes: assets/sp-local.js stands down the moment these
     values are real, and every page carries on talking to the same window.SP.

   Supabase Studio > Project Settings > Data API
     SP_URL      = "Project URL"        e.g. https://abcdefgh.supabase.co
     SP_ANON_KEY = "anon public" key    (the long one labelled anon / public)

   The anon key is MEANT to be public — it ships in every Supabase web app and
   is safe in a browser. Row Level Security in schema.sql is what protects the
   data, not this key.

   Two key formats exist and both work here: the legacy anon JWT starting
   "eyJ...", and the newer publishable key starting "sb_publishable_...".
   They go in the same place and are sent the same way.

   NEVER put the "service_role" (or "secret") key in this file. That one
   bypasses every security policy. If it ever lands here, rotate it in
   Supabase immediately.
--------------------------------------------------------------------------- */
window.SP_URL = "https://ctcxaoqyscmmavsdiikc.supabase.co";
window.SP_ANON_KEY = "sb_publishable_HqLS9crnL1CEbXNLxDLf6Q_LQOfTG_S";
