# Org dashboard — proposal (todo #2, 2026-11-26)

Simon's idea: "now that we know everything about the org we should be able to give them a pretty good dashboard of goals and what's going on in the org."

This is a proposal for Simon to react to, not an approved design. Nothing is built.

## What Simon Says already knows per förening

From every meeting: decisions (with the agenda item they belong to), tasks (owner/role, due, done or open, carried how many weeks), who attended, which agenda items recur, meeting length and cadence. Todo #4's `meetingChainSummary` gives open/closed task counts per meeting.

## What a board member would want to see (proposal)

1. **Open tasks** — grouped by role/person, with how many meetings each has been carried ("3 veckor"), oldest first. The single most useful view: what is slipping.
2. **Recent decisions** — the last N decisions with date and agenda item, searchable ("när bestämde vi hyran?").
3. **Topics over time** — the agenda items that recur (e.g. "Ekonomi", "Kommande event") and what was decided under each, per month.
4. **Goals** — the open question. Three ways to get them:
   - (a) the admin writes 3–5 goals for the year; Simon Says links decisions/tasks to them (Claude tags each new item with the goal it serves);
   - (b) Simon Says proposes goals from what keeps coming up in meetings, the admin approves (like learning a format);
   - (c) read them from the stadgar / verksamhetsplan Doc the admin picks.
   My pick: (b) with (a) as the edit path — same "propose → approve" pattern the förening already knows.
5. **Attendance** — who comes, trend per person (sensitive: show only to admins? needs Simon's call).

## Questions only Simon can answer

1. Goals: (a), (b) or (c)?
2. Who sees the dashboard — all members or admins only? Attendance per person especially.
3. Where — a tab on the förening page, or a Google Doc/Sheet Simon Says keeps updated (fits "everything lives in Google")?

## Cost

Views 1–3 and 5 are plain database queries (no Claude). Goals (b) is one Claude call per month per förening.
