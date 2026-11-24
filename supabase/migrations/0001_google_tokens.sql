-- Google refresh tokens, AES-256-GCM encrypted by the app (lib/crypto.ts).
-- Service role only: RLS on with no policies, and no grants to anon/authenticated.
-- Idempotent on purpose: it was applied to simonsays-prod by hand (Task 2) before the
-- GitHub integration ran it, so a second run must be a no-op.

create table if not exists public.google_tokens (
  user_id uuid primary key references auth.users (id) on delete cascade,
  refresh_token_enc text not null,
  scope text not null,
  updated_at timestamptz not null default now()
);

alter table public.google_tokens enable row level security;

revoke all on table public.google_tokens from anon, authenticated;
grant select, insert, update, delete on table public.google_tokens to service_role;
