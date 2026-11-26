# Privat v1 — design (todo #11 part 1; approved by Simon 2026-11-26: "the private one looks good")

Simon: "getting emails is super important after a meeting. for individuals … a summary of the listened meeting is great, like pocketai product, if it can keep track of some important stuff that would be great". Proposal: docs/superpowers/specs/2026-11-26-three-audiences-proposal.md.

## What the user gets
1. A personal space "Privat" per account (auto-created, only them), next to their föreningar.
2. "Spela in": same live engine (consent, ElevenLabs live STT, pause/stop, Meet-like auto-end). Before recording: pick a context (course / project / "Övrigt"; last used suggested; create new inline). No Google Doc by default; optional "Skriv även i ett Google-dokument".
3. The e-mail after (design A style, user's language), ~1 min after the meeting ends: Sammanfattning; Beslut; Mina uppgifter (with owner when someone else); Öppna frågor; "Sedan sist" — the previous meeting in the same context's open tasks marked klart / öppen / inte nämnd. Link to the meeting page. Category in e-mail preferences: "Sammanfattning av mina inspelningar".
4. Per-context page ("keeps track of important stuff"): open tasks across meetings (tick done), a running log of decisions and key facts (newest first), recurring people/topics, list of meetings with their summaries. The next meeting's summary is given this context (what you were working on) so "Sedan sist" and continuity work.
5. Not in v1: read-aloud (ElevenLabs TTS drained credits before), calendar-based context guessing (#14), search/ask over history.

## Decisions (mine)
- Data model: reuse orgs/meetings with a space kind (forening | privat | foretag) so the live engine, billing caps, kill switch, deletion and RLS keep working; a Privat space has exactly one member; contexts = new table per space. Additive migrations only.
- Summary: one Claude call after the final pass over the stored note items + transcript, with the context's open tasks + recent decisions as input; structured output; spend gate; e-mail via sendUserMail gate.
- Privacy: transcript and notes stay in Simon Says (the user's own space); same retention as föreningar; /integritet line.
- Testing: real recording needs ElevenLabs credits (11-28); build and test with the fake EL server / Testmöte path and the e2e suite.
