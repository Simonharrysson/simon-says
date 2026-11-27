# Simon Says MCP server — design (owner decisions 2026-11-27 are marked **[decided]**; open questions go in the PR body)

Goal: **every** Simon Says user (Privat, föreningar and Företag) can connect their own Claude (claude.ai custom connector, Claude Desktop, Claude Code) to search their meetings and recordings, read one, list and tick their tasks and add a point to the next agenda, **as that user and nothing more**. Focus stays on information management: no editing or deleting notes **[decided]**.

## What the user gets
1. **Lägg till i Claude**: claude.ai → Settings → Connectors → custom connector `https://simonsays.harrysson.co/api/mcp`, or `claude mcp add --transport http simon-says https://simonsays.harrysson.co/api/mcp`. Claude opens our page, the user signs in with Google as today and sees **"Ge Claude tillgång till dina möten i Simon Says"** with Godkänn / Avbryt.
2. **Konto → Kopplade AI-assistenter**: each connection (client name, connected, last used) with **Återkalla**, and the last 20 calls (tool, time, nothing else).
3. Open to every signed-in user **[decided 11-27]**. A kill switch, `MCP_ENABLED` (default on), answers 503 everywhere when it is `0`. It is checked at consent and on every call.

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

## Running as the user [decided 11-27: SQL functions, not minted JWTs]
Prod signs with asymmetric ES256 keys, so we mint no JWTs. Every call resolves its grant to `user_id`, reloads the user (`auth.admin.getUserById`; a deleted user ends access) and and checks the kill switch.
- **Reads** go only through `mcp_*` functions (0060). Each one is security definer with `search_path ''` and callable by the service role only, and it takes an explicit `p_user`. The functions restate no rule. `mcp_act_as(p_user)` sets the JWT claims for the transaction, so `auth.uid()` is that user. Each function then asks the same predicate as the table's select policy: `can_see_meeting` → `foretag_can_see`, `is_meeting_member`, `is_org_member`, `is_context_member` or `can_approve_handoff`. Föreningar, the Företag tree, Privat möte, task approval and Privat spaces therefore apply unchanged, and a removed member loses access on the next call. `lib/mcp/reader.ts` is the tools' only read path.
- **App rules outside RLS** are applied by the app's pure builders on those rows: `buildOrgMeeting`, `myForeningTasks` / `myHandoffTasks` / `myPrivatTasks` and `visible()`. These cover Må-runda rows, `info.*` cells, deleted rows, Testmöten, live meetings, and handoffs that never name their meeting.
- **Writes** go through the app's own paths with the user as actor and the UI's checks unchanged:
  - `completeNoteTask`: owner or admin, after the reader has shown the meeting.
  - `set_task_handoff_done` and the Privat update, through `mcp_set_*` acting as the user.
  - Förbered möte (`loadDraft` → `addItem` → `savePrepared`): a förening member only. The actor client is a fresh service-role client whose `auth.getUser()` is the user; its reads are keyed by that förening.

## Tools v1 [decided]
| Tool | What | Reuses |
| --- | --- | --- |
| `list_spaces` | föreningar, Företag and the user's Privat space with its contexts (a course, a client) | `mcp_orgs`, `mcp_contexts` |
| `search_meetings(query?, org_id?, context_id?, from?, to?, cursor?, limit?)` | finished meetings **and Privat recordings**, newest first. `query` matches the title, visible note lines and the Privat summary, and returns a snippet of at most 160 characters. Limit ≤ 25, opaque cursor. | `mcp_meetings`, `mcp_note_items`, `visible()` |
| `get_meeting(meeting_id)` | title, date, space, attendance, decisions, tasks (Vem / När / Klart när, done, `task_id`, `can_complete`), a summary (Privat: its summary; förening/Företag: the Övrigt lines, capped) and the Doc link | `buildOrgMeeting`, Privat summary/tasks |
| `my_tasks(status?, due_before?, cursor?, limit?)` | Mina uppgifter: open by default. A handoff never names its meeting. | `/hem`'s builders |
| `complete_task(task_id)` | the same path as ticking on /hem: owner or admin, finished meeting, `✓ klart` written in the Doc where the line is still ours | `completeNoteTask`, `setPrivatTaskDone`, `setHandoffDone` |
| `prepare_agenda(org_id \| meeting_id, point)` | adds a point to the förening's next agenda, **creating it** (Förbered möte's proposed date) when none is prepared **[decided 11-27]**, through `loadDraft` → `addItem` → `savePrepared` (the "Lägg till punkt" path). Förening meetings only: refused for Företag and Privat recordings, like the route and the proxy. | prepare |

`task_id` is the existing `MyTask.key` (`n:<meeting>:<item>`, `p:<task>`, `h:<handoff>`). Results are compact JSON text. Descriptions are in English and say what each tool can't do. Read tools are annotated `readOnlyHint`; `complete_task` is `idempotentHint`.

## Data (migration 0060_mcp.sql, additive; service-role only unless noted)
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
mcp_* reads        mcp_orgs, mcp_meetings, mcp_note_items, mcp_people, mcp_contexts, mcp_private_summaries,
                   mcp_context_tasks, mcp_handoffs, mcp_set_handoff_done, mcp_set_privat_task_done
mcp_cleanup()      daily cron: audit after 90 days [decided 11-27], expired requests/codes/tokens
```
Before the migration, no token is valid (fail closed).

## Tests
- **Unit (`lib/mcp/*.test.ts`):** PKCE S256, redirect-URI and resource rules, DCR validation, the 401 challenge and Origin check, and every endpoint against `memoryStore()`. The endpoint cases cover code reuse, a wrong verifier or resource, and refresh rotation (reuse revokes). The tools are tested with a fixed reader: `prepare_agenda` never writes on a refusal, and a handoff never names its meeting.
- **SDK client, in-process:** `Client` plus `StreamableHTTPClientTransport` run through the transport's `fetch` against the real route handlers, with only `lib/mcp/deps.ts` swapped for a memory store. The flow is 401, discovery, DCR, `/oauth/authorize`, consent, token, `tools/list`, `tools/call` and revoke. No Google is involved.
- **DB (`tests/db/mcp.test.ts`, local Supabase in CI):** the Företag tree, checked through the tools, plus a matrix that calls every `mcp_*` function directly for a user who must not see the rows, against a positive control. No signed-in client may call them. A Kommunikation member can't find, read or complete an Utveckling meeting's task, and the Utveckling member can. Deleted and Må-runda rows never match a search. A removed förening member loses access. A Privat owner finds, reads and ticks their own recordings and tasks; another user never gets them, by search, by context, by id or by task id. Återkalla stops the token, and the audit holds ids only.

## Out of v1
Client ID Metadata Documents, scopes finer than `meetings`, edits or deletes of notes, and write tools beyond the two above.
