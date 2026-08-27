# Service Professionals — CSR Academy

The 13-day new-hire training book, with self-service sign-in, progress that follows the
rep to any computer, recorded drill scores, and a manager dashboard.

Spec: [`docs/PRD.md`](docs/PRD.md).

It runs in one of two modes, decided entirely by whether
`public/assets/sp-config.js` has real Supabase values in it:

| | **Local** (now) | **Hosted** (phase two) |
|---|---|---|
| Sign in | pick your name | your work email and a password you choose |
| Storage | this browser, this computer | one shared database |
| Rules | enforced by the interface | enforced by Postgres |
| Setup | none | Supabase + GitHub + Netlify |

Both modes run the *same* book and the *same* dashboard. `sp-local.js` answers
with the shapes Supabase returns, so neither page contains a local-mode code
path, and going hosted is pasting two values into one file.

- `run-local.cmd` — double-click to run the academy on this computer
- `public/index.html` — sign in
- `public/book.html` — the 13-day academy workbook (Days 1–13)
- `public/dashboard.html` — Lauren's view: team progress, what the team fails,
  people admin, and the only place a day gets signed off
- `public/assets/sp-config.js` — the two Supabase values, and the mode switch
- `public/assets/sp-api.js` — hosted backend: auth + data (plain fetch, no SDK)
- `public/assets/sp-local.js` — local backend: the same API over localStorage
- `supabase/schema.sql` — tables, security policies, dashboard views
- `tools/serve.pl` — local dev server; never deployed

---

## Run it on this computer

**Double-click `run-local.cmd`.** A small server window opens and the academy
opens in your browser. Leave that window running; close it when you're done.

First time through: add yourself, leave the role on **Manager**, and you land on
the dashboard. Add the reps from the **People** tab. To work through the book
yourself, sign out and pick a rep.

Nothing is installed — it uses the Perl that came with Git for Windows. If the
window says it can't find `perl.exe`, install
[Git for Windows](https://git-scm.com/download/win) and try again.

**Two things to know about local mode:**

- **It's one browser on one computer.** Progress won't follow anyone to another
  machine, and clearing browser data erases it. Use **Back up everything** on the
  dashboard before you clear anything, and keep the file.
- **The port is part of the address of your data.** `run-local.cmd` always uses
  8791. If you ever run it on a different port, the academy will look empty —
  your work isn't gone, it's filed under the old address. Put the port back, or
  restore from a backup.

Manager-only rules are enforced by the interface here, not a database. That's
fine for getting the thing right; it's the Supabase phase that makes them real.

**Use `run-local.cmd`, not the files directly.** Double-clicking
`public/index.html` opens it as `file://`, where Chrome treats every page as its
own origin. The dashboard then can't read the book through its hidden iframe, so
day titles and whole-book percentages fall back to a cache the book leaves behind
— which only exists once the book has been opened in that browser. There is code
for that fallback and it is the right thing to have, but **the `file://` path has
never actually been run**, so treat it as unproven. `run-local.cmd` serves the
folder over http, which behaves exactly like the hosted site, and is what every
check in this README was done against.

---

## Phase two — going hosted

Nothing below is needed to use the academy locally.

### 1. Supabase

1. Create a project (any region close to NJ — `us-east-1` is good).
2. **SQL Editor → New query** → paste all of `supabase/schema.sql` → **Run**.
   Safe to re-run any time; that is how you apply later changes too.
3. **Project Settings → Data API**: copy **Project URL** and the **anon public**
   key into `public/assets/sp-config.js`.

   The anon key belongs in the browser — that's what it's for. The security is
   in the Row Level Security policies from `schema.sql`, not in hiding the key.
   **Never** put the `service_role` key in this repo; it bypasses every policy.

### 2. Sign-in settings

Reps create their own accounts. There is no user administration: nobody issues
a password, and nobody gets added by hand.

That is only safe because the database refuses anyone else. `enforce_email_domain()`
in `schema.sql` is a trigger on `auth.users` that rejects account creation for any
address outside `service-professionals.com`. Open signup plus a closed door.

In **Supabase → Authentication → Sign In / Providers → Email**:

- **Enable email provider** — on.
- **Allow new users to sign up** — on. This is what lets reps self-serve.
- **Confirm email** — **off**. Supabase's built-in mail sender is rate-limited to
  a handful of messages an hour and is not meant for production, so leaving
  confirmation on means nine reps signing up on a Monday morning hit a wall and
  sit there unable to get in. The domain trigger is the real gate; the
  confirmation email adds delay, not safety.
- **Minimum password length** — set it to 10 to match what the page asks for.

To change which domain is allowed, edit `allowed_email_domain()` at the top of
`schema.sql` and re-run the file.

**Forgotten passwords** go through that same rate-limited sender, so treat the
reset email as best-effort. The reliable fix is for a manager to reset it in
**Supabase → Authentication → Users**, which takes about fifteen seconds. If
resets ever become frequent, point Supabase at your Google Workspace SMTP under
**Project Settings → Auth → SMTP Settings** and the flakiness goes away.

**Wanting Google sign-in later?** The code for it is still in `sp-api.js`
(`signInWithGoogle`, and `finishSignIn` already handles both OAuth response
shapes). Configure the provider in Supabase and put the button back on
`index.html`. Supabase links a Google identity to an existing account when the
verified email matches — worth proving with one test account before trusting it
with everyone's workbook.

### 3. Make yourself the manager

Create your own account in the app first, so the row exists. Then run this **one** query:

```sql
update public.profiles set role = 'manager'
where email = 'lnervegna@service-professionals.com';
```

That is the only SQL anyone should ever need. Every other role, cohort, start
date and active-status change is done from the dashboard's **People** tab.

### 4. GitHub and Netlify

1. Push this folder to a repo in the company org.
2. Netlify → **Add new site → Import an existing project** → pick the repo.
3. Build command: leave empty. Publish directory: `public`.
4. Deploy. Netlify picks up `netlify.toml` automatically.

---

## How it behaves

Written for hosted mode. Locally everything below is the same except how you
sign in and where the data sits — the sidebar says *Saved on this computer*, and
the last sentence of this paragraph is the part that only comes true hosted.

**Reps** click *Create your account*, enter their work email and a password they
pick themselves, and land on the book. Nobody issues a password and nobody adds
them by hand — a profile appears the moment they sign up, and the database turns
away any address outside the company domain. Answers save to their account a second or so after they stop typing;
the sidebar says *Saved to your account*. Closing the laptop mid-Day-6 and
opening a different computer the next morning picks up exactly where they were.

**Offline is safe.** Every answer is also written to the browser as a cache. If
the wifi drops, the sidebar switches to *Working offline*, typing keeps working,
and the next successful save pushes it up. Nothing is lost by a dropped
connection mid-day.

**Drill scores are recorded.** The sorters, the multiple-choice sets, the ranking exercises and the
call-flow sequencer all write an attempt to the rep's account when they're
completed: the score, and exactly which items were wrong. Every attempt is kept,
not just the latest — a rep who went 3/6 then 6/6 has learned something, and
only keeping the latest score hides that. A part-answered drill is still graded
on screen, but not recorded; scoring half a drill against the full total would
just read as a failure.

Tell reps this at kickoff. Recording performance quietly is a trust problem
waiting to happen.

**Managers** land on the dashboard:

- **Team progress** — the roster, filterable by cohort, with each rep's
  percentage of the whole book, days marked done, days signed off, live-call
  status, drill count and how recently they worked. Summary tiles include how
  many reps have been quiet 3+ days. With two or more cohorts, a comparison
  table appears so a later cohort can be measured against the baseline group.
  Click a rep to read their actual written answers day by day, grouped under the
  same section headings as the book, with their drill scores and attempt history
  under each day. Printable, for walking into a 1-on-1 with the rep's own words
  on paper.
- **What the team fails** — every drill ranked hardest first, with average score,
  first-try average, best-attempt average and failure rate, plus per-day average
  completion. If seven of nine reps miss the $89 fee drill, that's a curriculum
  problem, not nine rep problems.
- **People** — role, cohort, start date and active status for everyone with an
  account. Deactivating someone removes them from the roster without deleting a
  word of their workbook.

**Export CSV** on the roster gives the columns the weekly Smartsheets report
needs, and respects the cohort filter.

**Sign-offs are manager-only, enforced by the database.** Reps see the sign-off
block in their book greyed out with a note. The `signoffs` table has no rep write
policy at all, so a rep can't sign their own day even by calling the API
directly. That matters most on Day 5, which gates live calls.

**Reps can read everything they write.** Managers can too — including the
personal reflections on Days 1 and 4. Say so plainly at kickoff. The book is a
work document, not a diary.

---

## Changing the curriculum

Edit `public/book.html` and push; Netlify redeploys. Two cautions:

- Answer keys are `sectionId.typeIndex` — e.g. `d6s5.t2` is the third textarea in
  Day 6's fifth section. Adding or removing a field **inside a section** shifts
  the keys after it in that same section, which would misalign answers already
  recorded there. Adding a whole new section, or a new day, is always safe.
  If in-section edits start happening often, move to hand-authored ids before the
  second cohort starts — this is the likeliest source of future data corruption.
- The dashboard reads its question labels *and* its per-day field counts from
  `book.html` itself (loaded hidden with `?labels=1`), so neither can drift out
  of sync with the book.

Adding a drill: give the widget a `data-sorter-id` / `data-rank-id` / `data-mcq-id` /
`data-seq-id` that nothing else uses. That id is what the score is filed under
forever, so don't reuse or rename one.

`G:\My Drive\Claude\Outputs\Service Professionals Academy - Interactive Book.html`
is the same book as a single offline file with no login — handy for printing or
for a laptop with no network. It saves to that browser only.

---

## Data

Locally, all of it lives in one browser key, `sp.academy.local.v1`, and
**Back up everything** on the dashboard writes that out as JSON. **Restore**
reads one back — it replaces everything and can't be undone, so back up first.
The book separately caches its day list and field counts under
`sp.academy.bookshape.v1`; that one is disposable and rebuilds itself.

Hosted, the same information lives in four tables:

| table | who can read | who can write |
|---|---|---|
| `profiles` | own row; managers all | own name; managers everything |
| `progress` | own rows; managers all | own rows only |
| `drill_attempts` | own rows; managers all | own rows, **insert only** |
| `signoffs` | own rows; managers all | **managers only** |

Views: `rep_overview` (the roster), `drill_difficulty` (per drill, across the
team), `day_completion` (per day, across the team). All run as the caller, so a
rep querying one sees only themselves.

Nothing in the app deletes workbook history — there's deliberately no delete
policy on `progress` or `drill_attempts`, and no way to edit a score after the
fact.

## The ServiceTitan NEXT link

Day 13 sends reps into NEXT to build practice appointments. All the buttons come
from one constant near the top of the inline script in `public/book.html`:

```js
var NEXT_URL = "https://next.servicetitan.com/#/Calls";
```

Change that line and every NEXT button in the book follows. Set it to an empty
string and the buttons render as "NEXT link not set yet" rather than going
somewhere broken.

**Never paste a link containing `identityTrace` or `state` parameters.** Those
are single-use sign-in tokens tied to one person's session — they expire within
minutes and shouldn't be committed to a repo nine people can read.
