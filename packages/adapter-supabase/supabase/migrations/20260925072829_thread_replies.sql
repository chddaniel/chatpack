-- Add one-level message threads to existing Chatpack Supabase installations.
alter table public.chatpack_messages add column if not exists thread_root_message_id text;
create index if not exists chatpack_messages_thread_root_seq_idx
  on public.chatpack_messages (thread_root_message_id, seq)
  where thread_root_message_id is not null;

-- The new argument and search return column change these function signatures.
drop function if exists public.chatpack_add_message(text, text, text, text, text, text, text, text, text, jsonb, timestamptz, jsonb);
drop function if exists public.chatpack_search_messages(text, text[], integer, timestamptz, text, integer);

create or replace function public.chatpack_add_message(
  p_id text, p_conversation_id text, p_sender_id text, p_body text, p_role text,
  p_reply_to_message_id text, p_thread_root_message_id text, p_forwarded_from_message_id text,
  p_forwarded_from_conversation_id text, p_forwarded_from_sender_id text,
  p_metadata jsonb, p_created_at timestamptz, p_tokens jsonb
) returns setof public.chatpack_messages
language plpgsql as $$
declare
  v_seq bigint;
begin
  update public.chatpack_conversations
  set last_seq = last_seq + 1,
      last_activity_at = case when p_thread_root_message_id is null then p_created_at else last_activity_at end
  where id = p_conversation_id
  returning last_seq into v_seq;
  if not found then raise exception 'unknown conversation %', p_conversation_id; end if;
  insert into public.chatpack_messages
    (id, conversation_id, sender_id, body, role, seq, created_at, edited_at, deleted_at,
     reply_to_message_id, thread_root_message_id, forwarded_from_message_id, forwarded_from_conversation_id,
     forwarded_from_sender_id, metadata)
  values (p_id, p_conversation_id, p_sender_id, p_body, p_role, v_seq, p_created_at, null, null,
          p_reply_to_message_id, p_thread_root_message_id, p_forwarded_from_message_id, p_forwarded_from_conversation_id,
          p_forwarded_from_sender_id, coalesce(p_metadata, '{}'));
  insert into public.chatpack_message_search_tokens (message_id, token, occurrences)
  select x.message_id, x.token, x.occurrences
  from jsonb_to_recordset(coalesce(p_tokens, '[]')) as x(message_id text, token text, occurrences integer)
  on conflict (message_id, token) do update set occurrences = excluded.occurrences;
  return query select * from public.chatpack_messages where id = p_id;
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
    and m.thread_root_message_id is null
    and m.sender_id <> p_user_id
    and m.seq > coalesce(read_message.seq, 0)
  group by m.conversation_id;
$$;

create or replace function public.chatpack_count_thread_replies(p_root_message_ids text[])
returns table(thread_root_message_id text, count bigint) language sql stable as $$
  select m.thread_root_message_id, count(*)
  from public.chatpack_messages m
  where m.thread_root_message_id = any(p_root_message_ids)
  group by m.thread_root_message_id;
$$;

create or replace function public.chatpack_search_messages(
  p_user_id text, p_terms text[], p_cursor_rank integer, p_cursor_created_at timestamptz,
  p_cursor_id text, p_limit integer
) returns table(
  id text, conversation_id text, sender_id text, body text, role text, seq bigint,
  created_at timestamptz, edited_at timestamptz, deleted_at timestamptz,
  reply_to_message_id text, thread_root_message_id text, forwarded_from_message_id text,
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
         m.edited_at, m.deleted_at, m.reply_to_message_id, m.thread_root_message_id, m.forwarded_from_message_id,
         m.forwarded_from_conversation_id, m.forwarded_from_sender_id, m.metadata, m.rank
  from matches m
  where p_cursor_rank is null
     or m.rank < p_cursor_rank
     or (m.rank = p_cursor_rank and m.created_at < p_cursor_created_at)
     or (m.rank = p_cursor_rank and m.created_at = p_cursor_created_at and m.id < p_cursor_id)
  order by m.rank desc, m.created_at desc, m.id desc
  limit p_limit;
$$;

-- Keep the server-only RPC boundary after replacing function signatures.
do $$
declare object_row record;
begin
  for object_row in
    select n.nspname as schema_name, p.proname as function_name,
           pg_get_function_identity_arguments(p.oid) as arguments
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('chatpack_add_message', 'chatpack_count_unread',
                        'chatpack_count_thread_replies', 'chatpack_search_messages')
  loop
    execute format('revoke execute on function %I.%I(%s) from public, anon, authenticated',
      object_row.schema_name, object_row.function_name, object_row.arguments);
    execute format('grant execute on function %I.%I(%s) to service_role',
      object_row.schema_name, object_row.function_name, object_row.arguments);
  end loop;
end $$;
