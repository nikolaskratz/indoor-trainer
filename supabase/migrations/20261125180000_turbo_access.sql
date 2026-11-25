-- Indoor Trainer: its own access list, so other people can be let in.
--
-- Until now the app used tri_owners, the list that also opens the Tri Coach tables
-- (which are not split by user). Adding a second person there would show them the
-- owner's training plan. From here on:
--   owner  = listed in tri_owners (unchanged)
--   member = signed in with an email address the owner added to turbo_members
-- Both may use the app's server side; each sees only their own rows.

create table turbo_members (
  email text primary key check (email = lower(btrim(email)) and email like '%_@_%'),
  added_at timestamptz not null default now()
);

alter table turbo_members enable row level security;

-- Only the owner sees and edits the list.
create policy owner_manages on turbo_members for all to authenticated
  using ((select tri_is_owner()))
  with check ((select tri_is_owner()));

revoke all on turbo_members from anon;

-- 'owner', 'member' or 'none' for an account. For the edge functions (service role).
create function turbo_access_of(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from public.tri_owners o where o.user_id = p_user) then 'owner'
    when exists (
      select 1
      from auth.users u
      join public.turbo_members m on m.email = lower(u.email)
      where u.id = p_user and u.email_confirmed_at is not null
    ) then 'member'
    else 'none'
  end
$$;

revoke all on function turbo_access_of(uuid) from public, anon, authenticated;
grant execute on function turbo_access_of(uuid) to service_role;

-- The same for the signed-in account. For the app and the row rules below.
create function turbo_access() returns text
language sql stable security definer set search_path = '' as $$
  select public.turbo_access_of((select auth.uid()))
$$;

revoke all on function turbo_access() from public, anon;
grant execute on function turbo_access() to authenticated, service_role;

-- Profile, workouts and rides: own rows only, for owner and members.
alter policy owner_own_rows on turbo_profile
  using (user_id = (select auth.uid()) and (select turbo_access()) <> 'none')
  with check (user_id = (select auth.uid()) and (select turbo_access()) <> 'none');
alter policy owner_own_rows on turbo_profile rename to member_own_rows;

alter policy owner_own_rows on turbo_workouts
  using (user_id = (select auth.uid()) and (select turbo_access()) <> 'none')
  with check (user_id = (select auth.uid()) and (select turbo_access()) <> 'none');
alter policy owner_own_rows on turbo_workouts rename to member_own_rows;

alter policy owner_own_rows on turbo_rides
  using (user_id = (select auth.uid()) and (select turbo_access()) <> 'none')
  with check (user_id = (select auth.uid()) and (select turbo_access()) <> 'none');
alter policy owner_own_rows on turbo_rides rename to member_own_rows;
