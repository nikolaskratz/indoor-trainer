-- Account storage for the Indoor Trainer app: profile, workouts and rides, so they
-- survive a cleared browser and show up on another computer.
--
-- The app syncs these with its local copy (src/lib/sync.ts). Per item the side that
-- changed it last wins, so every row carries updated_at as set by the app, and a
-- deleted item stays as a row with deleted = true and no data.
--
-- Access: a signed-in user sees and writes only their own rows, and only accounts
-- listed in tri_owners may use the tables at all (same rule as the tri_ tables).
-- user_id is filled in by the database, never sent by the app.

create table turbo_profile (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  data jsonb not null,            -- {profile: {ftp, weightKg, maxHr, thresholdHr}, settings: {...}}
  updated_at timestamptz not null
);

create table turbo_workouts (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  data jsonb,                     -- the workout; null once deleted
  updated_at timestamptz not null,
  deleted boolean not null default false,
  primary key (user_id, id)
);

create table turbo_rides (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  start_ts timestamptz,
  data jsonb,                     -- the ride without its samples (workout, profile, summary); null once deleted
  samples jsonb,                  -- one value per second and field, column by column
  updated_at timestamptz not null,
  deleted boolean not null default false,
  primary key (user_id, id)
);

alter table turbo_profile enable row level security;
alter table turbo_workouts enable row level security;
alter table turbo_rides enable row level security;

create policy owner_own_rows on turbo_profile for all to authenticated
  using (user_id = (select auth.uid()) and (select tri_is_owner()))
  with check (user_id = (select auth.uid()) and (select tri_is_owner()));

create policy owner_own_rows on turbo_workouts for all to authenticated
  using (user_id = (select auth.uid()) and (select tri_is_owner()))
  with check (user_id = (select auth.uid()) and (select tri_is_owner()));

create policy owner_own_rows on turbo_rides for all to authenticated
  using (user_id = (select auth.uid()) and (select tri_is_owner()))
  with check (user_id = (select auth.uid()) and (select tri_is_owner()));
