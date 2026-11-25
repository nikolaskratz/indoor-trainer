-- Indoor Trainer: a spending guard for the workout generator.
--
-- Every call to Claude is written down per account, with its tokens and estimated cost.
-- Before a call the edge function asks turbo_usage_start, which refuses when the account
-- has made too many requests in the last hour or has used up its budget for the calendar
-- month (UTC). The limits live in turbo_limits below: change them there, nothing else.

create table turbo_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  at timestamptz not null default now(),
  kind text not null,
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(10, 5) not null default 0
);

create index turbo_usage_user_at on turbo_usage (user_id, at desc);

-- Only the edge function (service role) reads and writes it.
alter table turbo_usage enable row level security;
revoke all on turbo_usage from anon, authenticated;

-- The limits per kind of account: requests per rolling hour, US dollars per calendar month.
create function turbo_limits(p_access text, out max_per_hour integer, out month_usd numeric)
language sql immutable set search_path = '' as $$
  select
    case p_access when 'owner' then 30 when 'member' then 10 else 0 end,
    case p_access when 'owner' then 20 when 'member' then 3 else 0 end::numeric
$$;

-- Reserves one request for the account, or says why not. Returns
--   {ok: true, id}                                   the row to fill in afterwards
--   {ok: false, reason: 'hour', retry_at, limit}     too many requests in the last hour
--   {ok: false, reason: 'month', limit}              this month's budget is used up
--   {ok: false, reason: 'access'}                    the account may not use the generator
-- A request counts from the moment it is reserved, so parallel calls cannot slip past
-- the hourly limit; its cost is added when the answer is in.
create function turbo_usage_start(p_user uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  lim record;
  recent integer;
  oldest timestamptz;
  spent numeric;
  new_id bigint;
begin
  select * into lim from public.turbo_limits(public.turbo_access_of(p_user));
  if lim.max_per_hour = 0 then
    return jsonb_build_object('ok', false, 'reason', 'access');
  end if;

  -- One at a time per account.
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));

  select count(*), min(u.at) into recent, oldest
  from public.turbo_usage u
  where u.user_id = p_user and u.at > now() - interval '1 hour';
  if recent >= lim.max_per_hour then
    return jsonb_build_object('ok', false, 'reason', 'hour', 'limit', lim.max_per_hour, 'retry_at', oldest + interval '1 hour');
  end if;

  select coalesce(sum(u.cost_usd), 0) into spent
  from public.turbo_usage u
  where u.user_id = p_user and u.at >= date_trunc('month', now());
  if spent >= lim.month_usd then
    return jsonb_build_object('ok', false, 'reason', 'month', 'limit', lim.month_usd);
  end if;

  insert into public.turbo_usage (user_id, kind) values (p_user, p_kind) returning id into new_id;
  return jsonb_build_object('ok', true, 'id', new_id);
end
$$;

revoke all on function turbo_usage_start(uuid, text) from public, anon, authenticated;
grant execute on function turbo_usage_start(uuid, text) to service_role;

-- For the owner's "People with access" card: this month's use per person, the owner included.
-- Anyone else gets no rows.
create function turbo_usage_summary()
returns table (email text, access text, requests bigint, cost_usd numeric, month_usd numeric)
language sql stable security definer set search_path = '' as $$
  with people as (
    select u.id, lower(u.email) as email, public.turbo_access_of(u.id) as access
    from auth.users u
    where u.id in (select o.user_id from public.tri_owners o)
       or lower(u.email) in (select m.email from public.turbo_members m)
  )
  select p.email::text, p.access,
         count(g.id), coalesce(sum(g.cost_usd), 0),
         (public.turbo_limits(p.access)).month_usd
  from people p
  left join public.turbo_usage g on g.user_id = p.id and g.at >= date_trunc('month', now())
  where (select public.tri_is_owner()) and p.access <> 'none'
  group by p.email, p.access
$$;

revoke all on function turbo_usage_summary() from public, anon;
grant execute on function turbo_usage_summary() to authenticated, service_role;
