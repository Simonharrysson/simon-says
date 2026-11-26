# Simon Says — live meeting notes in Google Docs (design)

Date: 2026-11-24. Status: draft for Simon's approval.

## Intent and why

Simon Says turns Pocket AI from Simon's private recorder into a **free, real
multi-user service** for organisations in Linköping. A group sits around a
table, opens one web page on one laptop, presses Start, and **structured notes
build up live in their own Google Doc** while they talk.

Why:
- Two of Simon's own organisations (LiU AI Society, Hook & Look Golf) need it
  for their weekly meetings. Real weekly use is how he learns what good notes are.
- **Live, structured notes in Google Docs** is where Simon thinks he can win
  ground against existing note-takers. That is the core bet; everything else is
  in service of it.
- He will build something similar inside Casall later and wants to learn it here first.
- A public GitHub repo + page he can show on LinkedIn (the Nano photo comes
  when the board arrives).

Simon accepted: unverified Google app warning / 100-user cap, paying API costs
himself ("it's fun"), GDPR handled lightly for now, a single visible queue.

## The bigger picture — four projects, in order

1. **Live notes service** — this document.
2. Replay + tuning harness (AMI Meeting Corpus first, then the orgs' own
   recordings paired with the minutes their secretaries write). Later spec.
3. Public showcase: README, live queue page. Small; after 1 works.
4. **Everything on the Jetson** (long-term goal, Simon 2026-11-24): the whole
   pipeline — transcription, speakers, voices and the notes LLM — runs on the
   Jetson Orin Nano 8 GB, with jobs queued; a cloud **turbo mode** stays for
   when notes are needed instantly. Last. Nano photo added to the showcase.
   See "Long-term: everything on the Jetson" below. This design only leaves the slot.

**Step 0, before building 1:** a throwaway spike. Record one real table meeting
on one laptop mic, run it through ElevenLabs `scribe_v3_live` (diarize +
multilang) only (Simon dropped Soniox), and check speaker separation and
Swedish/English quality. Simon's own notes say mic distance mattered more than
the model; nobody has tested live diarization from one laptop mic across a
table. If it fails, the fix is mic placement or a cheap USB mic, not another
provider. The spike also tests voiceprint matching on the same recording
(enrol each person from their first sentence, then check how often labels
match), which picks the voiceprint provider for v1.1.

## Goals

- One laptop, built-in microphone, in a room. No hardware, no install.
- Sign in with Google, press Start; within ~1 minute the Doc shows notes.
- The Doc is **structured notes**, rewritten roughly every 45 s:
  decisions, action items with owner, what's being discussed now. The raw
  transcript lives in a second tab of the same Doc.
- Speaker names, not "Speaker 2".
- Multi-user: several organisations, each with members; any member can run a meeting.
- Swedish, English, and mixes mid-sentence.

## Non-goals (for this project)

- Remote/online meetings (Meet/Zoom bots). Meetings are always in person.
- Several laptops per meeting. One device; revisit only if one mic fails.
- Running on the Nano. It joins later as a worker.
- Billing, paid plans, enterprise features, mobile apps.
- Tuning note quality against a dataset (project 2).

## Anti-goals (failure even if it works)

- **Overwriting what people typed in the Doc.** If the service ever destroys a
  human's edit, orgs stop trusting it. Hard rule.
- Notes that churn so much they can't be read during the meeting.
- A Doc that is a wall of transcript.
- Leaking Simon's private data: this must not share code, keys or database
  with harrysson.co / Pocket AI's business pipeline.
- A runaway bill from one org leaving it running for days.

## Approaches considered

- **A. Web page on a laptop at the table (chosen).** Zero hardware; the
  orgs can use it next week. Trade-off: laptop mic quality — the spike checks it.
- B. A recorder box per org (Pi/Nano). Most "plug and play" and photogenic, but
  every org needs hardware before trying it. Can be added later as just another
  client of the same API.
- C. Build into harrysson.co. Rejected: mixes a public service with Simon's
  private Gmail/customer data, and its Vercel functions can't hold a 2-hour
  audio connection (not needed in A either, see below).

## How it works

```
Laptop browser ──audio (PCM16)──▶ ElevenLabs scribe_v3_live (WebSocket,
      │                                   diarize=true, multilang_mode=true)
      │◀──── partial + committed + diarized transcript events ────┘
      │
      ├─ POST committed segments every few s ─▶ Server (Next.js on Vercel)
      │                                          ├─ stores transcript (Supabase)
      │                                          ├─ every ~45 s: Claude rewrites notes
      │                                          └─ writes Google Doc (Docs API)
      └─ records audio locally, uploads at the end (for the Nano pass later)
```

**Why the browser connects to ElevenLabs directly:** the server mints a
single-use token (`POST /v1/single-use-token/realtime_scribe`, 15-min expiry,
consumed on use) and the browser opens the WebSocket itself. The API key never
reaches the browser, and the server only handles short HTTP requests — so it
fits on Vercel, no long-lived server needed. If the socket drops, the page
gets a fresh token and reconnects; the meeting continues.

Facts verified against live docs 2026-11-24:
- Diarization is only on `scribe_v3_live` (`diarize=true`); `model_id` must be
  set explicitly (default is `scribe_v2_realtime`). Speaker labels on partials
  can change as audio arrives; use committed / diarized events for the Doc.
- `multilang_mode=true` follows mid-sentence language switches, v3 Live only,
  not in the official SDKs yet → raw WebSocket.
- Swedish supported. Audio `pcm_16000` (16-bit PCM, base64). Cost $0.22/h,
  silence billed. No documented max session length; there is a
  `session_time_limit_exceeded` error → reconnect logic is required.

### Speaker names — remembered voices (Simon: "we need to remember voices")

The service remembers each person's voice per org, so from the second meeting
on, names appear without a name round.

1. **Enrolment = the name round.** First time someone attends, they say
   "*Jag heter Anna och …*" (one sentence, ~5 s). The server cuts that audio
   (the browser keeps the raw audio), computes a **voiceprint** (speaker
   embedding) and stores it on Anna's member record in that org.
2. **Recognition during the meeting.** When a new diarized speaker label has
   ~10 s of speech, the browser sends that clip; the server embeds it and
   matches against the org's voiceprints. Confident match → label named
   automatically. Unsure → shown as "Anna?" for someone to confirm with one tap.
   Unknown → page asks that person to say the enrolment sentence.
3. **Typed fix** stays: rename or reassign any label live if it drifts; a
   correction also improves the stored voiceprint.
4. Claude may *suggest* names from context ("tack Anna") but never applies them silently.

**Voiceprint provider — open, decided by the spike:** a hosted
speaker-identification API (e.g. pyannoteAI voiceprints) or a small open
embedding model (ECAPA/WeSpeaker class) on a small CPU server. Must be
verified before building; the Nano can take this over later.

**Consent (required, not optional):** a voiceprint is biometric data under
GDPR (art. 9) → explicit consent per person. Enrolment asks each person "Save
my voice so I'm recognised next time?" (yes/no); no → they are named by the
name round each meeting instead. Any member can delete their voiceprint, and
it is deleted when they leave the org.

### The Google Doc

- Permission: `drive.file` at sign-in, for everyone (non-sensitive scope; no heavy Google
  review). It covers documents the app creates or the user picks via Google Picker.
- **One exception, `drive.readonly` (Simon, 2026-11-26, branch import-native):** only for an
  admin, only when they start "Läs in gamla protokoll", by **incremental authorization**
  (`include_granted_scopes=true`, `app/(app)/orgs/drive-access.ts`); never at sign-in and never
  required anywhere else. It lets the import list the admin's folders and the Docs in them
  (`lib/history/drive-list.ts`, metadata only; a Doc is opened only when ticked) instead of the
  Picker, because with `drive.file` picking a folder does not grant its children. The refresh
  token from that consent is stored **apart** (`google_import_tokens`, 0034, encrypted like
  `google_tokens`) and used only by the import's routes; the sign-in token is never replaced and
  keeps its own scopes, and `getGoogleAuth` fails closed on any stored token wider than drive.file.
  The import token lives 24 h (lookup cutoff + the 5-minute cron deletes it); "Ta bort
  läsåtkomst" deletes our copy at once. We do not call Google's revoke: revoking any token of a
  combined (incremental) grant revokes all of its scopes, the sign-in drive.file included. The
  consent must come back as the signed-in user, else that session is signed out, the admin's
  restored and nothing stored (`?drive=konto`). The read access opens only files the admin's own
  listing signed (`lib/history/ticket.ts`, 3 h). An admin who says no gets the Picker.
  **`drive.readonly` is a Google "restricted" scope:** the app must pass Google's verification
  **and a third-party security assessment (CASA)** before it can be used by more than 100 users;
  until then Google shows an "unverified app" warning on that consent screen and the 100-user
  cap applies. Consider this before the service opens wider.
- Default: the service **creates a new Doc per meeting** in the förening's
  meeting folder when the starter's grant can add to it (they picked the folder
  once in the Picker), else in the starter's own folder "Simon Says – <förening>".
  Named `<YYYY-MM-DD HH.MM> Mötesprotokoll – <förening>` (Testmöte marked). Option: pick an existing Doc (e.g. the org's running
  minutes Doc) via Picker.
- Layout (tab 1 = notes, tab 2 = transcript, added with `addDocumentTab`):

```
Styrelsemöte LiU AI Society, 24 nov   ● LIVE 00:42:10
Närvarande: Simon, Anna, Erik
─ Beslut ─
 ✓ Hackathon 14 feb, budget 8 000 kr
─ Att göra ─
 □ Simon: boka lokal (fre)
─ Pågår nu ─
 Diskussion om sponsorer… (Anna, Erik)
[Tab: Transkript]  Anna 00:41:52: …
```

- **The service owns exactly one named range** in tab 1 (the notes block) and
  appends to tab 2. It writes with `replaceNamedRangeContent`, never with a
  whole-document overwrite, so text people type outside the range is untouched.
- **Human edits inside the range are kept:** before each rewrite the server
  reads the range; if it differs from what it last wrote, the human-edited text
  goes to Claude as "authoritative — keep these edits". Never discard them.
- Writes are ≤ 2 per 45 s per meeting, well under the 60 writes/min/user quota.
- At the end: a final, cleaner pass over the full transcript replaces the notes
  block; the LIVE marker is removed.

### Claude

- Model `claude-opus-5-5` (the default), streaming, structured output for the
  notes JSON (decisions, action items {owner, what, when}, current topic,
  attendees); the server renders JSON → Doc text. Prompt caching on the stable
  prefix (instructions + transcript so far) keeps 45-s rewrites cheap.
- Input each tick: previous notes, human edits, new transcript since last tick
  (plus the full transcript, cached). Instruction: change as little as possible
  — stable notes matter more than perfect notes mid-meeting.
- Server-side fallbacks enabled for refusals.

### Accounts, orgs, limits

- Sign in with Google (Supabase Auth, Google provider, plus `drive.file`).
- Org = name + invite link; members can start meetings; org admin = creator at first. Admins can
  make other members admin (board turnover); an org always keeps at least one admin, and if the
  last admin's account is deleted the oldest member becomes admin (migration 0031).
- **Usage cap per org**: e.g. 20 h/month and max 4 h per meeting
  (auto-stop with a warning at 3h45). Global daily spend alarm emailed to Simon.
- **Public queue/status page** shows live meetings and (later) the Nano queue,
  with org names only if the org opts in.

### Data and retention (light GDPR)

- Transcripts + notes stored in Supabase (EU region), deleted with the meeting or the org.
- Audio uploaded after the meeting, kept 30 days for the Nano pass, then deleted.
- Privacy page states: who processes (ElevenLabs, Anthropic, Google, Supabase,
  Vercel), what's stored, how to delete. A proper DPA comes later.

### Repo and hosting

- **New public repo `simon-says`** with fresh history — nothing copied from
  `pocket-ai` git history (keys were exposed there). Secrets only in env.
- Next.js + TypeScript on Vercel (new project), Supabase (new project). Domain: builder's call.
- Pocket AI's Mac/Pi recorders are not part of this project.

## Decided by Simon

Live structured notes (option B) with transcript in its own tab; laptop built-in
mic, one laptop; real multi-user service; ElevenLabs + Claude on Simon's keys
until the Nano; public queue; light GDPR; name round for speakers; voices
remembered across meetings; tuning later; order live notes → tuning →
showcase → Nano last.

## My calls (Simon can override)

Browser→ElevenLabs direct with tokens; Vercel + Supabase; new Doc per meeting
by default; owned named range + keep-human-edits rule; ~45 s tick; usage caps;
30-day audio retention; separate repo/infra from harrysson.co.

## Simon's answers after the builder check (2026-11-24)

- **Remembered voices = v1.1, not v1.** v1 ships with the name round + typed
  renames only, on Vercel + Supabase, nothing else to host. Voiceprints
  (section "Speaker names — remembered voices") come about a week later, after
  the spike picks the provider. v1's data model should already have a
  per-org person list so v1.1 only adds voiceprints to it.
- **Only one account per meeting.** Only the person who runs the meeting signs
  in with Google. Everyone else is a name in the org's person list (no account).
  For v1.1 voice saving, a person consents by scanning a QR code on the laptop
  screen and saying yes on their own phone (no account; that link also lets
  them delete their voice). "Org members" in this doc means signed-in people
  who can run meetings; Docs are shared with their Google accounts.

## Calls made after the builder check (Simon can override)

- **Human edits are locked, not merged.** Each notes item carries an ID; an
  item a human edited is kept verbatim and flagged locked. Claude may add items
  around it, never reword or drop it — including in the end-of-meeting pass.
- **v1 = one new Doc per meeting.** "Pick an existing Doc" moves to a later version.
- **No full-audio upload in v1.** Only the short enrolment / recognition clips
  are stored (for voiceprints). Full audio returns with the Nano project.
  (Supersedes the "records audio locally, uploads at the end" line above.)
- **Doc ownership:** whoever pressed Start owns the Doc (in the meeting folder
  or their own Drive); the service shares it (writer) with all org members'
  Google accounts, and with members who join later (through the starter's grant,
  recorded in `meeting_doc_shares`, 0030). The service only shares Docs it
  created; an agenda Doc is the förening's own to share.
  Removing a member does not revoke their Drive access: Google keeps it; remove
  it by hand in the Doc or folder.
  A Doc in the meeting folder inherits the folder's sharing, including the
  Transkript tab: admins should share the folder only with the board. The
  server stores that user's Google refresh token encrypted (Supabase Auth does
  not keep it). If it is revoked mid-meeting, transcription continues, the page
  shows "Doc paused — sign in again", and the backlog is written once fixed.

## Local worker hardware (decided 2026-11-24)

Jetson Orin Nano 8 GB, not a Mac mini. Simon chose it knowingly: a Mac mini
M4 16 GB would be faster and simpler (twice the memory, similar bandwidth),
but he wants the CUDA/edge learning ("i want the fiddle"). Implication for
project 4: transcription and diarization run one after the other on 8 GB.

**Quality rule (Simon worried transcription and LLM quality might drop):**
- In v1–v1.x notes are written by Claude in the cloud, and live transcription
  by ElevenLabs.
- Each stage (transcription, speakers, voices, notes) moves to the Nano only
  when project 2's harness shows it is at least as good as the cloud on the
  orgs' own meetings (WER + speaker errors for audio; recall of decisions and
  actions, churn and readability for notes). Until then it runs in shadow mode
  as a test bench; users never see worse output.

### Long-term: everything on the Jetson (Simon, 2026-11-24)

Mark 1 (Pocket AI) ran entirely in the cloud. Simon's challenge for Simon Says
is to run **all of it on the Jetson**. Speed is not a goal — jobs are queued —
except for a **turbo mode** (cloud: ElevenLabs + Claude) when notes are needed
instantly. Approach (estimates, to be measured in project 4):

| Stage | On the Jetson | Expectation |
|---|---|---|
| Transcription | KB-Whisper / Whisper large-v3-turbo | Feasible |
| Speakers, voiceprints | pyannote, run after transcription | Feasible on 8 GB, sequentially |
| Live notes (every ~45 s) | Small open model (e.g. Qwen3 4B–8B, 4-bit) fully in memory | Speed OK; quality for Swedish/English notes is the open question |
| Final notes after the meeting | Larger model run **layer by layer**, weights streamed from NVMe per layer (AirLLM-style), or an **MoE** model (e.g. Qwen3-30B-A3B) loading only active experts | Prefill of the whole transcript batches well; decoding reads the weights once per token (~6 s/token for a dense ~18 GB model at ~3 GB/s → ~1 h per meeting). MoE is expected to be far faster and is the first thing to try |

Consequences: layer streaming can't serve live notes (only the post-meeting
pass); NVMe read speed matters → buy a fast SSD. Project 2's harness is the
referee between Claude and the open models. Model choice, quantisation and
streaming are Simon's calls, measured teach-style.
- Project 4 is run teach-style: Simon makes the calls and does the measuring
  (memory budget, INT8 vs FP16, tegrastats, cost per hour); Claude writes the code.

## Token safety (Simon asked "is that safe enough?")

The API key never leaves the server. The remaining risk is cost abuse, so
the token endpoint: requires a signed-in user with an active meeting; issues
one token at a time per meeting (a new one only on reconnect); sets
`max_session_duration_seconds` on each token; counts toward the org's usage
cap. Simon also sets a spend cap in the ElevenLabs dashboard.

## Left to the builder

UI details, exact prompt, tick tuning (30–60 s), reconnect/backoff, how the
"LIVE" header is drawn, folder naming, test strategy (a replay script that
streams a WAV file through the browser pipeline is strongly suggested — it
becomes project 2's harness).
