-- ============================================================================
-- Service Professionals CSR Academy — database schema
-- Run this once in Supabase Studio > SQL Editor > New query > Run.
-- Safe to re-run: everything is guarded with "if not exists" / "or replace".
--
-- The front end ships the anon key in the browser. That is what it is for.
-- Everything below — the policies especially — is the actual security boundary.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. WHO IS ALLOWED IN
--    Change this one line if the company's email domain ever changes.
-- ----------------------------------------------------------------------------
create or replace function public.allowed_email_domain()
returns text language sql immutable as $fn$ select 'service-professionals.com' $fn$;

-- ----------------------------------------------------------------------------
-- 1. PROFILES  (one row per person, mirrors auth.users)
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text        not null default '',
  email       text        not null default '',
  role        text        not null default 'rep' check (role in ('rep','manager')),
  cohort      text,
  started_on  date,
  active      boolean     not null default true,
  created_at  timestamptz not null default now()
);

-- added after the first release; harmless on a fresh database
alter table public.profiles add column if not exists email text not null default '';

comment on table public.profiles is
  'One row per academy participant. role=manager can read everyone and write sign-offs.';
comment on column public.profiles.cohort is
  'Free text, e.g. "Baseline 2026". Set by a manager from the dashboard.';

-- ----------------------------------------------------------------------------
-- 2. PROGRESS  (one row per rep per day; answers held as JSON)
-- ----------------------------------------------------------------------------
create table if not exists public.progress (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  day         smallint    not null check (day between 1 and 20),
  answers     jsonb       not null default '{}'::jsonb,
  filled      integer     not null default 0,
  total       integer     not null default 0,
  rep_done    boolean     not null default false,
  updated_at  timestamptz not null default now(),
  primary key (user_id, day)
);

comment on column public.progress.answers is
  'Field key -> value. Keys are stable per section, e.g. "d6s5.t2" / "d6s5.c0".';
comment on column public.progress.rep_done is
  'The rep ticked "Day N complete". NOT a manager sign-off — see public.signoffs.';

create index if not exists progress_user_idx on public.progress (user_id);
create index if not exists progress_updated_idx on public.progress (updated_at desc);

-- ----------------------------------------------------------------------------
-- 3. DRILL ATTEMPTS  (every attempt, not just the latest — the retry is the
--    signal worth having: 3/6 then 6/6 means the rep learned something)
-- ----------------------------------------------------------------------------
create table if not exists public.drill_attempts (
  id           bigint generated always as identity primary key,
  user_id      uuid        not null references auth.users(id) on delete cascade,
  day          smallint    not null check (day between 1 and 20),
  drill_id     text        not null,
  drill_kind   text        not null check (drill_kind in ('sorter','rank','sequence','mcq')),
  drill_title  text        not null default '',
  score        integer     not null check (score >= 0),
  max_score    integer     not null check (max_score > 0),
  detail       jsonb       not null default '{}'::jsonb,
  attempt_no   integer     not null default 1,
  attempted_at timestamptz not null default now()
);

-- "create table if not exists" skips an existing table entirely, so a new drill
-- kind added later would never reach a database that has already been set up.
-- Restating the constraint here is what makes re-running this file actually
-- apply it. Add any future drill kind to BOTH lists.
alter table public.drill_attempts drop constraint if exists drill_attempts_drill_kind_check;
alter table public.drill_attempts add  constraint drill_attempts_drill_kind_check
  check (drill_kind in ('sorter','rank','sequence','mcq'));

comment on table public.drill_attempts is
  'Insert-only. Reps cannot edit or delete a score after the fact.';
comment on column public.drill_attempts.detail is
  'What specifically was missed, e.g. {"wrong":["The unit is frozen"],"answered":6}.';

create index if not exists drill_user_idx  on public.drill_attempts (user_id, drill_id);
create index if not exists drill_drill_idx on public.drill_attempts (drill_id);

-- attempt_no is assigned by the database so two open tabs cannot both claim "attempt 3"
create or replace function public.set_attempt_no()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  select coalesce(max(attempt_no), 0) + 1 into new.attempt_no
    from public.drill_attempts
   where user_id = new.user_id and drill_id = new.drill_id;
  return new;
end;
$fn$;

drop trigger if exists drill_attempt_no on public.drill_attempts;
create trigger drill_attempt_no
  before insert on public.drill_attempts
  for each row execute function public.set_attempt_no();

-- ----------------------------------------------------------------------------
-- 4. SIGNOFFS  (manager-only: a rep can never sign their own day)
-- ----------------------------------------------------------------------------
create table if not exists public.signoffs (
  user_id              uuid        not null references auth.users(id) on delete cascade,
  day                  smallint    not null check (day between 1 and 20),
  signed_by            uuid        not null references auth.users(id),
  signed_at            timestamptz not null default now(),
  ready_for_live_calls boolean,
  notes                text        not null default '',
  primary key (user_id, day)
);

comment on table public.signoffs is
  'Manager sign-off per day. Day 5 gates live calls, so reps must not be able to write here.';

-- ----------------------------------------------------------------------------
-- 5. HELPER: is the caller a manager?
--    security definer so it can read profiles without tripping profiles RLS
--    (a plain subquery inside a profiles policy would recurse).
-- ----------------------------------------------------------------------------
create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'manager' and active
  );
$fn$;

revoke all on function public.is_manager() from public;
grant execute on function public.is_manager() to authenticated;

-- ----------------------------------------------------------------------------
-- 6. Domain lock, layer two.
--    The Google consent screen being set to "Internal" is layer one. This is
--    the layer that still holds if that is ever loosened by mistake.
-- ----------------------------------------------------------------------------
create or replace function public.enforce_email_domain()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  dom text := public.allowed_email_domain();
begin
  if new.email is null or lower(split_part(new.email, '@', 2)) <> lower(dom) then
    raise exception 'Only % accounts can use the CSR Academy', dom
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists enforce_email_domain_trg on auth.users;
create trigger enforce_email_domain_trg
  before insert on auth.users
  for each row execute function public.enforce_email_domain();

-- ----------------------------------------------------------------------------
-- 7. Auto-create a profile whenever a user is created.
--    Name comes from Google, so there is no user administration to do.
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'full_name', ''),
      nullif(new.raw_user_meta_data->>'name', ''),
      ''
    ),
    coalesce(new.email, '')
  )
  on conflict (id) do update
    set email     = excluded.email,
        full_name = case when public.profiles.full_name = '' then excluded.full_name
                         else public.profiles.full_name end;
  return new;
end;
$fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- backfill email for anyone created before this column existed
update public.profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id and p.email = '' and u.email is not null;

-- ----------------------------------------------------------------------------
-- 8. Stop reps editing anything that isn't their own name
-- ----------------------------------------------------------------------------
create or replace function public.guard_profile_admin_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if (new.role       is distinct from old.role
   or new.active     is distinct from old.active
   or new.cohort     is distinct from old.cohort
   or new.started_on is distinct from old.started_on
   or new.email      is distinct from old.email)
     -- auth.uid() is null when this fires from the signup trigger rather than
     -- from a signed-in person; that path is the database maintaining its own
     -- row, not someone editing a colleague's.
     and auth.uid() is not null
     and not public.is_manager() then
    raise exception 'Only a manager can change role, cohort, start date or active status';
  end if;
  return new;
end;
$fn$;

drop trigger if exists guard_profile_role_trg  on public.profiles;
drop trigger if exists guard_profile_admin_trg on public.profiles;
create trigger guard_profile_admin_trg
  before update on public.profiles
  for each row execute function public.guard_profile_admin_fields();

-- ----------------------------------------------------------------------------
-- 9. Keep updated_at honest
-- ----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $fn$
begin new.updated_at = now(); return new; end;
$fn$;

drop trigger if exists progress_touch on public.progress;
create trigger progress_touch
  before update on public.progress
  for each row execute function public.touch_updated_at();

-- ============================================================================
-- 10. ROW LEVEL SECURITY
-- ============================================================================
alter table public.profiles       enable row level security;
alter table public.progress       enable row level security;
alter table public.drill_attempts enable row level security;
alter table public.signoffs       enable row level security;

-- --- profiles ---------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_manager());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_manager())
  with check (id = auth.uid() or public.is_manager());

drop policy if exists profiles_insert_manager on public.profiles;
create policy profiles_insert_manager on public.profiles
  for insert to authenticated
  with check (public.is_manager());

-- --- progress: a rep owns their own rows, a manager can read all ------------
drop policy if exists progress_select on public.progress;
create policy progress_select on public.progress
  for select to authenticated
  using (user_id = auth.uid() or public.is_manager());

drop policy if exists progress_insert_own on public.progress;
create policy progress_insert_own on public.progress
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists progress_update_own on public.progress;
create policy progress_update_own on public.progress
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- deliberately NO delete policy: nobody deletes workbook history from the app.

-- --- drill_attempts: insert-only for reps, read-all for managers ------------
drop policy if exists drill_select on public.drill_attempts;
create policy drill_select on public.drill_attempts
  for select to authenticated
  using (user_id = auth.uid() or public.is_manager());

drop policy if exists drill_insert_own on public.drill_attempts;
create policy drill_insert_own on public.drill_attempts
  for insert to authenticated
  with check (user_id = auth.uid());

-- no update and no delete policy, for anyone: a score is final once recorded.

-- --- signoffs: reps read their own, only managers write ---------------------
drop policy if exists signoffs_select on public.signoffs;
create policy signoffs_select on public.signoffs
  for select to authenticated
  using (user_id = auth.uid() or public.is_manager());

drop policy if exists signoffs_write_manager on public.signoffs;
create policy signoffs_write_manager on public.signoffs
  for insert to authenticated
  with check (public.is_manager() and signed_by = auth.uid());

drop policy if exists signoffs_update_manager on public.signoffs;
create policy signoffs_update_manager on public.signoffs
  for update to authenticated
  using (public.is_manager())
  with check (public.is_manager() and signed_by = auth.uid());

-- ============================================================================
-- 11. DASHBOARD VIEWS
--     security_invoker = the view runs as the caller, so RLS still applies:
--     a rep querying one of these sees only themselves.
--
--     Each aggregate lives in its own lateral subquery. Joining progress and
--     signoffs in one group-by multiplies the rows against each other and
--     inflates every sum — which is why this is not one flat query.
-- ============================================================================
create or replace view public.rep_overview
with (security_invoker = true) as
select
  p.id,
  p.full_name,
  p.email,
  p.cohort,
  p.started_on,
  pr.filled,
  pr.total,
  case when pr.total = 0 then 0 else round(100.0 * pr.filled / pr.total) end as pct,
  pr.days_rep_done,
  so.days_signed_off,
  coalesce(so.cleared, false) as cleared_for_live_calls,
  pr.last_active,
  dr.drills_attempted,
  dr.avg_best_pct
from public.profiles p
left join lateral (
  select coalesce(sum(filled), 0)::int         as filled,
         coalesce(sum(total), 0)::int          as total,
         count(*) filter (where rep_done)::int as days_rep_done,
         max(updated_at)                       as last_active
    from public.progress where user_id = p.id
) pr on true
left join lateral (
  select count(*)::int                             as days_signed_off,
         bool_or(day = 5 and ready_for_live_calls) as cleared
    from public.signoffs where user_id = p.id
) so on true
left join lateral (
  select count(*)::int          as drills_attempted,
         round(avg(best))::int  as avg_best_pct
    from (
      select drill_id, max(100.0 * score / nullif(max_score, 0)) as best
        from public.drill_attempts where user_id = p.id group by drill_id
    ) b
) dr on true
where p.role = 'rep' and p.active;

grant select on public.rep_overview to authenticated;

-- Which drills the team as a whole fails. Worst first is the useful order.
create or replace view public.drill_difficulty
with (security_invoker = true) as
with a as (
  select da.drill_id, da.drill_kind, da.drill_title, da.day, da.user_id, da.attempt_no,
         100.0 * da.score / nullif(da.max_score, 0) as pct
    from public.drill_attempts da
    join public.profiles p on p.id = da.user_id and p.role = 'rep' and p.active
),
best as (
  select user_id, drill_id, max(pct) as best_pct from a group by user_id, drill_id
)
select
  d.drill_id, d.day, d.drill_kind, d.drill_title,
  d.attempts, d.reps, d.avg_pct, d.first_try_pct, d.fail_rate,
  bb.avg_best_pct
from (
  select drill_id,
         min(day)                                                        as day,
         min(drill_kind)                                                 as drill_kind,
         min(drill_title)                                                as drill_title,
         count(*)::int                                                   as attempts,
         count(distinct user_id)::int                                    as reps,
         round(avg(pct))::int                                            as avg_pct,
         round(avg(pct) filter (where attempt_no = 1))::int              as first_try_pct,
         round(100.0 * count(*) filter (where pct < 80) / count(*))::int as fail_rate
    from a group by drill_id
) d
left join (
  select drill_id, round(avg(best_pct))::int as avg_best_pct from best group by drill_id
) bb on bb.drill_id = d.drill_id;

grant select on public.drill_difficulty to authenticated;

-- Which days everyone stalls on.
create or replace view public.day_completion
with (security_invoker = true) as
select
  pr.day,
  count(*)::int                            as reps_started,
  count(*) filter (where pr.rep_done)::int as reps_done,
  round(avg(case when pr.total = 0 then 0
                 else 100.0 * pr.filled / pr.total end))::int as avg_pct
from public.progress pr
join public.profiles p on p.id = pr.user_id and p.role = 'rep' and p.active
group by pr.day;

grant select on public.day_completion to authenticated;

-- ============================================================================
-- 12. AFTER RUNNING THIS: make yourself the manager.
--     Sign in once with Google so the account exists, then run this once:
--
--     update public.profiles set role = 'manager'
--     where email = 'lnervegna@service-professionals.com';
--
--     That is the only SQL anyone should ever have to run. Every other role,
--     cohort and active-status change is done from the dashboard.
-- ============================================================================
