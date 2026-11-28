# "Claude, gör det här" and "Vad Claude ska veta" — design (owner approved both 11-28; choices made here are marked **[choice]**)

Two features on the MCP server (`docs/superpowers/specs/2026-11-27-mcp-design.md`). Both keep the MCP rule: **Claude sees only what the user sees**. Reads go through `mcp_*` functions (service role, explicit `p_user`, the existing predicates). Writes go through the app's own paths, behind `actorFor`. Migration **0065_claude_tasks_memory.sql**, additive.

## A. Agent tasks ("Claude, gör det här")

**When a task is Claude's.** A förening or Företag task row (`isTask`) is an *agent task* when all of these hold. The rule is deterministic, in code (`lib/agent/tasks.ts` `isAgentTask`):
- its owner text, normalised (case, spaces, a trailing `:`/`.`), is exactly `Claude`, `AI`, `AI:n`, `Simon Says` or `Claude (AI)`;
- `resolveOwner` finds **no** person or role in the org by that text (a member actually called Claude keeps the task: never a silent reassignment);
- no `owner_person_id`;
- the row isn't `locked` (a human edited the line, so the owner field is no longer ours).

The notes engine gets one sentence in both system prompts (plain and agenda mode): a task the meeting **explicitly** gives Claude, the AI assistant ("Claude ska sammanställa …", "låt AI:n göra det"), is an action with owner `Claude`. The prompt never asks the model to give tasks to Claude on its own. There's no new op field, so the op schemas stay byte-stable. An explicit "Claude ska …" decision is covered the same way: the engine also writes the action. **[choice]** A decision row alone is never an agent task. It has no Klart när and no ✓ klart path.

**Who assigned it.** **[choice]** The meeting's runner (`meetings.started_by`, who pressed Start). The engine has no reliable speaker-to-account identity, so we don't guess one.

**Status.** Table `agent_task_status (meeting_id, item_id, status in_progress|done|blocked, note ≤ 500, updated_by, updated_at)`. No row means open. Members of the meeting select through `is_meeting_member`, the same predicate as `note_items`. There are no client writes. `done` is also written on the note row through `completeNoteTask`, so the Doc gets "✓ klart" exactly as Mina uppgifter does it.

**Who may update.** **[choice]** The assigner (`started_by`) or an admin of the org, on a finished real meeting the user can see. `completeNoteTask` treats the assigner of an agent task as its owner: the one added rule, used by `/hem` too.

**MCP tools**
| Tool | Does |
| --- | --- |
| `list_agent_tasks(status?: open\|in_progress\|blocked\|done\|all, include_others?, cursor?, limit?)` | Agent tasks in meetings the user can see. **[choice, security review]** By default only the ones the user may update (they ran the meeting, or they're an admin), because a line anyone says in a meeting is no assignment from this user; `include_others` lists the rest read-only. The tool and server instructions tell Claude to confirm with the user before acting (`taskTips`, so carried copies show once; `visible()`). Default `open` means not done. Each one is a **brief**: `task_id`, task, Klart när, due, status and note, the meeting (title, date, space), that meeting's decisions and Övrigt lines (`buildOrgMeeting` + `summaryContent`, capped; never the transcript), the meeting page URL and the Doc URL, and `can_update`. |
| `update_agent_task(task_id, status, note?)` | `mcp_set_agent_task` (acting as the user: `is_meeting_member`, plus assigner or admin). `done` then goes through `completeNoteTask` → "✓ klart" in the Doc. The note is shown on the meeting page and never audited. |

**In the app**
- **Mina uppgifter** shows the assigner their agent tasks under the label **"Hos Claude"**, with status and note, and they can tick them.
- The **meeting page** shows "Hos Claude · Pågår/Blockerad/Klar" and the note under the task.

**Out of v1:** Privat recordings (`context_tasks`), and Företag handoffs, because a handoff has a person owner.

## B. Company memory ("Vad Claude ska veta")

A per-org page (Företag and föreningar, not Privat) under **Inställningar → Vad Claude ska veta**. It has five sections:
- Kunder
- Prioriteringar
- Återkommande beslut
- Ordlista
- Vem är vem

Each line is short text with its **sources** (links to meetings).

- **Storage.** One row per org, `org_memory (org_id pk, lines jsonb, generated_at, sources_from, sources_count, updated_at, updated_by)`. A line is `{id, section, text, sources: meeting uuid[], edited}`. **[security review]** No client access at all, not even select. The page is read on the server after the admin check, with the same per-line source filter as `get_org_memory`, for admins too. Writes are optimistic (`version`, retried and merged again), so an admin edit is never overwritten. Uppdatera claims its 60 s cooldown with one conditional update, so two can't run at once. A save changes only the lines the page showed.
- **Visibility.** **[choice: owner's "simplest"]** The memory is admin-curated and readable by every member.
  - A generated draft may use only meetings **every current member can see**. That is `org_memory_sources(p_org, p_limit)` in SQL: done, not a Testmöte, and no `org_members` row for whom `foretag_can_see(member, meeting)` is false. The tree rule isn't restated anywhere.
  - Rows are filtered by the app's `visible()` (never deleted lines, Må-runda or info cells).
  - On read, both the page and `get_org_memory`, a line **with sources** is returned only if the reader can still see **all** of them (the reader's `mcp_meetings`). This covers membership or tree changes after generation. A line without sources (written by an admin) is always returned.
- **Uppdatera** (admin) sends the newest ≤ 40 such meetings, each as `<meeting id="…">` with title, date, decisions, tasks and Övrigt lines, to `oneShot`. That is the shared Claude call: NOTES_MODEL with fallbacks, structured output, usage recorded on the org, kill switch and daily cap.
  - Claude returns lines with source ids. Ids outside the set it was sent are dropped.
  - **Admin-edited or added lines are never touched.** They go to Claude as "keep, don't duplicate". Generated lines that weren't edited are replaced.
  - Cooldown: 60 s per org.
  - The page shows how many meetings it was built from and since when.
- **MCP:** `get_org_memory(org_id)` → `mcp_org_memory(p_user, p_org)` (is_org_member), with the source filter above. Each line carries its sources' meeting URLs.
- **Where members read it.** **[choice]** Inställningar is admin-only in both kinds of org, so in v1 members read the memory through their Claude (`get_org_memory`). The page is the admins' editor.

## Data (0065)
```
agent_task_status  (meeting_id, item_id) pk → note_items; status, note, updated_by, updated_at
                   RLS select: is_meeting_member(meeting_id). No client writes.
org_memory         org_id pk → orgs; lines jsonb, generated_at, sources_from, sources_count, updated_at, updated_by, version
                   service role only (no client grants)
mcp_agent_task_status(p_user, p_meeting_ids)            read, is_meeting_member
mcp_set_agent_task(p_user, p_meeting, p_item, p_status, p_note)  is_meeting_member + (started_by = p_user or is_org_admin)
mcp_org_memory(p_user, p_org)                            read, is_org_member
org_memory_sources(p_org, p_limit)                       meetings visible to every member (service role)
```
All functions: security definer, `search_path ''`, revoked from public/anon/authenticated, service_role only.

## Tests
- **Unit:** `isAgentTask` (owner forms, a real person called Claude, locked); the prompt sentence in both prompts; the briefs and the update tool against a fixed reader (refusals never write); `completeNoteTask`'s assigner rule; the memory merge (edited lines kept, foreign source ids dropped, the source filter); `get_org_memory`.
- **DB (`tests/db/claude-tasks.test.ts`):**
  - The Företag tree through the tools: a Kommunikation member never lists an Utveckling agent task.
  - Update: a member who isn't the assigner is refused; the assigner is allowed.
  - Memory sources exclude a group-only meeting.
  - `get_org_memory` hides a line whose source the caller can't see.
  - No signed-in client can call the new functions or write the tables.
- **E2E:** `e2e/specs/claude-memory.spec.ts` (Uppdatera with the fake Claude, edit a line, save, reload) and `e2e/specs/agent-tasks.spec.ts` ("Hos Claude" on /hem → `update_agent_task` over `/api/mcp` with a seeded token → the note on the meeting page → done → ✓ klart in the Doc).
