# Simon Says i Claude (MCP)

Simon Says is a remote MCP server at `https://simonsays.harrysson.co/api/mcp`, using Streamable HTTP and OAuth 2.1. Once it is connected, your own Claude can search your meetings and Privat recordings, read one, list your tasks and tick them off, and add a point to the next agenda. **Claude sees only what you see in the app.** Design: `docs/superpowers/specs/2026-11-27-mcp-design.md`.

> For every user: Privat, föreningar and Företag. Kill switch: `MCP_ENABLED=0` turns it off for everyone (503).

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
| `list_spaces` | Your föreningar, Företag and Privat space (with its contexts, e.g. courses) |
| `search_meetings(query?, org_id?, context_id?, from?, to?, cursor?, limit?)` | Finished meetings and recordings, newest first, with a short matching snippet |
| `get_meeting(meeting_id)` | A meeting or recording: title, date, attendance, decisions, tasks (Vem / När / Klart när), summary, Doc link |
| `my_tasks(status?, due_before?, cursor?, limit?)` | Mina uppgifter (open by default) |
| `complete_task(task_id)` | Same as ticking on /hem: the owner or an admin, and the Doc gets "✓ klart" |
| `prepare_agenda(org_id \| meeting_id, point)` | Förening meetings only. Adds a point to the next agenda; creates it (Förbered möte's proposed date) when none is prepared |

**Write tools:** `complete_task` and `prepare_agenda` change real things (a line in a Google Doc, an agenda Doc every member sees). They are annotated as non-read-only. **Don't set them to "Always allow"** in Claude; keep "Ask" so you confirm each one. The read tools can be allowed freely.

Claude cannot change or delete notes, and it cannot see more than you can. Every call is logged with tool, ids and time, never content.

## Operations

- **No new env.** Tools read as the user through the `mcp_*` SQL functions (service role only, explicit user, the RLS predicates). The audit is kept 90 days (daily cron `mcp_cleanup`).
- **Migration:** `0060_mcp.sql` (tables `mcp_*`, the `mcp_*` read functions, `revoke_mcp_grant`, `mcp_rate_take`, `mcp_spend_refresh`, `mcp_cleanup`).
- **Endpoints:**
  - `/.well-known/oauth-protected-resource[/api/mcp]`
  - `/.well-known/oauth-authorization-server`
  - `/api/oauth/{register,token,revoke}`
  - `/oauth/authorize`
  - `/koppla/<id>` (consent)
  - `/api/mcp`
- **Tokens:** access tokens live 1 h and refresh tokens 30 days. Refresh tokens rotate, and reusing one revokes the connection. Only SHA-256 hashes are stored.
- **Limits:** 60 calls a minute per user (all their connections together). Per IP, per 10 minutes: 20 registrations, 30 authorizations and 60 token requests.
- **Redirect URIs:** only `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback` and loopback `http://localhost|127.0.0.1:<any port>/…` (Claude Code). Anything else is refused at registration and at authorize. The consent page names the app from the redirect host, never from the name the client registered, and warns for loopback.
- **Cleanup (daily cron):** audit rows after 90 days, pending authorizations after 15 minutes, and registered clients that never got a grant after 24 hours.
- **Banned or deleted accounts** get 401, whatever their tokens.
- **Tests:**
  - `lib/mcp/*.test.ts` (unit, plus the SDK client through the whole flow in-process)
  - `tests/db/mcp.test.ts` (RLS through the tools: Företag tree, removed member, revoke, audit)
