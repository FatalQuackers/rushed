-- =====================================================================
-- RUSHED scouting dashboard — database setup for Supabase
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- It is safe to run again later (it updates things in place).
--
-- How accounts work:
--   * Anyone can sign up on the dashboard. New accounts are PENDING and
--     can't see anything until an owner (Founder or Co-Founder) verifies them.
--   * The very first account ever created becomes the Founder automatically,
--     so sign up yourself straight after running this.
--   * All of these rules are enforced by the database itself, not the web page.
-- =====================================================================

create extension if not exists pg_net;   -- lets the database talk to Discord and Roblox
create extension if not exists pg_cron;  -- runs the Roblox sync every few minutes

-- ---------- tables ----------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  username    text not null,
  discord     text,
  roblox      text,
  role        text not null default 'scout'
              check (role in ('founder','co_founder','management','scout_lead','scout')),
  status      text not null default 'pending'
              check (status in ('pending','approved','rejected','suspended')),
  created_at  timestamptz not null default now(),
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz
);

create table if not exists public.games (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (char_length(name) between 1 and 120),
  link              text not null,
  genre             text not null default 'Other',
  ccu               integer not null default 0 check (ccu >= 0),
  visits            bigint  not null default 0 check (visits >= 0),
  discord_url       text,
  x_url             text,
  notes             text,
  avg_playtime_min  numeric check (avg_playtime_min >= 0),
  d1_retention      numeric check (d1_retention between 0 and 100),
  est_monthly_robux bigint  check (est_monthly_robux >= 0),
  status            text not null default 'pending' check (status in ('pending','approved','rejected')),
  rating            smallint check (rating between 1 and 5),
  review_comment    text,
  reviewed_by       uuid references public.profiles(id) on delete set null,
  reviewed_at       timestamptz,
  contact_status    text not null default 'none' check (contact_status in ('none','contacted','talking','deal','declined')),
  contacted_by      uuid references public.profiles(id) on delete set null,
  contacted_at      timestamptz,
  submitted_by      uuid references public.profiles(id) on delete set null default auth.uid(),
  legacy_by         text,           -- scout name from the old browser-only dashboard
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.games add column if not exists universe_id bigint;

create table if not exists public.game_stats (
  id          bigint generated always as identity primary key,
  game_id     uuid not null references public.games(id) on delete cascade,
  ccu         integer not null check (ccu >= 0),
  visits      bigint  not null check (visits >= 0),
  recorded_at timestamptz not null default now(),
  recorded_by uuid references public.profiles(id) on delete set null default auth.uid()
);
create index if not exists game_stats_game_idx on public.game_stats (game_id, recorded_at);

create table if not exists public.watchlist (
  user_id uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  game_id uuid not null references public.games(id) on delete cascade,
  primary key (user_id, game_id)
);

create table if not exists public.activity (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  who     uuid references public.profiles(id) on delete set null,
  text    text not null,
  game_id uuid references public.games(id) on delete set null
);

-- Kept private: no one can read this table from the website.
create table if not exists public.app_settings (
  id              boolean primary key default true check (id),
  discord_webhook text,
  notify_signup   boolean not null default true,
  notify_submit   boolean not null default true,
  notify_review   boolean not null default true,
  notify_deal     boolean not null default true
);
insert into public.app_settings (id) values (true) on conflict do nothing;

-- ---------- who-is-who helpers ---------------------------------------
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and status = 'approved'
$$;
create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() is not null, false)
$$;
create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('founder','co_founder'), false)
$$;
create or replace function public.is_staff() returns boolean   -- can review games
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('founder','co_founder','management','scout_lead'), false)
$$;

-- ---------- Discord notifications (sent by the database) --------------
create or replace function public.discord_notify(kind text, title text, descr text, color int, url text default null)
returns void language plpgsql security definer set search_path = public as $$
declare s app_settings;
begin
  select * into s from app_settings where id;
  if s.discord_webhook is null or s.discord_webhook = '' then return; end if;
  if (kind = 'signup' and not s.notify_signup) or (kind = 'submit' and not s.notify_submit)
     or (kind = 'review' and not s.notify_review) or (kind = 'deal' and not s.notify_deal) then return; end if;
  perform net.http_post(
    url := s.discord_webhook,
    body := jsonb_build_object(
      'username', 'RUSHED Scouting',
      'allowed_mentions', jsonb_build_object('parse', jsonb_build_array()),
      'embeds', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'title', left(title, 250), 'description', left(coalesce(descr, ''), 1000), 'color', color,
        'url', url, 'timestamp', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'footer', jsonb_build_object('text', 'RUSHED scouting dashboard'))))),
    headers := '{"Content-Type":"application/json"}'::jsonb);
exception when others then null;  -- never let Discord problems block the dashboard
end $$;
revoke all on function public.discord_notify(text, text, text, int, text) from public, anon, authenticated;

create or replace function public.log_activity(t text, g uuid default null) returns void
language sql security definer set search_path = public as $$
  insert into activity (who, text, game_id) values (auth.uid(), t, g)
$$;
revoke all on function public.log_activity(text, uuid) from public, anon, authenticated;

-- ---------- new sign-ups ---------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare first boolean;
begin
  select not exists (select 1 from profiles) into first;
  insert into profiles (id, email, username, discord, roblox, role, status, approved_at)
  values (
    new.id, new.email,
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'username'), ''), split_part(new.email, '@', 1)), 40),
    left(nullif(trim(new.raw_user_meta_data->>'discord'), ''), 40),
    left(nullif(trim(new.raw_user_meta_data->>'roblox'), ''), 40),
    case when first then 'founder' else 'scout' end,
    case when first then 'approved' else 'pending' end,
    case when first then now() end);
  insert into activity (who, text) values (new.id, case when first then 'set up the dashboard as Founder' else 'signed up and is waiting for verification' end);
  if not first then
    perform discord_notify('signup', 'New dashboard sign-up waiting for verification',
      format('**%s** (Discord: %s) signed up with %s. An owner needs to verify them in Dashboard → Team.',
        coalesce(new.raw_user_meta_data->>'username', '?'), coalesce(nullif(new.raw_user_meta_data->>'discord', ''), 'not given'), new.email),
      16769889);
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- profile rules --------------------------------------------
-- People can edit their own name/Discord/Roblox. Only owners can change role or
-- status, nobody can change their own role/status, and only the Founder can
-- give or take away the Founder/Co-Founder roles.
create or replace function public.guard_profile() returns trigger
language plpgsql security definer set search_path = public as $$
declare actor text := public.my_role();
begin
  if auth.uid() is null then return new; end if;  -- SQL editor / server
  new.id := old.id; new.email := old.email; new.created_at := old.created_at;
  if new.role is distinct from old.role or new.status is distinct from old.status then
    if actor not in ('founder','co_founder') then raise exception 'Only an owner can change roles or verify accounts'; end if;
    if old.id = auth.uid() then raise exception 'You can''t change your own role or status'; end if;
    if actor <> 'founder' and (old.role in ('founder','co_founder') or new.role in ('founder','co_founder')) then
      raise exception 'Only the Founder can change owner roles';
    end if;
    if new.status = 'approved' and old.status <> 'approved' then
      new.approved_by := auth.uid(); new.approved_at := now();
      perform log_activity(format('verified %s', old.username));
      perform discord_notify('signup', format('%s now has dashboard access', new.username),
        format('Verified by %s as %s.', (select username from profiles where id = auth.uid()), replace(new.role, '_', ' ')), 3126380);
    elsif new.status is distinct from old.status then
      perform log_activity(format('set %s to %s', old.username, new.status));
    end if;
    if new.role is distinct from old.role then
      perform log_activity(format('made %s a %s', old.username, replace(new.role, '_', ' ')));
    end if;
  else
    new.approved_by := old.approved_by; new.approved_at := old.approved_at;
  end if;
  return new;
end $$;
drop trigger if exists guard_profile on public.profiles;
create trigger guard_profile before update on public.profiles
  for each row execute function public.guard_profile();

-- ---------- game rules -----------------------------------------------
create or replace function public.guard_game() returns trigger
language plpgsql security definer set search_path = public as $$
declare staff boolean := public.is_staff(); mine boolean;
begin
  if auth.uid() is null or current_setting('rushed.system', true) = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    if not staff then
      new.submitted_by := auth.uid(); new.status := 'pending'; new.rating := null;
      new.review_comment := null; new.reviewed_by := null; new.reviewed_at := null; new.legacy_by := null;
    end if;
    new.created_at := coalesce(new.created_at, now());
    return new;
  end if;
  mine := old.submitted_by = auth.uid();
  new.id := old.id; new.created_at := old.created_at; new.updated_at := now();
  if not staff then
    new.status := old.status; new.rating := old.rating; new.review_comment := old.review_comment;
    new.reviewed_by := old.reviewed_by; new.reviewed_at := old.reviewed_at;
    new.submitted_by := old.submitted_by; new.legacy_by := old.legacy_by;
    if not (mine and old.status = 'pending') then   -- others may only update outreach
      new.name := old.name; new.link := old.link; new.genre := old.genre; new.notes := old.notes;
      new.discord_url := old.discord_url; new.x_url := old.x_url; new.avg_playtime_min := old.avg_playtime_min;
      new.d1_retention := old.d1_retention; new.est_monthly_robux := old.est_monthly_robux;
    end if;
  elsif new.status is distinct from old.status and new.status <> 'pending' then
    new.reviewed_by := auth.uid(); new.reviewed_at := now();
  end if;
  if new.ccu is distinct from old.ccu or new.visits is distinct from old.visits then
    -- pg_trigger_depth() > 1 means a new stats snapshot is updating the numbers
    if not (staff or (mine and old.status = 'pending') or pg_trigger_depth() > 1) then new.ccu := old.ccu; new.visits := old.visits; end if;
  end if;
  if new.link is distinct from old.link then new.universe_id := null; else new.universe_id := old.universe_id; end if;
  if new.contact_status is distinct from old.contact_status then
    new.contacted_by := auth.uid(); new.contacted_at := now();
  else
    new.contacted_by := old.contacted_by; new.contacted_at := old.contacted_at;
  end if;
  return new;
end $$;
drop trigger if exists guard_game on public.games;
create trigger guard_game before insert or update on public.games
  for each row execute function public.guard_game();

create or replace function public.after_game() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := coalesce((select username from profiles where id = auth.uid()), 'someone');
        link text := case when new.link ~ '^\d+$' then 'https://www.roblox.com/games/' || new.link
                          when new.link ~* '^https://(www\.)?roblox\.com/' then new.link end;
        eff numeric := case when new.visits > 0 then round(new.ccu::numeric * 1000 / new.visits, 2) else 0 end;
begin
  if tg_op = 'INSERT' then
    insert into game_stats (game_id, ccu, visits, recorded_by) values (new.id, new.ccu, new.visits, auth.uid());
    if new.legacy_by is null then
      perform log_activity(format('submitted %s', new.name), new.id);
      perform discord_notify('submit', 'New game to scout: ' || new.name,
        format('%s · %s CCU · %s visits · efficiency %s · sent by %s%s', new.genre, new.ccu, new.visits, eff, who,
          case when coalesce(new.notes, '') <> '' then E'\n' || left(new.notes, 300) else '' end), 16769889, link);
    end if;
  else
    if new.status is distinct from old.status and new.status <> 'pending' then
      perform log_activity(format('%s %s', case new.status when 'approved' then 'approved' else 'passed on' end, new.name), new.id);
      perform discord_notify('review', (case new.status when 'approved' then 'Approved: ' else 'Passed: ' end) || new.name,
        format('Reviewed by %s%s%s', who,
          case when new.rating is not null then ' · ' || repeat('★', new.rating) || repeat('☆', 5 - new.rating) else '' end,
          case when coalesce(new.review_comment, '') <> '' then E'\n“' || left(new.review_comment, 300) || '”' else '' end),
        case new.status when 'approved' then 3126380 else 7828335 end, link);
    end if;
    if new.contact_status is distinct from old.contact_status then
      perform log_activity(format('marked %s as %s', new.name, case new.contact_status when 'none' then 'not contacted'
        when 'talking' then 'in talks' when 'deal' then 'deal closed' else new.contact_status end), new.id);
      if new.contact_status = 'deal' then
        perform discord_notify('deal', 'Deal closed: ' || new.name, format('%s closed a deal with %s. 🎉', who, new.name), 7756015, link);
      end if;
    end if;
  end if;
  return null;
end $$;
drop trigger if exists after_game on public.games;
create trigger after_game after insert or update on public.games
  for each row execute function public.after_game();

-- new stats snapshot → update the game's current numbers
create or replace function public.after_stat() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update games set ccu = new.ccu, visits = new.visits, updated_at = now()
   where id = new.game_id and (ccu, visits) is distinct from (new.ccu, new.visits);
  return null;
end $$;
drop trigger if exists after_stat on public.game_stats;
create trigger after_stat after insert on public.game_stats
  for each row execute function public.after_stat();

-- ---------- owner-only settings (Discord webhook) ---------------------
create or replace function public.get_settings() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s app_settings;
begin
  if not public.is_owner() then raise exception 'Owners only'; end if;
  select * into s from app_settings where id;
  return jsonb_build_object('webhook_set', coalesce(s.discord_webhook, '') <> '',
    'notify_signup', s.notify_signup, 'notify_submit', s.notify_submit, 'notify_review', s.notify_review, 'notify_deal', s.notify_deal);
end $$;

create or replace function public.save_settings(webhook text, n_signup boolean, n_submit boolean, n_review boolean, n_deal boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owners only'; end if;
  if webhook is not null and webhook <> '' and webhook !~ '^https://(canary\.|ptb\.)?(discord|discordapp)\.com/api/webhooks/' then
    raise exception 'That doesn''t look like a Discord webhook link';
  end if;
  update app_settings set
    discord_webhook = case when webhook is null then discord_webhook when webhook = '' then null else webhook end,
    notify_signup = n_signup, notify_submit = n_submit, notify_review = n_review, notify_deal = n_deal
   where id;
  perform log_activity('updated the Discord settings');
end $$;

create or replace function public.test_webhook() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owners only'; end if;
  perform discord_notify('review', 'Test from the RUSHED dashboard', 'If you can read this, notifications are working.', 7756015);
end $$;

create or replace function public.member_emails() returns table (id uuid, email text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owners only'; end if;
  return query select p.id, p.email from profiles p;
end $$;

-- ---------- row level security --------------------------------------
alter table public.profiles     enable row level security;
alter table public.games        enable row level security;
alter table public.game_stats   enable row level security;
alter table public.watchlist    enable row level security;
alter table public.activity     enable row level security;
alter table public.app_settings enable row level security;   -- no policies = nobody can read it

drop policy if exists "see own or team"  on public.profiles;
drop policy if exists "edit own or owner" on public.profiles;
create policy "see own or team"   on public.profiles for select to authenticated using (id = auth.uid() or public.is_approved());
create policy "edit own or owner" on public.profiles for update to authenticated using (id = auth.uid() or public.is_owner());

drop policy if exists "team reads games"   on public.games;
drop policy if exists "team adds games"    on public.games;
drop policy if exists "team updates games" on public.games;
drop policy if exists "remove games"       on public.games;
create policy "team reads games"   on public.games for select to authenticated using (public.is_approved());
create policy "team adds games"    on public.games for insert to authenticated with check (public.is_approved());
create policy "team updates games" on public.games for update to authenticated using (public.is_approved());
create policy "remove games"       on public.games for delete to authenticated
  using (public.is_owner() or (submitted_by = auth.uid() and status = 'pending'));

drop policy if exists "team reads stats" on public.game_stats;
drop policy if exists "team adds stats"  on public.game_stats;
create policy "team reads stats" on public.game_stats for select to authenticated using (public.is_approved());
create policy "team adds stats"  on public.game_stats for insert to authenticated
  with check (public.is_approved() and recorded_by = auth.uid());

drop policy if exists "own watchlist" on public.watchlist;
create policy "own watchlist" on public.watchlist for all to authenticated
  using (user_id = auth.uid() and public.is_approved()) with check (user_id = auth.uid() and public.is_approved());

drop policy if exists "team reads activity" on public.activity;
create policy "team reads activity" on public.activity for select to authenticated using (public.is_approved());

-- Lock everything down for signed-out visitors, then grant only what the policies allow.
revoke all on public.profiles, public.games, public.game_stats, public.watchlist, public.activity, public.app_settings from anon;
revoke all on public.profiles, public.games, public.game_stats, public.watchlist, public.activity, public.app_settings from authenticated;
-- emails stay private: only owners can read them, through member_emails()
grant select (id, username, discord, roblox, role, status, created_at, approved_by, approved_at) on public.profiles to authenticated;
grant update (username, discord, roblox, role, status) on public.profiles to authenticated;
grant select, insert, update, delete on public.games, public.watchlist to authenticated;
grant select, insert on public.game_stats to authenticated;
grant select on public.activity to authenticated;
revoke execute on function public.get_settings(), public.save_settings(text, boolean, boolean, boolean, boolean), public.test_webhook(), public.member_emails() from public, anon;
grant execute on function public.get_settings(), public.save_settings(text, boolean, boolean, boolean, boolean), public.test_webhook(), public.member_emails() to authenticated;

-- =====================================================================
-- ROBLOX SYNC
-- The database pulls public game data from Roblox by itself every 5 minutes:
--   * finds games on Roblox's discovery lists and search (for Suggestions)
--   * refreshes CCU / visits / likes / last update for every game it knows
--   * adds a stats snapshot to every game on the dashboard about once an hour
-- =====================================================================
create table if not exists public.roblox_games (
  universe_id   bigint primary key,
  place_id      bigint,
  name          text,
  creator_name  text,
  creator_type  text,
  creator_id    bigint,
  genre         text,
  subgenre      text,
  playing       integer not null default 0,
  visits        bigint,
  favorites     bigint,
  up_votes      bigint,
  down_votes    bigint,
  max_players   integer,
  created       timestamptz,
  updated       timestamptz,
  growth_7d     numeric,          -- % change in CCU vs about a week ago
  sources       text[] not null default '{}',
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  last_synced   timestamptz,
  dismissed_by  uuid references public.profiles(id) on delete set null,
  dismissed_at  timestamptz
);
create index if not exists roblox_games_place_idx on public.roblox_games (place_id);
create index if not exists roblox_games_sync_idx on public.roblox_games (last_synced nulls first);

create table if not exists public.roblox_snapshots (
  universe_id bigint not null references public.roblox_games(universe_id) on delete cascade,
  at          timestamptz not null default now(),
  playing     integer not null,
  visits      bigint
);
create index if not exists roblox_snapshots_idx on public.roblox_snapshots (universe_id, at);

create table if not exists public.roblox_requests (   -- requests waiting for Roblox to answer
  id      bigint primary key,
  kind    text not null,
  meta    jsonb not null default '{}',
  sent_at timestamptz not null default now()
);

create table if not exists public.roblox_state (
  id         boolean primary key default true check (id),
  last_scan  timestamptz,
  last_error text,
  last_ok    timestamptz
);
insert into public.roblox_state (id) values (true) on conflict do nothing;

create or replace function public.roblox_get(url text, kind text, meta jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
declare rid bigint;
begin
  rid := net.http_get(url := url, headers := '{"Accept":"application/json"}'::jsonb, timeout_milliseconds := 20000);
  insert into roblox_requests (id, kind, meta) values (rid, kind, meta) on conflict (id) do nothing;
end $$;

-- Ask Roblox for new games: discovery lists + genre searches.
create or replace function public.roblox_scan() returns void
language plpgsql security definer set search_path = public as $$
declare sid text := gen_random_uuid()::text; s text;
begin
  foreach s in array array['up-and-coming','top-rated','top-revisited','fun-with-friends','top-trending','top-earning','top-playing-now'] loop
    perform roblox_get(format('https://apis.roblox.com/explore-api/v1/get-sort-content?sessionId=%s&sortId=%s&device=computer&country=all', sid, s), 'list', jsonb_build_object('source', s));
  end loop;
  foreach s in array array['obby','tycoon','simulator','horror','tower defense','roleplay','fighting','survival','incremental','racing','anime','pets','escape','clicker','rng','shooter','puzzle','party'] loop
    perform roblox_get(format('https://apis.roblox.com/search-api/omni-search?searchQuery=%s&sessionId=%s&pageType=all', replace(s, ' ', '%20'), sid), 'list', jsonb_build_object('source', 'search: ' || s));
  end loop;
  update roblox_state set last_scan = now() where id;
end $$;

-- Ask Roblox for full details of games that are due (dashboard games hourly, others every 6 hours).
create or replace function public.roblox_refresh(max_batches int default 8) returns void
language plpgsql security definer set search_path = public as $$
declare ids bigint[]; n int := 0;
begin
  -- dashboard games we don't know the universe of yet
  perform roblox_get(format('https://apis.roblox.com/universes/v1/places/%s/universe', g.link), 'place', jsonb_build_object('place_id', g.link::bigint))
    from games g where g.universe_id is null and g.link ~ '^\d+$'
      and not exists (select 1 from roblox_requests r where r.kind = 'place' and r.meta->>'place_id' = g.link)
    limit 20;
  loop
    exit when n >= max_batches;
    select array_agg(universe_id) into ids from (
      select r.universe_id from roblox_games r
       where (r.last_synced is null
          or (exists (select 1 from games g where g.universe_id = r.universe_id) and r.last_synced < now() - interval '55 minutes')
          or (r.last_seen > now() - interval '7 days' and r.last_synced < now() - interval '6 hours'))
         and not exists (select 1 from roblox_requests q where q.kind = 'details' and q.meta->'ids' @> to_jsonb(r.universe_id))
       order by (exists (select 1 from games g where g.universe_id = r.universe_id)) desc, r.last_synced nulls first
       limit 50) t;
    exit when ids is null;
    perform roblox_get('https://games.roblox.com/v1/games?universeIds=' || array_to_string(ids, ','), 'details', jsonb_build_object('ids', to_jsonb(ids)));
    n := n + 1;
  end loop;
end $$;

-- Read whatever Roblox has answered so far.
create or replace function public.roblox_process() returns int
language plpgsql security definer set search_path = public as $$
declare q record; body jsonb; g jsonb; done int := 0; uid bigint; prev record;
begin
  perform set_config('rushed.system', 'on', true);
  for q in select r.*, h.status_code, h.content, h.error_msg, h.timed_out
             from roblox_requests r join net._http_response h on h.id = r.id
            order by r.id loop
    done := done + 1;
    delete from roblox_requests where id = q.id;
    if q.status_code is distinct from 200 then
      update roblox_state set last_error = format('%s → %s %s', q.kind, coalesce(q.status_code::text, 'no answer'), left(coalesce(q.error_msg, q.content, ''), 200)) where id;
      continue;
    end if;
    begin body := q.content::jsonb; exception when others then continue; end;
    update roblox_state set last_ok = now() where id;

    if q.kind = 'list' then
      for g in select x from jsonb_path_query(body, '$.games[*]') x
               union all select x from jsonb_path_query(body, '$.searchResults[*].contents[*] ? (@.contentType == "Game")') x loop
        continue when (g->>'universeId') is null or coalesce((g->>'isSponsored')::boolean, false);
        insert into roblox_games as r (universe_id, place_id, name, genre, playing, up_votes, down_votes, sources)
        values ((g->>'universeId')::bigint, (g->>'rootPlaceId')::bigint, g->>'name', g->>'genreL1',
                coalesce((g->>'playerCount')::int, 0), (g->>'totalUpVotes')::bigint, (g->>'totalDownVotes')::bigint, array[q.meta->>'source'])
        on conflict (universe_id) do update set
          playing = excluded.playing, up_votes = coalesce(excluded.up_votes, r.up_votes), down_votes = coalesce(excluded.down_votes, r.down_votes),
          name = coalesce(excluded.name, r.name), last_seen = now(),
          sources = case when excluded.sources[1] = any(r.sources) then r.sources else (r.sources || excluded.sources)[greatest(1, cardinality(r.sources) - 8):] end;
      end loop;

    elsif q.kind = 'details' then
      for g in select x from jsonb_path_query(body, '$.data[*]') x loop
        uid := (g->>'id')::bigint;
        insert into roblox_games as r (universe_id, place_id, name, creator_name, creator_type, creator_id, genre, subgenre, playing, visits,
                                       favorites, max_players, created, updated, last_synced)
        values (uid, (g->>'rootPlaceId')::bigint, g->>'name', g#>>'{creator,name}', g#>>'{creator,type}', (g#>>'{creator,id}')::bigint,
                nullif(g->>'genre_l1', ''), nullif(g->>'genre_l2', ''), coalesce((g->>'playing')::int, 0), (g->>'visits')::bigint,
                (g->>'favoritedCount')::bigint, (g->>'maxPlayers')::int, (g->>'created')::timestamptz, (g->>'updated')::timestamptz, now())
        on conflict (universe_id) do update set
          place_id = excluded.place_id, name = excluded.name, creator_name = excluded.creator_name, creator_type = excluded.creator_type,
          creator_id = excluded.creator_id, genre = coalesce(excluded.genre, r.genre), subgenre = excluded.subgenre, playing = excluded.playing,
          visits = excluded.visits, favorites = excluded.favorites, max_players = excluded.max_players, created = excluded.created,
          updated = excluded.updated, last_synced = now();
        insert into roblox_snapshots (universe_id, playing, visits) values (uid, coalesce((g->>'playing')::int, 0), (g->>'visits')::bigint);
        select s.playing into prev from roblox_snapshots s
         where s.universe_id = uid and s.at <= now() - interval '1 day'
         order by abs(extract(epoch from (now() - interval '7 days') - s.at)) limit 1;
        update roblox_games set growth_7d = case when prev.playing > 0 then round((playing - prev.playing) * 100.0 / prev.playing, 1) end
         where universe_id = uid;
        -- dashboard games get a real stats snapshot (charts + growth) about once an hour
        insert into game_stats (game_id, ccu, visits, recorded_by)
        select d.id, coalesce((g->>'playing')::int, 0), coalesce((g->>'visits')::bigint, d.visits), null
          from games d where d.universe_id = uid
           and not exists (select 1 from game_stats s where s.game_id = d.id and s.recorded_at > now() - interval '50 minutes');
      end loop;

    elsif q.kind in ('place', 'lookup') then
      uid := (body->>'universeId')::bigint;
      continue when uid is null;
      update games set universe_id = uid where link = q.meta->>'place_id' and universe_id is null;
      insert into roblox_games (universe_id, place_id) values (uid, (q.meta->>'place_id')::bigint) on conflict (universe_id) do nothing;
      if not exists (select 1 from roblox_requests r where r.kind = 'details' and r.meta->'ids' @> to_jsonb(uid)) then
        perform roblox_get('https://games.roblox.com/v1/games?universeIds=' || uid, 'details', jsonb_build_object('ids', jsonb_build_array(uid)));
      end if;
    end if;
  end loop;
  -- forget requests Roblox never answered, and old snapshots
  delete from roblox_requests where sent_at < now() - interval '30 minutes';
  delete from roblox_snapshots where at < now() - interval '21 days';
  return done;
end $$;

-- Runs every 5 minutes (and when staff press "Scan now").
create or replace function public.roblox_tick(force_scan boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare st roblox_state; got int;
begin
  if auth.uid() is not null and not public.is_staff() then raise exception 'Staff only'; end if;
  got := roblox_process();
  select * into st from roblox_state where id;
  if force_scan or st.last_scan is null or st.last_scan < now() - interval '6 hours' then perform roblox_scan(); end if;
  perform roblox_refresh(case when force_scan then 20 else 8 end);
  return jsonb_build_object('processed', got, 'waiting', (select count(*) from roblox_requests));
end $$;

-- Submit form: look up a Roblox place. Call it again every second or two until it returns a game.
create or replace function public.roblox_lookup(place bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r roblox_games;
begin
  if not public.is_approved() then raise exception 'Not allowed'; end if;
  perform roblox_process();
  select * into r from roblox_games where place_id = place and last_synced > now() - interval '15 minutes' limit 1;
  if found then return to_jsonb(r); end if;
  select * into r from roblox_games where place_id = place limit 1;
  if found then
    if not exists (select 1 from roblox_requests q where q.kind = 'details' and q.meta->'ids' @> to_jsonb(r.universe_id)) then
      perform roblox_get('https://games.roblox.com/v1/games?universeIds=' || r.universe_id, 'details', jsonb_build_object('ids', jsonb_build_array(r.universe_id)));
    end if;
  elsif not exists (select 1 from roblox_requests q where q.kind in ('place','lookup') and q.meta->>'place_id' = place::text) then
    perform roblox_get(format('https://apis.roblox.com/universes/v1/places/%s/universe', place), 'lookup', jsonb_build_object('place_id', place));
  end if;
  return null;
end $$;

create or replace function public.roblox_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.is_approved() then jsonb_build_object(
    'last_scan', last_scan, 'last_ok', last_ok, 'last_error', last_error,
    'known', (select count(*) from roblox_games), 'waiting', (select count(*) from roblox_requests)) end
  from roblox_state where id
$$;

-- Suggestions: hide / unhide a game for everyone
create or replace function public.roblox_dismiss(uid bigint, hide boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Not allowed'; end if;
  update roblox_games set dismissed_by = case when hide then auth.uid() end, dismissed_at = case when hide then now() end where universe_id = uid;
end $$;

-- New or re-linked dashboard game → find its universe right away
create or replace function public.roblox_link_game() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.universe_id is null and new.link ~ '^\d+$' then
    perform roblox_get(format('https://apis.roblox.com/universes/v1/places/%s/universe', new.link), 'place', jsonb_build_object('place_id', new.link::bigint));
  elsif new.universe_id is not null then
    insert into roblox_games (universe_id, place_id) values (new.universe_id, new.link::bigint) on conflict (universe_id) do nothing;
  end if;
  return null;
exception when others then return null;
end $$;
drop trigger if exists roblox_link_game on public.games;
create trigger roblox_link_game after insert or update of link on public.games
  for each row execute function public.roblox_link_game();

alter table public.roblox_games     enable row level security;
alter table public.roblox_snapshots enable row level security;
alter table public.roblox_requests  enable row level security;
alter table public.roblox_state     enable row level security;
drop policy if exists "team reads roblox games" on public.roblox_games;
drop policy if exists "team reads roblox snapshots" on public.roblox_snapshots;
create policy "team reads roblox games"     on public.roblox_games     for select to authenticated using (public.is_approved());
create policy "team reads roblox snapshots" on public.roblox_snapshots for select to authenticated using (public.is_approved());
revoke all on public.roblox_games, public.roblox_snapshots, public.roblox_requests, public.roblox_state from anon, authenticated;
grant select on public.roblox_games, public.roblox_snapshots to authenticated;
revoke execute on function public.roblox_get(text, text, jsonb), public.roblox_scan(), public.roblox_refresh(int), public.roblox_process() from public, anon, authenticated;
revoke execute on function public.roblox_tick(boolean), public.roblox_lookup(bigint), public.roblox_status(), public.roblox_dismiss(bigint, boolean) from public, anon;
grant execute on function public.roblox_tick(boolean), public.roblox_lookup(bigint), public.roblox_status(), public.roblox_dismiss(bigint, boolean) to authenticated;

-- 7-day CCU growth for every dashboard game (so the page doesn't have to load every snapshot)
create or replace function public.game_growth() returns table (game_id uuid, growth numeric, points int)
language sql stable security definer set search_path = public as $$
  select g.id,
    (select case when b.ccu > 0 then round((g.ccu - b.ccu) * 100.0 / b.ccu, 1) end
       from game_stats b
      where b.game_id = g.id and b.recorded_at < (select max(x.recorded_at) from game_stats x where x.game_id = g.id)
      order by (b.recorded_at <= now() - interval '7 days') desc,
               case when b.recorded_at <= now() - interval '7 days' then -extract(epoch from b.recorded_at) else extract(epoch from b.recorded_at) end
      limit 1),
    (select count(*)::int from game_stats s where s.game_id = g.id)
  from games g where public.is_approved()
$$;
revoke execute on function public.game_growth() from public, anon;
grant execute on function public.game_growth() to authenticated;

-- every 5 minutes
select cron.schedule('rushed-roblox-sync', '*/5 * * * *', 'select public.roblox_tick()');
