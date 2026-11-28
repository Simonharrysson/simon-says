-- Konto → Koppla till din AI names each connection's app from the redirect URI it was approved
-- for (lib/mcp/oauth.ts redirectAudience), never from the name the client registered. The grant
-- keeps the redirect URI of its latest approval. Additive: a nullable column, readable by the
-- grant's own user like the other shown columns; old rows are filled where the client registered
-- exactly one URI, and stay null (a neutral icon) otherwise.

alter table public.mcp_grants add column redirect_uri text;

update public.mcp_grants g
set redirect_uri = c.redirect_uris[1]
from public.mcp_clients c
where c.id = g.client_id and cardinality(c.redirect_uris) = 1 and g.redirect_uri is null;

grant select (redirect_uri) on table public.mcp_grants to authenticated;
