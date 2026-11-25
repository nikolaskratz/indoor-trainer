-- Strava connection of the Indoor Trainer app, one row per user.
-- Holds OAuth tokens, so the browser gets no access at all: row level security is on
-- and there are no policies. Only the turbo-strava edge function (service role) uses it.

create table turbo_strava (
  user_id uuid primary key references auth.users on delete cascade,
  athlete_id bigint,
  athlete_name text,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scope text,
  updated_at timestamptz not null default now()
);

alter table turbo_strava enable row level security;
