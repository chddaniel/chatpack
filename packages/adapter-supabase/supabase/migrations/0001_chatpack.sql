-- Chatpack Supabase schema.
-- Apply with `supabase db push` or paste into Supabase SQL Editor.
-- This migration follows @chatpack/adapter-drizzle table names and columns.

create table if not exists public.chatpack_conversations (
  id text primary key,
  type text not null default 'direct',
  pair_key text,
  name text,
  visibility text not null default 'private',
  join_policy text not null default 'approval',
  created_at timestamptz not null,
  metadata jsonb not null default '{}',
  last_seq integer not null default 0,
  last_activity_at timestamptz not null
);

alter table public.chatpack_conversations add column if not exists type text not null default 'direct';
alter table public.chatpack_conversations add column if not exists name text;
alter table public.chatpack_conversations add column if not exists visibility text not null default 'private';
alter table public.chatpack_conversations add column if not exists join_policy text not null default 'approval';
alter table public.chatpack_conversations alter column pair_key drop not null;
drop index if exists public.chatpack_conversations_pair_key_idx;
create unique index if not exists chatpack_conversations_pair_key_unique_idx
  on public.chatpack_conversations (pair_key) where pair_key is not null;
create index if not exists chatpack_conversations_activity_idx
  on public.chatpack_conversations (last_activity_at, id);
create index if not exists chatpack_conversations_public_idx
  on public.chatpack_conversations (last_activity_at, id) where visibility = 'public';

create table if not exists public.chatpack_conversation_participants (
  conversation_id text not null references public.chatpack_conversations(id) on delete cascade,
  user_id text not null,
  role text not null default 'member',
  joined_at timestamptz not null,
  last_read_message_id text,
  primary key (conversation_id, user_id)
);
alter table public.chatpack_conversation_participants add column if not exists role text not null default 'member';
create index if not exists chatpack_participants_user_idx
  on public.chatpack_conversation_participants (user_id);

create table if not exists public.chatpack_messages (
  id text primary key,
  conversation_id text not null references public.chatpack_conversations(id) on delete cascade,
  sender_id text not null,
  body text not null,
  role text not null default 'user',
  seq bigint not null,
  created_at timestamptz not null,
  edited_at timestamptz,
  deleted_at timestamptz,
  reply_to_message_id text,
  forwarded_from_message_id text,
  forwarded_from_conversation_id text,
  forwarded_from_sender_id text,
  metadata jsonb not null default '{}',
  unique (conversation_id, seq)
);
alter table public.chatpack_messages add column if not exists reply_to_message_id text;
alter table public.chatpack_messages add column if not exists forwarded_from_message_id text;
alter table public.chatpack_messages add column if not exists forwarded_from_conversation_id text;
alter table public.chatpack_messages add column if not exists forwarded_from_sender_id text;
create index if not exists chatpack_messages_forwarded_from_idx
  on public.chatpack_messages (forwarded_from_message_id)
  where forwarded_from_message_id is not null;

create table if not exists public.chatpack_message_search_tokens (
  message_id text not null references public.chatpack_messages(id) on delete cascade,
  token text not null,
  occurrences integer not null,
  primary key (message_id, token)
);
create index if not exists chatpack_message_search_tokens_token_idx
  on public.chatpack_message_search_tokens (token, message_id);

create table if not exists public.chatpack_message_reactions (
  message_id text not null references public.chatpack_messages(id) on delete cascade,
  user_id text not null,
  emoji text not null,
  created_at timestamptz not null,
  unique (message_id, user_id, emoji)
);
create index if not exists chatpack_reactions_message_idx
  on public.chatpack_message_reactions (message_id, created_at);

create table if not exists public.chatpack_message_mentions (
  message_id text not null references public.chatpack_messages(id) on delete cascade,
  user_id text not null,
  created_at timestamptz not null,
  unique (message_id, user_id)
);
create index if not exists chatpack_mentions_message_idx
  on public.chatpack_message_mentions (message_id, created_at, user_id);
create index if not exists chatpack_mentions_user_idx
  on public.chatpack_message_mentions (user_id, created_at);

create table if not exists public.chatpack_conversation_invites (
  code text primary key,
  conversation_id text not null references public.chatpack_conversations(id) on delete cascade,
  created_by text not null,
  created_at timestamptz not null,
  expires_at timestamptz,
  max_uses integer,
  uses integer not null default 0,
  requires_approval boolean not null default false,
  metadata jsonb not null default '{}'
);
create index if not exists chatpack_invites_conversation_idx
  on public.chatpack_conversation_invites (conversation_id, created_at);

create table if not exists public.chatpack_join_requests (
  id text primary key,
  conversation_id text not null references public.chatpack_conversations(id) on delete cascade,
  user_id text not null,
  status text not null default 'pending',
  message text,
  invite_code text,
  created_at timestamptz not null,
  resolved_at timestamptz,
  resolved_by text,
  metadata jsonb not null default '{}',
  unique (conversation_id, user_id)
);
create index if not exists chatpack_join_requests_status_idx
  on public.chatpack_join_requests (conversation_id, status, created_at);

create table if not exists public.chatpack_user_blocks (
  blocker_user_id text not null,
  blocked_user_id text not null,
  created_at timestamptz not null,
  primary key (blocker_user_id, blocked_user_id)
);
create index if not exists chatpack_user_blocks_blocker_idx
  on public.chatpack_user_blocks (blocker_user_id, created_at);

create table if not exists public.chatpack_conversation_mutes (
  user_id text not null,
  conversation_id text not null references public.chatpack_conversations(id) on delete cascade,
  created_at timestamptz not null,
  primary key (user_id, conversation_id)
);
create index if not exists chatpack_conversation_mutes_user_idx
  on public.chatpack_conversation_mutes (user_id, created_at);

create table if not exists public.chatpack_moderation_reports (
  id text primary key,
  reporter_user_id text not null,
  target_type text not null,
  target_id text not null,
  reason text not null,
  status text not null default 'open',
  moderator_note text,
  evidence jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists chatpack_moderation_reports_queue_idx
  on public.chatpack_moderation_reports (status, created_at, id);
create index if not exists chatpack_moderation_reports_target_idx
  on public.chatpack_moderation_reports (reporter_user_id, target_type, target_id, status);

create table if not exists public.chatpack_user_bans (
  id text primary key,
  user_id text not null,
  created_by_user_id text not null,
  reason text,
  created_at timestamptz not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id text
);
create index if not exists chatpack_user_bans_active_idx
  on public.chatpack_user_bans (user_id, revoked_at, expires_at);
create index if not exists chatpack_user_bans_created_idx
  on public.chatpack_user_bans (created_at, id);

-- Atomic direct creation. The partial unique index is repeated in ON CONFLICT.
create or replace function public.chatpack_get_or_create_direct_conversation(
  p_pair_key text, p_user_ids text[], p_metadata jsonb, p_id text, p_created_at timestamptz
) returns table(conversation_id text, created boolean)
language plpgsql as $$
begin
  insert into public.chatpack_conversations
    (id, type, pair_key, name, visibility, join_policy, created_at, metadata, last_seq, last_activity_at)
  values (p_id, 'direct', p_pair_key, null, 'private', 'approval', p_created_at, coalesce(p_metadata, '{}'), 0, p_created_at)
  on conflict (pair_key) where pair_key is not null do nothing;
  if found then
    insert into public.chatpack_conversation_participants
      (conversation_id, user_id, role, joined_at, last_read_message_id)
    values (p_id, p_user_ids[1], 'admin', p_created_at, null), (p_id, p_user_ids[2], 'admin', p_created_at, null);
    return query select p_id, true;
  else
    return query select c.id, false from public.chatpack_conversations c where c.pair_key = p_pair_key;
  end if;
end;
$$;

-- Atomic group creation: conversation and all participant rows share one RPC transaction.
create or replace function public.chatpack_create_group_conversation(
  p_id text, p_creator_id text, p_user_ids text[], p_name text, p_visibility text,
  p_join_policy text, p_metadata jsonb, p_created_at timestamptz
) returns setof public.chatpack_conversations
language plpgsql as $$
begin
  insert into public.chatpack_conversations
    (id, type, pair_key, name, visibility, join_policy, created_at, metadata, last_seq, last_activity_at)
  values (p_id, 'group', null, p_name, p_visibility, p_join_policy, p_created_at, coalesce(p_metadata, '{}'), 0, p_created_at);
  insert into public.chatpack_conversation_participants
    (conversation_id, user_id, role, joined_at, last_read_message_id)
  values (p_id, p_creator_id, 'admin', p_created_at, null)
  on conflict (conversation_id, user_id) do nothing;
  insert into public.chatpack_conversation_participants
    (conversation_id, user_id, role, joined_at, last_read_message_id)
  select p_id, u, 'member', p_created_at, null from unnest(p_user_ids) as u
  on conflict (conversation_id, user_id) do nothing;
  return query select * from public.chatpack_conversations where id = p_id;
end;
$$;

-- Atomic sequence allocation, message insertion, and canonical token insertion.
create or replace function public.chatpack_add_message(
  p_id text, p_conversation_id text, p_sender_id text, p_body text, p_role text,
  p_reply_to_message_id text, p_forwarded_from_message_id text,
  p_forwarded_from_conversation_id text, p_forwarded_from_sender_id text,
  p_metadata jsonb, p_created_at timestamptz, p_tokens jsonb
) returns setof public.chatpack_messages
language plpgsql as $$
declare
  v_seq bigint;
begin
  update public.chatpack_conversations
  set last_seq = last_seq + 1, last_activity_at = p_created_at
  where id = p_conversation_id
  returning last_seq into v_seq;
  if not found then raise exception 'unknown conversation %', p_conversation_id; end if;
  insert into public.chatpack_messages
    (id, conversation_id, sender_id, body, role, seq, created_at, edited_at, deleted_at,
     reply_to_message_id, forwarded_from_message_id, forwarded_from_conversation_id,
     forwarded_from_sender_id, metadata)
  values (p_id, p_conversation_id, p_sender_id, p_body, p_role, v_seq, p_created_at, null, null,
          p_reply_to_message_id, p_forwarded_from_message_id, p_forwarded_from_conversation_id,
          p_forwarded_from_sender_id, coalesce(p_metadata, '{}'));
  insert into public.chatpack_message_search_tokens (message_id, token, occurrences)
  select x.message_id, x.token, x.occurrences
  from jsonb_to_recordset(coalesce(p_tokens, '[]')) as x(message_id text, token text, occurrences integer)
  on conflict (message_id, token) do update set occurrences = excluded.occurrences;
  return query select * from public.chatpack_messages where id = p_id;
end;
$$;

create or replace function public.chatpack_update_message(
  p_message_id text, p_body text, p_body_set boolean, p_edited_at timestamptz,
  p_edited_at_set boolean, p_deleted_at timestamptz, p_deleted_at_set boolean, p_tokens jsonb
) returns setof public.chatpack_messages
language plpgsql as $$
declare v_row public.chatpack_messages%rowtype;
begin
  update public.chatpack_messages
  set body = case when p_body_set then p_body else body end,
      edited_at = case when p_edited_at_set then p_edited_at else edited_at end,
      deleted_at = case when p_deleted_at_set then p_deleted_at else deleted_at end
  where id = p_message_id returning * into v_row;
  if not found then return; end if;
  if p_body_set or p_deleted_at_set then
    delete from public.chatpack_message_search_tokens where message_id = p_message_id;
    if v_row.deleted_at is null then
      insert into public.chatpack_message_search_tokens (message_id, token, occurrences)
      select x.message_id, x.token, x.occurrences
      from jsonb_to_recordset(coalesce(p_tokens, '[]')) as x(message_id text, token text, occurrences integer)
      on conflict (message_id, token) do update set occurrences = excluded.occurrences;
    end if;
  end if;
  return next v_row;
end;
$$;

create or replace function public.chatpack_replace_message_mentions(
  p_message_id text, p_user_ids text[], p_created_at timestamptz
) returns void language plpgsql as $$
begin
  delete from public.chatpack_message_mentions
  where message_id = p_message_id and (coalesce(array_length(p_user_ids, 1), 0) = 0 or user_id <> all(p_user_ids));
  insert into public.chatpack_message_mentions (message_id, user_id, created_at)
  select p_message_id, u, p_created_at from unnest(coalesce(p_user_ids, '{}')) as u
  on conflict (message_id, user_id) do nothing;
end;
$$;

create or replace function public.chatpack_count_unread(p_user_id text, p_conversation_ids text[])
returns table(conversation_id text, count bigint) language sql as $$
  select m.conversation_id, count(*)
  from public.chatpack_messages m
  join public.chatpack_conversation_participants p
    on p.conversation_id = m.conversation_id and p.user_id = p_user_id
  left join public.chatpack_messages read_message on read_message.id = p.last_read_message_id
  where m.conversation_id = any(p_conversation_ids)
    and m.sender_id <> p_user_id
    and m.seq > coalesce(read_message.seq, 0)
  group by m.conversation_id;
$$;

create or replace function public.chatpack_consume_invite(p_code text, p_now timestamptz)
returns setof public.chatpack_conversation_invites language sql as $$
  update public.chatpack_conversation_invites
  set uses = uses + 1
  where code = p_code
    and (max_uses is null or uses < max_uses)
    and (expires_at is null or expires_at > p_now)
  returning *;
$$;

-- Advisory lock makes the active-ban uniqueness decision atomic even though the
-- logical constraint is time-dependent and cannot be a normal partial index.
create or replace function public.chatpack_create_ban(
  p_id text, p_user_id text, p_created_by_user_id text, p_reason text,
  p_expires_at timestamptz, p_created_at timestamptz
) returns setof public.chatpack_user_bans language plpgsql as $$
declare v_row public.chatpack_user_bans%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id, 0));
  select * into v_row from public.chatpack_user_bans
  where user_id = p_user_id and revoked_at is null and (expires_at is null or expires_at > p_created_at)
  order by created_at desc limit 1;
  if not found then
    insert into public.chatpack_user_bans
      (id, user_id, created_by_user_id, reason, created_at, expires_at, revoked_at, revoked_by_user_id)
    values (p_id, p_user_id, p_created_by_user_id, p_reason, p_created_at, p_expires_at, null, null)
    returning * into v_row;
  end if;
  return next v_row;
end;
$$;

create or replace function public.chatpack_search_messages(
  p_user_id text, p_terms text[], p_cursor_rank integer, p_cursor_created_at timestamptz,
  p_cursor_id text, p_limit integer
) returns table(
  id text, conversation_id text, sender_id text, body text, role text, seq bigint,
  created_at timestamptz, edited_at timestamptz, deleted_at timestamptz,
  reply_to_message_id text, forwarded_from_message_id text,
  forwarded_from_conversation_id text, forwarded_from_sender_id text, metadata jsonb,
  rank integer
) language sql as $$
  with matches as (
    select m.*, sum(t.occurrences)::integer as rank
    from public.chatpack_messages m
    join public.chatpack_message_search_tokens t on t.message_id = m.id
    join public.chatpack_conversation_participants p on p.conversation_id = m.conversation_id
    where p.user_id = p_user_id and m.deleted_at is null and t.token = any(p_terms)
    group by m.id
    having count(distinct t.token) = cardinality(p_terms)
  )
  select m.id, m.conversation_id, m.sender_id, m.body, m.role, m.seq, m.created_at,
         m.edited_at, m.deleted_at, m.reply_to_message_id, m.forwarded_from_message_id,
         m.forwarded_from_conversation_id, m.forwarded_from_sender_id, m.metadata, m.rank
  from matches m
  where p_cursor_rank is null
     or m.rank < p_cursor_rank
     or (m.rank = p_cursor_rank and m.created_at < p_cursor_created_at)
     or (m.rank = p_cursor_rank and m.created_at = p_cursor_created_at and m.id < p_cursor_id)
  order by m.rank desc, m.created_at desc, m.id desc
  limit p_limit;
$$;

-- Chatpack data is server-only. RLS is enabled with no public policies.
do $$ declare t text; begin
  foreach t in array array[
    'chatpack_conversations', 'chatpack_conversation_participants', 'chatpack_messages',
    'chatpack_message_search_tokens', 'chatpack_message_reactions', 'chatpack_message_mentions',
    'chatpack_conversation_invites', 'chatpack_join_requests', 'chatpack_user_blocks',
    'chatpack_conversation_mutes', 'chatpack_moderation_reports', 'chatpack_user_bans'
  ] loop execute format('alter table public.%I enable row level security', t); end loop;
end $$;

revoke all on all tables in schema public from anon, authenticated;
-- New Supabase projects can require explicit Data API grants. Keep these
-- tables reachable only by the privileged server-side adapter client.
grant all on table
  public.chatpack_conversations,
  public.chatpack_conversation_participants,
  public.chatpack_messages,
  public.chatpack_message_search_tokens,
  public.chatpack_message_reactions,
  public.chatpack_message_mentions,
  public.chatpack_conversation_invites,
  public.chatpack_join_requests,
  public.chatpack_user_blocks,
  public.chatpack_conversation_mutes,
  public.chatpack_moderation_reports,
  public.chatpack_user_bans
to service_role;
revoke execute on function public.chatpack_get_or_create_direct_conversation(text,text[],jsonb,text,timestamptz) from public;
revoke execute on function public.chatpack_create_group_conversation(text,text,text[],text,text,text,jsonb,timestamptz) from public;
revoke execute on function public.chatpack_add_message(text,text,text,text,text,text,text,text,text,jsonb,timestamptz,jsonb) from public;
revoke execute on function public.chatpack_update_message(text,text,boolean,timestamptz,boolean,timestamptz,boolean,jsonb) from public;
revoke execute on function public.chatpack_replace_message_mentions(text,text[],timestamptz) from public;
revoke execute on function public.chatpack_count_unread(text,text[]) from public;
revoke execute on function public.chatpack_consume_invite(text,timestamptz) from public;
revoke execute on function public.chatpack_create_ban(text,text,text,text,timestamptz,timestamptz) from public;
revoke execute on function public.chatpack_search_messages(text,text[],integer,timestamptz,text,integer) from public;
grant execute on all functions in schema public to service_role;
