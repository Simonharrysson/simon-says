-- Final fix wave A3: transcripts are read only by the server (service role). Members could read
-- every segment over the REST API even when the org's share_transcript was off. Nothing in the
-- app reads segments as the user (every reader uses the service role), so the grant goes; the
-- RLS policy stays (harmless without the grant).
-- Backward compatible: no app code reads segments as `authenticated`.

revoke select on table public.segments from authenticated;
