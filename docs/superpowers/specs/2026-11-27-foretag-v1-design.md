# Företag v1 — design (todo #11 part 2; NOT approved: the calls marked **[Simon to confirm]** are product decisions)

Simon 2026-11-27 (binding): "do the smallest version"; companies need the organisation's hierarchy and visibility follows it ("the CEO can see everything, of course, but the cashier can't see what everyone makes"); the org is a tree (CEO → Head of Development, Head of Communication → their members); tasks are suggested, never forced; keep everything gentle; credits/payment parked; focus stays on transcription + information management. Builds on 2026-11-26-three-audiences-proposal.md, 2026-11-26-privat-design.md and 2026-11-26-concrete-tasks-design.md, plus the private Företag and grupper proposals.

## What the user gets
1. **A Företag space** next to their föreningar and Privat: same recording (consent, live notes, pause, Meet-like auto-end), same Mina uppgifter, same summary e-mail. Colleagues join through the existing invites.
2. **Personer & grupper**: the company as a tree (Ledning → Utveckling, Kommunikation, Ekonomi …). An admin creates nodes and places each person at one node with **Flytta till …** (a list and a sheet on the phone; drag-and-drop later).
3. **Möte för:** on Starta möte picks the meeting's group. The default is the starter's own node; *Hela företaget* is a choice. **Privat möte** is a toggle there.
4. **Kunder**: one page per customer, found from calendar attendees' e-mail domains. It lists the meetings with that customer and their open tasks, and shows only what the viewer may see.
5. **Tasks in suggest mode**: `taskMode()` already returns `suggest` for every non-förening kind. That means no `(vem?)` placeholders, no live prompt, and Avsluta never asks. Vem / När / Klart när are filled when said and left empty otherwise.

## Visibility rule (the core of v1)
> **You see the meetings of your own group, plus every meeting of any group deeper in the tree than your own level. Company admins (CEO/ledning) see everything. A meeting for *Hela företaget* is seen by every member. You also always see your own tasks, wherever they were set, but not the meeting they came from unless the rule lets you. A meeting marked "Privat möte" is seen only by its attendees and admins.** The Privat möte part is **[Simon to confirm]**. The summary mail and the Google Doc go only to people who can see the meeting.

"Level" is the node's depth: root = 0, its children = 1, and so on. A head sits at the parent node's level, so the heads of Utveckling and Kommunikation sit in Ledning. Siblings in a group see each other's meetings. Cousins do not.

Worked examples. Anna (VD, admin) is at the root (depth 0). Erik (head of Utveckling) and Sara (head of Kommunikation) are in Ledning (depth 1). Jonas and Lisa are in Utveckling, Maja is in Kommunikation and Kim (kassör) is in Ekonomi, all at depth 2 under Ledning.
- **Utveckling's sprint meeting** is seen by Jonas and Lisa (own group), Erik and Sara (depth 1 < 2) and Anna. Maja does not see it (same depth, other group), and neither does Kim.
- **Ledning's salary review** is seen by Erik, Sara and Anna. Kim the cashier does not see it, and neither does anyone at depth 2. That is Simon's "the cashier can't see what everyone makes".
- **"Maja gör bilden"** is said in Utveckling's meeting. Maja sees the task in Mina uppgifter (her own task) with its Vem / När / Klart när. She does not see the meeting, its notes or its transcript.

Extras, each **[Simon to confirm]**:
- **(a)** The starter, and attendees found as stored facts (below), also see the meeting, even outside the rule.
- **(b)** In a lopsided tree the literal rule lets a depth-2 member in one branch see depth-3 meetings in another branch. The safer variant limits "deeper" to the subtree of your node's parent. It gives the same answer in all three examples. v1 implements the literal rule unless Simon picks the variant.
- **(c)** An account placed at no node sees only *Hela företaget* meetings, attended meetings and its own tasks (fail closed).
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
- `orgs.kind` already allows `'foretag'` (0045). Clients have no grant on it, so a new security-definer `create_foretag(name)` makes one and goes through the 0041 org limits like any creation. Until the DPA exists it is called only by a server route with an allowlist (Harrysson & Company), **[Simon to confirm]**.
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
3. `note_items_select` gets `or owner_person_id in (my linked people)` for own tasks. The loader in lib/home/load.ts adds a second query for my owned rows, because it fetches meetings first today. An owned task with no visible meeting shows without a meeting link.
4. `groups`: members select, no client writes. `meeting_attendees`: select own rows. `contexts_insert` is unchanged (Privat only), because customers are created by the server.
5. Paths outside RLS, each handled in app code and tested:
   - **Doc sharing:** `createMeetingDoc` shares with the viewer list instead of all members. The Doc goes in the starter's own Simon Says folder, never a shared meeting folder **[Simon to confirm]**. Shares are set at start and are not revoked when someone later moves (known limit).
   - **Summary recipients:** the existing list is intersected with the viewers.
   - **Carried tasks** ("Från förra veckan"): taken only from earlier meetings whose viewers include the new meeting's viewers, in practice the same group and not private.
   - **Org-keyed tables** (prepared_agendas, org_goals, history_*): v1 never writes them for a Företag (see Out of v1), and a test asserts that.

**Tests.** A new tests/db/foretag-visibility.test.ts builds the Anna…Kim tree and checks the full role matrix: admin, head, group member, cousin, unplaced account, attendee outside the group, and a Privat möte. Each case is checked against meetings and every table behind `is_meeting_member`, plus own-task rows. The group functions get tests for moves and cycles. Unit tests cover recipients ∩ viewers, the Doc share list, carried-task filtering and domain → customer. The existing tests/db/rls.test.ts and privat tests run unchanged as the förening/Privat regression. The new code is written test first.

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
- **Summary mail:** by default it goes to the meeting's own group plus its attendees, filtered to viewers. People higher up open it in the app instead **[Simon to confirm]**.

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
- **Gate:** no company other than Harrysson & Company before a DPA (personuppgiftsbiträdesavtal), its subprocessor list and a legal review of /integritet and the terms **[Simon to confirm]**.
