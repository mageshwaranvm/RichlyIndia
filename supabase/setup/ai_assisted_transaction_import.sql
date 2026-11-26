-- RichlyIndia AI-assisted Gmail transaction import
-- Applied to Supabase project ywqbohjcijdujtgmylul on 2026-11-26.

create table if not exists public.richly_ai_import_tokens (
  token_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

alter table public.richly_ai_import_tokens enable row level security;
revoke all on table public.richly_ai_import_tokens from anon, authenticated;
grant all on table public.richly_ai_import_tokens to service_role;

drop policy if exists "deny direct access to AI import tokens" on public.richly_ai_import_tokens;
create policy "deny direct access to AI import tokens"
on public.richly_ai_import_tokens
for all to anon, authenticated
using (false) with check (false);

create or replace function public.consume_richly_ai_import(
  p_token_hash text,
  p_transactions jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_existing jsonb;
  v_tx jsonb;
  v_fp text;
  v_added integer := 0;
  v_duplicates integer := 0;
begin
  if p_transactions is null
     or jsonb_typeof(p_transactions) <> 'array'
     or jsonb_array_length(p_transactions) < 1
     or jsonb_array_length(p_transactions) > 100 then
    raise exception 'invalid transaction batch';
  end if;

  select user_id into v_user_id
  from public.richly_ai_import_tokens
  where token_hash = p_token_hash
    and used_at is null
    and expires_at > now()
  for update;

  if not found then
    raise exception 'invalid, expired, or already used import token';
  end if;

  update public.richly_ai_import_tokens
  set used_at = now()
  where token_hash = p_token_hash;

  insert into public.richly_data (user_id, transactions, updated_at)
  values (v_user_id, '[]'::jsonb, now()::text)
  on conflict (user_id) do nothing;

  select coalesce(transactions, '[]'::jsonb)
    into v_existing
  from public.richly_data
  where user_id = v_user_id
  for update;

  for v_tx in select value from jsonb_array_elements(p_transactions)
  loop
    v_fp := v_tx->>'importFingerprint';
    if v_fp is null or length(v_fp) < 8 then
      raise exception 'transaction fingerprint missing';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(v_existing) as e(value)
      where coalesce(
        e.value->>'importFingerprint',
        upper(regexp_replace(trim(coalesce(e.value->>'account','')), '\s+', ' ', 'g'))
          || '|' || coalesce(e.value->>'date','')
          || '|' || to_char(coalesce((e.value->>'amount')::numeric,0), 'FM999999999999999990.00')
          || '|' || coalesce(e.value->>'type','expense')
          || '|' || trim(regexp_replace(
               regexp_replace(upper(coalesce(e.value->>'description',e.value->>'note','')), '[^A-Z0-9]+', ' ', 'g'),
               '\s+', ' ', 'g'))
      ) = v_fp
    ) then
      v_duplicates := v_duplicates + 1;
    else
      v_existing := v_existing || jsonb_build_array(v_tx);
      v_added := v_added + 1;
    end if;
  end loop;

  update public.richly_data
  set transactions = v_existing, updated_at = now()::text
  where user_id = v_user_id;

  return jsonb_build_object('added', v_added, 'duplicates', v_duplicates);
end;
$$;

revoke all on function public.consume_richly_ai_import(text, jsonb) from public, anon, authenticated;
grant execute on function public.consume_richly_ai_import(text, jsonb) to service_role;
