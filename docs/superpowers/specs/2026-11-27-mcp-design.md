# Simon Says MCP server — design (owner decisions 2026-11-27 are marked **[decided]**; open questions go in the PR body)

Goal: a user's own Claude (claude.ai custom connector, Claude Desktop, Claude Code) can search their meetings, read one, list and tick their tasks and add a point to the next agenda, **as that user and nothing more**. Focus stays on information management: no editing or deleting notes **[decided]**.

## What the user gets
1. **Lägg till i Claude**: claude.ai → Settings → Connectors → custom connector `https://simonsays.harrysson.co/api/mcp`, or `claude mcp add --transport http simon-says https://simonsays.harrysson.co/api/mcp`. Claude opens our page, the user signs in with Google as today and sees **"Ge Claude tillgång till dina möten i Simon Says"** with Godkänn / Avbryt.
2. **Konto → Kopplade AI-assistenter**: each connection (client name, connected, last used) with **Återkalla**, and the last 20 calls (tool, time, nothing else).
3. Gated by the Företag allow-list (`lib/foretag/gate.ts`) until tested **[decided]**, checked at consent and on every call.

## Shape
- **One remote server on the existing app** at `/api/mcp`, Streamable HTTP, `@modelcontextprotocol/sdk` 1.32.2 **[decided]**. It is **stateless**: each POST gets a fresh `McpServer` plus a `WebStandardStreamableHTTPServerTransport` (no session id, JSON responses), which fits Vercel functions. GET and DELETE answer 405.
- **We are our own OAuth 2.1 authorization server** **[decided]**. These are route handlers that mirror the SDK's Express handlers (`server/auth/handlers/*`) and reuse its zod schemas from `shared/auth`:
  - `/.well-known/oauth-protected-resource[/api/mcp]` (RFC 9728): resource `…/api/mcp`, AS = the app origin, scope `meetings`.
  - `/.well-known/oauth-authorization-server` (RFC 8414): S256 only, `token_endpoint_auth_methods_supported: ["none"]`, grants `authorization_code` and `refresh_token`.
  - `POST /api/oauth/register` (RFC 7591 DCR), `GET /oauth/authorize`, `POST /api/oauth/token`, `POST /api/oauth/revoke` (RFC 7009).
  - A 401 from `/api/mcp` carries `WWW-Authenticate: Bearer resource_metadata="…", scope="meetings"`.
- **Authorize flow.** `/oauth/authorize` validates client, redirect URI, `response_type=code`, PKCE `S256` and `resource`. It stores the request server-side (`mcp_auth_requests`, 10 min) and redirects to `/koppla/<id>`. Only that opaque id travels through `/login?next=`, so no OAuth parameters pass through the login, and `safeNextPath` stays strict. The consent page needs a session, and Godkänn is a server action (Next checks the Origin, which covers CSRF; every page already sends `frame-ancestors 'none'`). Approving creates a single-use code (60 s, bound to client, redirect URI, PKCE challenge, resource and user). The page then redirects to `redirect_uri?code&state&iss`. An unknown client or an unregistered redirect URI is never redirected to: the page shows an error instead (open-redirect rule).
- **Tokens.** Opaque random tokens, 32 bytes, base64url, prefixed `ssa_` (access, 1 h) or `ssr_` (refresh, 30 days). Only their SHA-256 is stored **[decided]**. Each refresh rotates the refresh token. Reusing a spent refresh token revokes the whole grant (theft signal). Every token belongs to one **grant** (user × client), the row Konto lists and Återkalla revokes. Audience: the grant's `resource` must be this server's canonical URI, both at the token endpoint and on every call. Tokens never appear in URLs (codes do, as OAuth requires), and nothing logs an Authorization header, a code or a token.
- **Redirect URIs** (DCR): `https:` on any host, or `http:` only on a loopback host (Claude Code's local callback). Loopback URIs may use any port (RFC 8252 §7.3). At most 5 per client, no fragment. The match at authorize is otherwise exact. HTTPS everywhere else, because the app is HTTPS-only on Vercel.
- **DNS rebinding / Origin** (MCP transport spec): an `/api/mcp` request with an `Origin` header outside {app origin, `https://claude.ai`, `https://claude.com`} gets 403. Server-side clients send none.
- **Rate limits** in Postgres (Vercel has no shared memory): 60 calls a minute per grant. Per hashed IP: 20 registrations and 60 token requests per 10 minutes.
- **Scope:** one scope, `meetings`. Any requested scope is answered with it (RFC 6749 §3.3).

## Running as the user [decided: never the service role for tool reads]
Every call resolves its grant to `user_id`, reloads the user with `auth.admin.getUserById` (a deleted user ends access), checks the gate by their current e-mail, and builds a **user-scoped Supabase client**. That client uses a 5-minute HS256 JWT (`sub`, `role: authenticated`, `aud: authenticated`) signed with the project's JWT secret, the same mechanism as `clientAs` in the DB tests. PostgREST then applies every RLS policy exactly as for the web app: föreningar, the Företag tree, Privat möte, Privat spaces. A member removed from an org loses it on the next call. The client's `auth.getUser()` returns that loaded user, because shared code (`myRole`, `listMyForetag`) asks it for the user.
- New env `SUPABASE_JWT_SECRET`. It is optional, and without it MCP fails closed with 503. It is as powerful as the service role key and is stored the same way.
- **Tools reuse the app's loaders.** Some visibility rules live in app code, not RLS: Må-runda rows, `info.*` cells, deleted rows, Testmöten, live meetings, and handoff tasks that never reveal their meeting.
- The shared write paths (`completeNoteTask`, `savePrepared`) are unchanged: they check as the user, then write with the service role, as the web app does. The service role is otherwise used only for the OAuth tables and the audit row.

## Tools v1 [decided]
| Tool | What | Reuses |
| --- | --- | --- |
| `list_orgs` | the user's spaces: id, name, kind (förening/företag/privat), role | org_members + orgs (RLS) |
| `search_meetings(query?, org_id?, from?, to?, cursor?, limit?)` | finished, real meetings, newest first. `query` matches the title, visible note lines and the Privat summary, and returns a snippet of at most 160 characters. Limit ≤ 25, opaque cursor. | `visible()` rules |
| `get_meeting(meeting_id)` | title, date, space, attendance, decisions, tasks (Vem / När / Klart när, done, `task_id`, `can_complete`), a summary (Privat: its summary; förening/Företag: the Övrigt lines, capped) and the Doc link | `loadOrgMeeting`, Privat `loadMeetingPage` |
| `my_tasks(status?, due_before?, cursor?, limit?)` | Mina uppgifter: open by default. A handoff never names its meeting. | `loadHome` |
| `complete_task(task_id)` | the same path as ticking on /hem: owner or admin, finished meeting, `✓ klart` written in the Doc where the line is still ours | `completeNoteTask`, `setPrivatTaskDone`, `setHandoffDone` |
| `prepare_agenda(org_id \| meeting_id, point)` | adds a point to the förening's **next already-prepared agenda**, through `loadDraft` → `addItem` → `savePrepared` (the "Lägg till punkt" path). Refused for Företag and Privat, like the route and the proxy. | prepare |

`task_id` is the existing `MyTask.key` (`n:<meeting>:<item>`, `p:<task>`, `h:<handoff>`). Results are compact JSON text. Descriptions are in English and say what each tool can't do. Read tools are annotated `readOnlyHint`; `complete_task` is `idempotentHint`.

**Narrow default (open question):** when no agenda is prepared yet, `prepare_agenda` does not create one. Creating one would make a new Doc and share it with every member. It answers "open Förbered möte first" instead.

## Data (migration 0056_mcp.sql, additive; service-role only unless noted)
```
mcp_clients        id text pk, client_name, redirect_uris text[], created_at
mcp_auth_requests  id text pk, client_id, redirect_uri, code_challenge, state, resource, expires_at
mcp_auth_codes     code_hash pk, client_id, user_id, redirect_uri, code_challenge, resource, expires_at
mcp_grants         id uuid pk, user_id, client_id, client_name, resource, created_at, last_used_at, revoked_at
                   RLS: the user selects their own rows; revoke_mcp_grant(id) (security definer, auth.uid())
mcp_tokens         token_hash pk, grant_id, kind access|refresh, expires_at, used_at
mcp_audit          id, user_id, grant_id, tool, ids jsonb (meeting/org/task ids only), ok, at
                   RLS: the user selects their own rows. Never a query, point or any text.
mcp_rate           key, window_start, hits; mcp_rate_take(key, limit, seconds) (service role)
```
Before the migration, no token is valid (fail closed).

## Tests
- **Unit (`lib/mcp/*.test.ts`):** PKCE S256, redirect-URI and resource rules, DCR validation, the 401 challenge and Origin check, and every endpoint against `memoryStore()`. The endpoint cases cover code reuse, a wrong verifier or resource, and refresh rotation (reuse revokes). The tools are tested with mocked loaders: `prepare_agenda` never writes on a refusal, and a handoff never names its meeting.
- **SDK client, in-process:** `Client` plus `StreamableHTTPClientTransport` run through the transport's `fetch` against the real route handlers, with only `lib/mcp/deps.ts` swapped for a memory store. The flow is 401, discovery, DCR, `/oauth/authorize`, consent, token, `tools/list`, `tools/call` and revoke. No Google is involved.
- **DB (`tests/db/mcp.test.ts`, local Supabase in CI):** the Företag tree, checked through the tools under RLS. A Kommunikation member can't find, read or complete an Utveckling meeting's task, and the Utveckling member can. Deleted and Må-runda rows never match a search. A removed förening member loses access. Återkalla stops the token, and the audit holds ids only.

## Out of v1
Client ID Metadata Documents, scopes finer than `meetings`, edits or deletes of notes, write tools beyond the two above, and a cron sweep of expired OAuth rows. Expired rows are inert, and the sweep is a follow-up.
