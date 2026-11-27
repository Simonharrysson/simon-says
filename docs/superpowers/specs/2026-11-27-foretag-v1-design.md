# Företag v1 — design (todo #11 part 2; approved by Simon 2026-11-27 "go": every call marked **[decided 11-27]** was confirmed)

Simon 2026-11-27 (binding): "do the smallest version"; companies need the organisation's hierarchy and visibility follows it ("the CEO can see everything, of course, but the cashier can't see what everyone makes"); the org is a tree (CEO → Head of Development, Head of Communication → their members); tasks are suggested, never forced; keep everything gentle; credits/payment parked; focus stays on transcription + information management. Builds on 2026-11-26-three-audiences-proposal.md, 2026-11-26-privat-design.md and 2026-11-26-concrete-tasks-design.md, plus the private Företag and grupper proposals.

## What the user gets
1. **A Företag space** next to their föreningar and Privat: same recording (consent, live notes, pause, Meet-like auto-end), same Mina uppgifter, same summary e-mail. Colleagues join through the existing invites.
2. **Personer & grupper**: the company as a tree (Ledning → Utveckling, Kommunikation, Ekonomi …). An admin creates nodes and places each person at one node with **Flytta till …** (a list and a sheet on the phone; drag-and-drop later).
3. **Möte för:** on Starta möte picks the meeting's group. The default is the starter's own node; *Hela företaget* is a choice. **Privat möte** is a toggle there.
4. **Kunder**: one page per customer, found from calendar attendees' e-mail domains. It lists the meetings with that customer and their open tasks, and shows only what the viewer may see.
5. **Tasks in suggest mode**: `taskMode()` already returns `suggest` for every non-förening kind. That means no `(vem?)` placeholders, no live prompt, and Avsluta never asks. Vem / När / Klart när are filled when said and left empty otherwise.

## Visibility rule (the core of v1)
> **You see the meetings of your own group, plus every meeting of any group deeper in the tree than your own level. Company admins (CEO/ledning) see everything. A meeting for *Hela företaget* is seen by every member. You also always see your own tasks, wherever they were set, but not the meeting they came from unless the rule lets you. A meeting marked "Privat möte" is seen only by its attendees and admins.** Privat möte is **[decided 11-27]**. The summary mail and the Google Doc go only to people who can see the meeting.

"Level" is the node's depth: root = 0, its children = 1, and so on. A head sits at the parent node's level, so the heads of Utveckling and Kommunikation sit in Ledning. Siblings in a group see each other's meetings. Cousins do not.

Worked examples. Anna (VD, admin) is at the root (depth 0). Erik (head of Utveckling) and Sara (head of Kommunikation) are in Ledning (depth 1). Jonas and Lisa are in Utveckling, Maja is in Kommunikation and Kim (kassör) is in Ekonomi, all at depth 2 under Ledning.
- **Utveckling's sprint meeting** is seen by Jonas and Lisa (own group), Erik and Sara (depth 1 < 2) and Anna. Maja does not see it (same depth, other group), and neither does Kim.
- **Ledning's salary review** is seen by Erik, Sara and Anna. Kim the cashier does not see it, and neither does anyone at depth 2. That is Simon's "the cashier can't see what everyone makes".
- **"Maja gör bilden"** is said in Utveckling's meeting. Maja can't see that meeting, so the task waits as *Väntar på godkännande* for Jonas, who started the meeting. Jonas approves it, and can reword it first. Only then does Maja see it in Mina uppgifter, as the task text, "Från Jonas" and its due date. She never sees the meeting, its title, notes, decisions or Doc.

Extras, each **[decided 11-27]**:
- **(a)** The starter, and attendees found as stored facts (below), also see the meeting, even outside the rule.
- **(b)** The literal rule: every group deeper than your level, in any branch (not limited to your parent's subtree).
- **(c)** An account placed at no node sees only *Hela företaget* meetings, the meetings it started or attended, and approved tasks (fail closed).
- **(d)** A person sits at one node only.

## Data model (migration 0050_foretag.sql, additive only)
```
groups     id, org_id, name (1–40, unique per org among unarchived), parent_group_id → groups null (null = root),
           depth int (kept by trigger: parent.depth + 1; the trigger refuses cycles and recomputes the subtree on a move),
           position, archived_at
people     + group_id → groups null        -- the person's node; null = not placed
meetings   + group_id → groups null        -- null = Hela företaget (every förening/Privat row stays null)
           + private boolean not null default false
meeting_attendees  meeting_id, user_id, source ('starter'|'calendar'|'listed'); server-written
contexts   + domain text null (unique per org); a Företag customer = a context with a domain
```
- `orgs.kind` already allows `'foretag'` (0045). Clients have no grant on it, so a new security-definer `create_foretag(name)` makes one and goes through the 0041 org limits like any creation. Until the DPA exists it is called only by a server route gated by an allow-list (env `FORETAG_CREATOR_EMAILS`, like ADMIN_EMAILS), **[decided 11-27]**.
- Admin writes go through security-definer `set_group()` and `set_person_group()`, like `set_person_role()` (0025). Groups are archived, never deleted, because old meetings point at them.
- `meeting_attendees` is written by the server only, and it fails closed:
  - `calendar`: a calendar guest whose e-mail equals a member's sign-in address.
  - `listed`: a Närvarande name that matches exactly one linked person by full name. The ambiguous-first-name rule in lib/summaries/recipients.ts is for "don't mail someone who was there" and is never used for access.
- Everything is nullable or defaulted, so code from before this deploy still works.

## RLS changes
1. A new `can_see_meeting(meeting_id)` (security definer, stable). For a meeting outside a Företag it returns `is_org_member(org_id)`, exactly as today. For a Företag meeting it returns true when any of these holds:
   - the viewer is an admin, the starter, or in `meeting_attendees`;
   - the meeting is not private and (`group_id is null`, or it is my node, or `depth > my depth`).
   "My depth" is the depth of the node of the `people` row linked to `auth.uid()` in that org.
2. `meetings_select` uses `can_see_meeting(id)`. `is_meeting_member()` is redefined as `can_see_meeting()`, so every table under a meeting follows with no policy edits: note_items, speaker_map, meeting_events, el_sessions, private_summaries, segments (server-only).
3. `note_items_select` is unchanged: only viewers of a meeting read its rows, the owner included. Tasks crossing the boundary go through `task_handoffs` (below).
4. `groups`: members select, no client writes. `meeting_attendees`: select own rows. `contexts_insert` is unchanged (Privat only), because customers are created by the server.
5. Paths outside RLS, each handled in app code and tested:
   - **Doc sharing:** `createMeetingDoc` shares with the viewer list instead of all members. The Doc goes in the starter's own Simon Says folder, never a shared meeting folder **[decided 11-27]**. Shares are set at start and are not revoked when someone later moves (known limit).
   - **Summary recipients:** the existing list is intersected with the viewers.
   - **Carried tasks** ("Från förra veckan"): taken only from earlier meetings whose viewers include the new meeting's viewers, in practice the same group and not private.
   - **Org-keyed tables** (prepared_agendas, org_goals, history_*): v1 never writes them for a Företag (see Out of v1), and a test asserts that.

**Tests.** A new tests/db/foretag-visibility.test.ts builds the Anna…Kim tree and checks the full role matrix: admin, head, group member, cousin, unplaced account, attendee outside the group, and a Privat möte. Each case is checked against meetings and every table behind `is_meeting_member`, plus own-task rows. The group functions get tests for moves and cycles. Unit tests cover recipients ∩ viewers, the Doc share list, carried-task filtering and domain → customer. The existing tests/db/rls.test.ts and privat tests run unchanged as the förening/Privat regression. The new code is written test first.

## Task delivery across visibility (Simon 2026-11-27, safe default)
AI-written task text from a restricted meeting can leak what the owner may not see, for example a task from a CEO meeting given to someone at the bottom. So no AI text crosses the visibility boundary unreviewed.

**Delivery:**
- A task reaches its owner directly only when the owner can see the meeting. They then read it in `note_items`, as today.
- Otherwise, when the meeting ends, the server writes a `task_handoffs` row with status `pending`. It holds a copy of the text, the due date, the giver's name and who must approve.
- The approvers are the meeting's starter and the company admins. They see *Väntar på godkännande* in Mina uppgifter and approve it, optionally rewriting the wording, or drop it.

**What the receiver sees after approval:**
- Only the reviewed text, "Från <name>" and the due date.
- Never the meeting's title, link, notes, decisions or Doc.
- Mina uppgifter and every mail respect this.

**Enforced in the database:**
- `task_handoffs_select` lets the approvers see every status. The owner sees a row only when its status is `approved`.
- Approving goes through `approve_task_handoff(id, text)`, ticking done through `set_task_handoff_done(id, done)`. Clients get no table writes.

**Later hand-overs:** any later hand-over of a task to someone outside the meeting's audience goes through the same row and the same approval. Only the task travels, with a file attached later.

**Tests:**
- DB: a task from a CEO meeting for a bottom member stays invisible until approved. After approval the member reads the reviewed text but not the meeting, its title or notes.
- e2e: the same flow, end to end.

## Customers (Kunder)
- At start, and again at the end against the matched calendar event, the external domains are the attendee domains that are none of the company's own. The company's own domains are the members' sign-in domains.
- Free-mail domains (gmail.com, outlook.com, hotmail.com, icloud.com, live.se, yahoo.com, proton.me …) never make a customer.
- Several external domains: the one with the most attendees wins. The customer can be changed on the meeting page.
- Each customer is a `contexts` row with that `domain`, created on first sight, named from the domain ("acme.se" → "Acme") and renamable. It is set as `meetings.context_id`. No calendar means no customer: pick one or "Ingen kund".
- The page lists the viewer's visible meetings with that customer (RLS does the filtering) and open tasks from their `note_items`. It uses no external data.
- Only the domain is stored. No external e-mails or names are stored. That needs one new /integritet line ("kundens e-postdomän").

## How a Företag differs from a förening in the UI
- **Words:** team / kolleger / kund instead of förening / medlemmar.
- **Navigation:** the tabs are Möten · Kunder · Personer & grupper · Inställningar.
- **Formats:** only Standard, with no stadgar or Årsmöte formats.
- **Removed:** the "Kräv vem, när och klart när" setting (always suggest), the public profile and status page, Översikt / goals, Förbered möte and history import.
- **Summary mail:** by default it goes to the meeting's own group plus its attendees, filtered to viewers. People higher up open it in the app instead **[decided 11-27]**.

## Out of v1
- Credits and billing.
- CRM and export.
- Gmail, Slack, event descriptions and Drive files from invites.
- A follow-up mail draft to the customer.
- The Vi/Kunden task split, and suggestion cards with a source and "Stämmer".
- A retention setting.
- Förbered möte, Översikt and history import in a Företag.
- Drag-and-drop in the tree, and a person at more than one node.
- Revoking Doc shares when someone moves.
- Search over history.
- More than one live meeting per company at a time.
- **Gate:** no company other than Harrysson & Company before a DPA (personuppgiftsbiträdesavtal), its subprocessor list and a legal review of /integritet and the terms **[decided 11-27]**.

## Föreningar with groups (0054, proposed in PR #45, not yet confirmed by Simon)
Simon asked for this on 2026-11-27: the same tree, the same visibility rule, opt-in. The calls below are the implementer's and are open for review. A förening may opt in to the same tree, with the same visibility rule and the same task delivery across visibility. It is off by default. A förening without groups behaves exactly as before, and its visibility check keeps the one-join fast path.
- **Turning it on and off:** an admin uses Inställningar → Styrelsen och medlemmar → Grupper.
  - *Organisera i grupper* creates the top group (default "Styrelsen") and places every linked person in it, so nobody linked sees less. Members without a name in the list are unplaced from then on, and the confirm says how many.
  - *Sluta använda grupper* opens every meeting to every member again. Groups and places are kept for a later turn-on.
- **Shared with Företag:** `orgs.groups_enabled` widens "is a Företag" to "has the tree" (`org_has_tree`) in the predicate and in the group, place and handoff functions. The tree editor (`components/groups/GroupTree`) and `GroupPicker` are shared too.
- **Förening-specific:**
  - Formats, agenda Docs and "kräv Vem/När/Klart när" stay. An agenda or prepared Doc can be used only for a meeting of the whole förening.
  - There is one live meeting at a time, and no calendar attendees or customers. A Privat möte is therefore seen by its starter and the admins.
  - The summary keeps the förening's own mode, filtered to the viewers.
  - "Från förra veckan" carries tasks only from the same group, and never from or into a Privat möte. Förbered möte, goal proposals and history digests draw only from meetings of the whole förening.
  - A placed person row is written by admins only. While groups are on, only an admin links any row to an account, so a member can't link themself into a place.
