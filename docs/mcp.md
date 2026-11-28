# Simon Says i Claude (MCP)

Simon Says is a remote MCP server at `https://simonsays.harrysson.co/api/mcp`, using Streamable HTTP and OAuth 2.1. Once it is connected, your own Claude can search your meetings and Privat recordings, read one, list your tasks and tick them off, add a point to the next agenda, work on tasks a meeting gave Claude, and read what Claude should know about your organisation. **Claude sees only what you see in the app.** Design: `docs/superpowers/specs/2026-11-27-mcp-design.md`.

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
| `list_agent_tasks(status?, include_others?, cursor?, limit?)` | Tasks a meeting explicitly gave Claude (Vem: Claude / AI / Simon Says), open by default. **Parked:** meetings don't create new ones unless `AGENT_TASKS_ENABLED=1`, so this lists the existing ones. By default only the ones the user gave it (meetings they ran, or any as an admin). Each one a brief: the task, Klart när, due, status and note, the meeting (link to its page and Doc), and that meeting's decisions and Övrigt lines |
| `update_agent_task(task_id, status, note?)` | `in_progress`, `blocked` or `done`, with a note that is shown on the meeting page. The meeting's runner (who gave Claude the task) or an admin may do this. `done` works like ticking the task, so the Doc gets "✓ klart" |
| `get_org_memory(org_id)` | **Vad Claude ska veta**: customers, priorities, recurring decisions, glossary, and who is who, each line an attributed statement ("Anna Svensson sa i mötet 12 nov: …") with its source meetings. A line is left out when the user can't see all of its sources |

**Write tools:** `complete_task`, `update_agent_task` and `prepare_agenda` change real things (a line in a Google Doc, an agenda Doc every member sees). They are annotated as non-read-only. **Don't set them to "Always allow"** in Claude; keep "Ask" so you confirm each one. The read tools can be allowed freely.

Claude cannot change or delete notes, and it cannot see more than you can. Every call is logged with tool, ids and time, never content.

## Claude, gör det här and Vad Claude ska veta

Design: `docs/superpowers/specs/2026-11-28-claude-tasks-memory-design.md`.

**Agent tasks**
- A task is Claude's when its Vem is exactly Claude, AI, AI:n or Simon Says and nobody in the org has that name or role.
- **Parked (2026-11-28):** the notes engine marks no new agent tasks. With `AGENT_TASKS_ENABLED=1` it writes that owner again, only when the meeting says it explicitly ("Claude ska …"); off (the default) it uses the prompt from before 0065 and drops an assistant owner. Existing agent tasks keep working (Hos Claude, `list_agent_tasks`, `update_agent_task`).
- The runner sees the task in Mina uppgifter as **Hos Claude**, with Claude's status and note. So does everyone who sees the meeting, on its page.

**Vad Claude ska veta** (Inställningar → Vad Claude ska veta; föreningar and Företag, admins)
- **Uppdatera** asks Claude for lines built from at most 40 of the newest meetings that **every member** can see (`org_memory_sources`).
- Lines an admin wrote or changed are never replaced.
- Every line is an attributed statement that stays true: "Anna Svensson sa i mötet 12 nov: kunden vill ha leverans i mars", linking to that meeting. The speaker is named only when the meeting data ties it to a person (the server checks that Claude's name is a task owner, Vem, of that meeting), else "Sades i mötet 12 nov: …". An admin's own or changed line shows "Tillagt av <admin>". Lines generated before this show "Från mötet 12 nov: …". No approval step: Uppdatera writes the page directly.
- Members read the page through their Claude, with `get_org_memory`. The table is server-only: the page and the tool both leave out a line when the reader can't see all of its sources.
- Admins can run Uppdatera once a minute. Its usage is recorded on the org, under the kill switch and the daily cap.

## Operations

- **Env:** `AGENT_TASKS_ENABLED` (default `0`): agent tasks parked. Tools read as the user through the `mcp_*` SQL functions (service role only, explicit user, the RLS predicates). The audit is kept 90 days (daily cron `mcp_cleanup`).
- **Migrations:**
  - `0060_mcp.sql`: tables `mcp_*`, the `mcp_*` read functions, `revoke_mcp_grant`, `mcp_rate_take`, `mcp_spend_refresh`, `mcp_cleanup`.
  - `0065_claude_tasks_memory.sql`: tables `agent_task_status` and `org_memory`, and the functions `mcp_agent_task_status`, `mcp_set_agent_task`, `mcp_org_memory` and `org_memory_sources`. All of them are service role only.
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
  - `tests/db/claude-tasks.test.ts` (agent tasks and memory through the tools: Företag tree, who may update, memory sources, the source filter)
