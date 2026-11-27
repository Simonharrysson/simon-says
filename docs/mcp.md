# Simon Says i Claude (MCP)

Simon Says is a remote MCP server at `https://simonsays.harrysson.co/api/mcp`, using Streamable HTTP and OAuth 2.1. Once it is connected, your own Claude can search your meetings, read one, list your tasks and tick them off, and add a point to the next agenda. **Claude sees only what you see in the app.** Design: `docs/superpowers/specs/2026-11-27-mcp-design.md`.

> Behind the Företag allow-list (`FORETAG_CREATOR_EMAILS`, else `ADMIN_EMAILS`, else `ALARM_EMAIL`) until it is tested. Anyone else gets "Inte tillgängligt än".

## Lägg till i Claude

**claude.ai and Claude Desktop**
1. Settings → Connectors → **Add custom connector**.
2. Name: `Simon Says`. URL: `https://simonsays.harrysson.co/api/mcp`. Leave the OAuth fields empty, because Claude registers itself.
3. Click **Connect**. Simon Says opens: sign in with Google, check that the request comes from Claude (`claude.ai`), and click **Godkänn**.

**Claude Code**
```sh
claude mcp add --transport http simon-says https://simonsays.harrysson.co/api/mcp
# then, inside Claude Code: /mcp → simon-says → Authenticate (opens the browser)
```

**Återkalla:** go to Konto → **Kopplade AI-assistenter** → Återkalla. The assistant loses access on its next call. The same panel lists the last 20 calls, showing tool and time only.

## Tools

| Tool | Does |
| --- | --- |
| `list_orgs` | Your föreningar, Företag and Privat, with your role |
| `search_meetings(query?, org_id?, from?, to?, cursor?, limit?)` | Finished meetings, newest first, with a short matching snippet |
| `get_meeting(meeting_id)` | Title, date, attendance, decisions, tasks (Vem / När / Klart när), summary, Doc link |
| `my_tasks(status?, due_before?, cursor?, limit?)` | Mina uppgifter (open by default) |
| `complete_task(task_id)` | Same as ticking on /hem: the owner or an admin, and the Doc gets "✓ klart" |
| `prepare_agenda(org_id \| meeting_id, point)` | Adds a point to a förening's next **already prepared** agenda |

Claude cannot change or delete notes, and it cannot see more than you can. Every call is logged with tool, ids and time, never content.

## Operations

- **Env:** set `SUPABASE_JWT_SECRET` (Supabase → Project Settings → JWT, the legacy HS256 secret). Without it every MCP endpoint answers 503. The secret is as sensitive as the service role key.
- **Migration:** `0056_mcp.sql` (tables `mcp_*`, `revoke_mcp_grant`, `mcp_rate_take`, `mcp_spend_refresh`).
- **Endpoints:**
  - `/.well-known/oauth-protected-resource[/api/mcp]`
  - `/.well-known/oauth-authorization-server`
  - `/api/oauth/{register,token,revoke}`
  - `/oauth/authorize`
  - `/koppla/<id>` (consent)
  - `/api/mcp`
- **Tokens:** access tokens live 1 h and refresh tokens 30 days. Refresh tokens rotate, and reusing one revokes the connection. Only SHA-256 hashes are stored.
- **Limits:** 60 calls a minute per connection. Per IP: 20 registrations and 60 token requests per 10 minutes.
- **Tests:**
  - `lib/mcp/*.test.ts` (unit, plus the SDK client through the whole flow in-process)
  - `tests/db/mcp.test.ts` (RLS through the tools: Företag tree, removed member, revoke, audit)
