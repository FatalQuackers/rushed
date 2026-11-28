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

create extension if not exists pg_net;   -- lets the database post to Discord

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
  if auth.uid() is null then return new; end if;
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
