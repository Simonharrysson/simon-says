-- Task 5 fix round 1: atomic ingest caps and merge aliases. Additive.
--
-- * speaker_map.merged_into_label: "this label now means that label" (same ElevenLabs
--   session). Resolved at read time (lib/segments/resolve.ts), so a merge made before the
--   target is identified, and chains A -> B -> C, stay correct.
-- * ingest_segments(): rate/size caps, insert and merges in ONE transaction under a per-meeting
--   advisory lock, so parallel requests cannot all pass the check. Only keys not yet stored
--   count (a resend after a crash is free). Caps per meeting: 120 runs/min (merged labels
--   count as runs), 20 000 chars/min, 600 000 chars in total.

alter table public.speaker_map add column merged_into_label text;

create function public.ingest_segments(p_meeting_id uuid, p_rows jsonb, p_merges jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  c_runs_per_min constant int := 120;
  c_chars_per_min constant int := 20000;
  c_chars_total constant int := 600000;
  v_new_runs int;
  v_new_chars bigint;
  v_merge_labels int;
  v_recent_runs int;
  v_recent_chars bigint;
  v_total_chars bigint;
  v_stored int;
  m jsonb;
  f text;
  v_into text;
  v_cur text;
  v_hops int;
  v_known boolean;
begin
  perform pg_advisory_xact_lock(hashtext(p_meeting_id::text));

  create temp table if not exists pg_temp._ingest_new (
    el_session_id text, segment_index int, run_index int, speaker text, text text,
    start_ms bigint, end_ms bigint, lang text
  ) on commit drop;
  truncate pg_temp._ingest_new;

  -- New keys only (not stored yet), one row per key.
  insert into pg_temp._ingest_new
  select distinct on (r.el_session_id, r.segment_index, r.run_index)
    r.el_session_id, r.segment_index, r.run_index, r.speaker, r.text, r.start_ms, r.end_ms, r.lang
  from jsonb_to_recordset(p_rows) as r(
    el_session_id text, segment_index int, run_index int, speaker text, text text,
    start_ms bigint, end_ms bigint, lang text
  )
  where not exists (
    select 1 from public.segments s
    where s.el_session_id = r.el_session_id and s.segment_index = r.segment_index and s.run_index = r.run_index
  );

  select count(*), coalesce(sum(length(text)), 0) into v_new_runs, v_new_chars from pg_temp._ingest_new;

  select count(*) into v_merge_labels from (
    select distinct mm ->> 'el_session_id' as sid, ff
    from jsonb_array_elements(p_merges) mm, jsonb_array_elements_text(mm -> 'from') ff
  ) x;

  select count(*), coalesce(sum(length(text)), 0) into v_recent_runs, v_recent_chars
  from public.segments where meeting_id = p_meeting_id and created_at > now() - interval '60 seconds';
  select coalesce(sum(length(text)), 0) into v_total_chars from public.segments where meeting_id = p_meeting_id;

  if v_recent_runs + v_new_runs + v_merge_labels > c_runs_per_min then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  if v_recent_chars + v_new_chars > c_chars_per_min then
    return jsonb_build_object('status', 'chars_per_min');
  end if;
  if v_total_chars + v_new_chars > c_chars_total then
    return jsonb_build_object('status', 'chars_total');
  end if;

  -- Merges: every `from` label must have appeared in that session's segments (stored or in
  -- this batch); no cycles.
  for m in select * from jsonb_array_elements(p_merges) loop
    v_into := m ->> 'into';
    for f in select jsonb_array_elements_text(m -> 'from') loop
      if f = v_into then continue; end if;
      select exists (
        select 1 from public.segments s
        where s.meeting_id = p_meeting_id and s.el_session_id = m ->> 'el_session_id' and s.speaker = f
      ) or exists (
        select 1 from pg_temp._ingest_new n where n.el_session_id = m ->> 'el_session_id' and n.speaker = f
      ) into v_known;
      if not v_known then
        return jsonb_build_object('status', 'unknown_speaker');
      end if;
      -- Would `into` already resolve to `f`?
      v_cur := v_into; v_hops := 0;
      while v_cur is not null and v_hops < 50 loop
        if v_cur = f then return jsonb_build_object('status', 'merge_cycle'); end if;
        select sm.merged_into_label into v_cur from public.speaker_map sm
        where sm.meeting_id = p_meeting_id and sm.el_session_id = m ->> 'el_session_id' and sm.speaker_label = v_cur;
        v_hops := v_hops + 1;
      end loop;
    end loop;
  end loop;

  insert into public.segments (meeting_id, el_session_id, segment_index, run_index, speaker, text, start_ms, end_ms, lang)
  select p_meeting_id, el_session_id, segment_index, run_index, speaker, text, start_ms, end_ms, lang from pg_temp._ingest_new
  on conflict do nothing;
  get diagnostics v_stored = row_count;

  for m in select * from jsonb_array_elements(p_merges) loop
    v_into := m ->> 'into';
    for f in select jsonb_array_elements_text(m -> 'from') loop
      if f = v_into then continue; end if;
      insert into public.speaker_map (meeting_id, el_session_id, speaker_label, display_name, merged_into_label)
      values (p_meeting_id, m ->> 'el_session_id', f, f, v_into)
      on conflict (meeting_id, el_session_id, speaker_label)
      do update set merged_into_label = excluded.merged_into_label, needs_confirm = false;
    end loop;
  end loop;

  return jsonb_build_object('status', 'ok', 'stored', v_stored);
end;
$$;

revoke all on function public.ingest_segments(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_segments(uuid, jsonb, jsonb) to service_role;
