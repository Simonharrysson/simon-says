# Simon Says i Claude (MCP)

Simon Says is a remote MCP server at `https://simonsays.harrysson.co/api/mcp`, using Streamable HTTP and OAuth 2.1. Once it is connected, your own Claude can search your meetings and Privat recordings, read one, list your tasks and tick them off, add a point to the next agenda, work on tasks a meeting gave Claude, and read what Claude should know about your organisation. **Claude sees only what you see in the app.** Design: `docs/superpowers/specs/2026-11-27-mcp-design.md`.

> For every user: Privat, föreningar and Företag. Kill switch: `MCP_ENABLED=0` turns it off for everyone (503).

## Lägg till i din AI

Konto → **Koppla till din AI** (`/installningar#ai`) has a tile per tool with numbered steps, the address to copy and one-click installs (`lib/mcp/clients.ts`). The address is `https://simonsays.harrysson.co/api/mcp`; every tool signs in with OAuth (Google, then **Godkänn** on `/koppla/<id>`).

| Tool | How |
| --- | --- |
| Claude (web, Desktop, mobile) | claude.ai → Customize → Connectors → + Add → Add custom connector, name `Simon Says`, paste the address, Connect (support.claude.com/en/articles/11175166) |
| ChatGPT (Business, Enterprise, Edu; web) | Plugins → + → Add custom MCP server, paste the address under Connection, OAuth, Create as a plugin (help.openai.com/en/articles/12584461) |
| Cursor | `cursor://anysphere.cursor-deeplink/mcp/install?name=simon-says&config=<base64 {"url": …}>`, or `mcpServers` in `mcp.json` (cursor.com/docs/context/mcp/install-links) |
| VS Code (Copilot agent mode) | `vscode:mcp/install?<{"name":"simon-says","type":"http","url":…}>`, and `vscode-insiders:` (code.visualstudio.com/api/extension-guides/ai/mcp) |
| Claude Code | `claude mcp add --transport http simon-says <address>`, then `/mcp` → simon-says → Authenticate |
| Gemini CLI | `gemini mcp add --transport http simon-says <address>`, then `/mcp auth simon-says` (geminicli.com/docs/tools/mcp-server) |
| Another tool | `{"mcpServers":{"simon-says":{"url":"<address>"}}}`; it needs MCP over HTTP with OAuth and a redirect URI on the allow-list (Operations below) |

Not offered: Windsurf (its OAuth redirect URI is not documented, so it can't be allow-listed).

**Koppla från:** Konto → **Koppla till din AI** → Koppla från. The assistant loses access on its next call. The same section lists the last 20 calls, showing tool and time only. The list names each connection's app and shows its mark from the redirect URI the grant was approved for (`mcp_grants.redirect_uri`, 0068, mapped by `redirectAudience`, the consent page's rule). A loopback URI shows as "App på din dator". The name the client registered is its own claim, so it shows only as secondary text ("Kallar sig …").

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
| `get_org_memory(org_id)` | **Vad Claude ska veta**: customers, priorities, recurring decisions, glossary, and who is who, each line an attributed statement ("Sades i mötet 12 nov: …", "Tillagt av <admin>") with its source meetings. A line is left out when the user can't see all of its sources |

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
- Every line is an attributed statement that stays true: "Sades i mötet 12 nov: kunden vill ha leverans i mars", linking to that meeting (older lines: all their source meetings). No speaker is ever named: note rows aren't tied to a confirmed speaker of a statement, and the app never guesses one. An admin's own or changed line shows "Tillagt av <admin>". No approval step: Uppdatera writes the page directly.
- Members read the page through their Claude, with `get_org_memory`. The table is server-only: the page and the tool both leave out a line when the reader can't see all of its sources.
- Admins can run Uppdatera once a minute. Its usage is recorded on the org, under the kill switch and the daily cap.

## Operations

- **Env:** `AGENT_TASKS_ENABLED` (default `0`): agent tasks parked. Tools read as the user through the `mcp_*` SQL functions (service role only, explicit user, the RLS predicates). The audit is kept 90 days (daily cron `mcp_cleanup`).
- **Migrations:**
  - `0060_mcp.sql`: tables `mcp_*`, the `mcp_*` read functions, `revoke_mcp_grant`, `mcp_rate_take`, `mcp_spend_refresh`, `mcp_cleanup`.
  - `0068_mcp_grant_redirect.sql`: `mcp_grants.redirect_uri`, the redirect URI of the grant's latest approval (readable by its user). Older grants are filled when their client registered one URI.
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
- **Redirect URIs** (`lib/mcp/oauth.ts` `HOSTED_CALLBACKS`, exact strings, no patterns). Anything else is left out at registration (RFC 7591 §2: a list with Cursor's undocumented `cursor://` URI keeps only its allowed ones; a list with none allowed is refused) and refused at authorize. The consent page names the app from the redirect URI, never from the name the client registered, and warns for loopback.
  | Client | Redirect URI | Source |
  | --- | --- | --- |
  | Claude (web, Desktop, mobile, Cowork) | `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback` | claude.com/docs/connectors/building/authentication |
  | ChatGPT | `https://chatgpt.com/connector_platform_oauth_redirect` (its stable callback, used because the metadata says `authorization_response_iss_parameter_supported` and every redirect carries `iss`; the per-connector `/connector/oauth/{id}` is not allowed) | developers.openai.com/apps-sdk/build/auth |
  | Cursor (web, cloud agents) | `https://www.cursor.com/agents/mcp/oauth/callback` | cursor.com/docs/context/mcp ("Cursor uses fixed OAuth redirect URLs") |
  | VS Code (vscode.dev, Insiders) | `https://vscode.dev/redirect`, `https://insiders.vscode.dev/redirect` | github.com/microsoft/vscode `src/vs/base/common/oauth.ts` (`fetchDynamicRegistration`) |
  | Loopback: Claude Code, Cursor desktop (`localhost:8787/callback`), VS Code desktop (`127.0.0.1/`, `127.0.0.1:33418/`), Gemini CLI (`localhost:<port>/oauth/callback`) | `http://localhost\|127.0.0.1\|[::1]:<any port>/…` | code.claude.com/docs/en/mcp, the Cursor and VS Code sources above, geminicli.com/docs/tools/mcp-server |

  Cursor: its docs (cursor.com/docs/context/mcp) give `https://www.cursor.com/…` with www, and Cursor staff on the forum say the desktop app uses loopback `localhost:8787`. The no-www `https://cursor.com/agents/mcp/oauth/callback` only shows up in a user's quote of older docs, so it is not allowed.

  Left out (checked 2026-11-28): Windsurf (no documented redirect URI), Cursor's `cursor://anysphere.cursor-mcp/oauth/callback` (only a forum post, not Cursor's docs), and every custom scheme. The MCP endpoint's `Origin` check is unchanged (`allowedOrigin`: the app, claude.ai, claude.com). ChatGPT, Cursor, VS Code and Gemini CLI are allow-listed from their documentation and not yet tried end to end; if one of them sends an `Origin` header to `/api/mcp` it gets 403 after signing in, and that is the first thing to check. Also unverified: whether Cursor's desktop app authorizes on loopback (documented) or on its `cursor://` URI (dropped at registration), and the VS Code install link's `type: "http"` fields (the docs show only a stdio example).
- **Cleanup (daily cron):** audit rows after 90 days, pending authorizations after 15 minutes, and registered clients that never got a grant after 24 hours.
- **Banned or deleted accounts** get 401, whatever their tokens.
- **Tests:**
  - `lib/mcp/*.test.ts` (unit, plus the SDK client through the whole flow in-process)
  - `tests/db/mcp.test.ts` (RLS through the tools: Företag tree, removed member, revoke, audit)
  - `tests/db/claude-tasks.test.ts` (agent tasks and memory through the tools: Företag tree, who may update, memory sources, the source filter)
