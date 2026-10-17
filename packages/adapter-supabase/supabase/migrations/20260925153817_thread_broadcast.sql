-- A thread reply can also appear in the main conversation without duplicating its row.
alter table public.chatpack_messages add column if not exists show_in_main boolean not null default false;

-- RPC arguments change; remove the previous overload so service callers cannot bypass the new contract.
drop function if exists public.chatpack_add_message(text, text, text, text, text, text, text, text, text, text, jsonb, timestamptz, jsonb);
create or replace function public.chatpack_add_message(
  p_id text, p_conversation_id text, p_sender_id text, p_body text, p_role text,
  p_reply_to_message_id text, p_thread_root_message_id text, p_show_in_main boolean,
  p_forwarded_from_message_id text, p_forwarded_from_conversation_id text, p_forwarded_from_sender_id text,
  p_metadata jsonb, p_created_at timestamptz, p_tokens jsonb
) returns setof public.chatpack_messages
language plpgsql as $$
declare
  v_seq bigint;
begin
  update public.chatpack_conversations
  set last_seq = last_seq + 1,
      last_activity_at = case when p_thread_root_message_id is null or p_show_in_main then p_created_at else last_activity_at end
  where id = p_conversation_id
  returning last_seq into v_seq;
  if not found then raise exception 'unknown conversation %', p_conversation_id; end if;
  insert into public.chatpack_messages
    (id, conversation_id, sender_id, body, role, seq, created_at, edited_at, deleted_at,
     reply_to_message_id, thread_root_message_id, show_in_main, forwarded_from_message_id,
     forwarded_from_conversation_id, forwarded_from_sender_id, metadata)
  values (p_id, p_conversation_id, p_sender_id, p_body, p_role, v_seq, p_created_at, null, null,
          p_reply_to_message_id, p_thread_root_message_id, p_show_in_main, p_forwarded_from_message_id,
          p_forwarded_from_conversation_id, p_forwarded_from_sender_id, coalesce(p_metadata, '{}'));
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
    and (m.thread_root_message_id is null or m.show_in_main)
    and m.sender_id <> p_user_id
    and m.seq > coalesce(read_message.seq, 0)
  group by m.conversation_id;
$$;

revoke execute on function public.chatpack_add_message(text, text, text, text, text, text, text, boolean, text, text, text, jsonb, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.chatpack_add_message(text, text, text, text, text, text, text, boolean, text, text, text, jsonb, timestamptz, jsonb) to service_role;
revoke execute on function public.chatpack_count_unread(text, text[]) from public, anon, authenticated;
grant execute on function public.chatpack_count_unread(text, text[]) to service_role;
