# Growth loop — design (draft for Simon, 2026-11-27; no product code yet)

Simon 2026-11-27 (binding, marked **[Simon]**): copy tl;dv's mechanism, not its look. After a meeting, every attendee who has **no account** gets an e-mail that shows a real text teaser of the notes and one button into the app. Anyone **with an account** keeps getting our normal mail as today (the summary, or "Du missade mötet"), never this one. Mock (fictional Sjöstadens Kanotklubb): `~/simon-says-private/growth-loop/` (invite + reminder, light/dark, desktop/phone; `build.mjs` reuses the real summary renderer's shell from lib/summaries/email.ts).

## What the recipient gets
- **From** `Johanna via Simon Says <noreply@harrysson.co>`, **subject** `Johanna bjöd in dig till "Styrelsemöte november"` **[Simon]**. The first name is the person who started the meeting (`meetings.started_by` → their people row). The title is the calendar title (0048), else "Mötet 24 november".
- **Preheader**: "Du har 2 uppgifter från mötet" **[Simon]**, else "Du nämndes i mötet" **[Simon]** (only when the name round heard them or a note row names them), else "4 beslut och 6 uppgifter från mötet" (mine: a calendar guest who was never named must not be told they were mentioned).
- **Body (design A, same shell as the summary mail)**: the eyebrow "Johanna Linds anteckningar · <förening>", the title, one lead line and a count chip "4 beslut · 6 uppgifter". Then **Dina uppgifter** in full (Vem / När / Klart när when present), the first 2 decisions in stepped greys fading into "…och N beslut till", and one button **Läs allt och bocka av** with the grey line "Du loggar in med ditt Google-konto och hamnar direkt i mötet" **[Simon]**. The fade uses stepped text colours, not a gradient or an image, so it works in Outlook, Gmail and dark mode. Real text throughout, no blurred image.
- **Footer**: a reason line that is true for this recipient ("…och du stod på mötets gästlista" / "…och du var med på mötet"), the List-Unsubscribe header and an "Avsluta prenumeration" link, then below a rule one small line: "Gratis för din förening – starta ett eget möte" **[Simon]**.
- **Plain-text part** with the same content, as every mail already has.
- The recipient's language comes from `localeForEmail()`, Swedish when unknown.

## Recipients (a pure function, `inviteRecipients()`, next to `summaryRecipients()`)
1. **Candidates** **[Simon]**:
   - Guests of the meeting's linked calendar event who did not decline.
   - People the name round identified (speaker_map → person, not `needs_confirm`) who have an e-mail in the people list.
2. **Has an account** means a confirmed `auth.users` address equal to the candidate's, or a people row with `member_user_id`. Anyone with an account drops out here and stays in today's summary flow.
3. **Dedupe** by trimmed, lowercased address (no Gmail dot rules). If a calendar guest matches a people row (`matchAttendees`), that is one person with source `both`. **One mail per address per meeting across both ledgers.** In summary mode `all`/`selected`, a no-account *attendee* gets the invite *instead of* the summary. Absentees are unchanged **[Simon]**: in mode `missed` the two lists can't overlap, because expected and present people are never "missed".
4. **No e-mail** (the name round added "Kim" without an address): nobody is mailed. A count goes in the `invites` event. Later, the meeting page could tell the starter "2 deltagare fick inget mejl – lägg till e-post" (out of v1).
5. **Already has an account under another address**: we can't know this when sending, so they get the invite at the listed address. At the landing they can verify that address and link it (see below). If their people row is already linked, step 2 caught them.
6. **Never sent**:
   - The starter.
   - `is_test` meetings.
   - Privat spaces.
   - Meetings with `no_notes`.
   - Föreningar whose new setting **Skicka anteckningar till deltagare utan konto** is off (default on, under Inställningar → Sammanfattning efter mötet).
   - Addresses the e-mail gate says no to. The gate covers the new category `meeting_invite` (a migration replacing `email_categories()`) and "Inga mejl alls", and it already works per address with no account (0039) **[Simon]**.
   - Hard-bounced or complained addresses.
7. **Caps (mine)**:
   - At most 25 invites per meeting.
   - At most 1 invite per address per förening per 7 days.
   - After 3 invites in a row from one förening with no click, nothing more to that address from that förening for 90 days.
8. **Företag** **[Simon: visibility rules, private never]**, building on origin/foretag 0050. v1 sends **no** Företag invites (DPA gate). When it does:
   - Only people rows inside the company. Never external calendar guests or customer domains.
   - Only if `can_see_meeting` would be true for that person once linked.
   - Never for a `private` meeting.
   - Never a task held in `task_handoffs`.

## Landing after the click
- The link is `https://simonsays.harrysson.co/r/<token>`. The token is 128 random bits, stored only as a SHA-256 hash, and expires after 30 days.
- **GET only logs and redirects** (`clicked_at`, first time). Mail scanners (Outlook Safe Links, Gmail) prefetch links, so a GET must not claim anything. The landing page `/in/<token>` (public, noindex) sends a small JS beacon that sets `clicked_human_at`; scanners rarely run JS. The page shows only what the mail already showed: "Johanna Lind bjöd in dig till Styrelsemöte november" and **Fortsätt med Google**.
- **Sign-in in one tap:** `/login?next=/in/<token>/klar` (with `next` keeping the query string).
  - **Blocker:** `auth/callback` signs out anyone who did not grant `drive.file`. A reader then sees Google's Drive consent screen, so it isn't one tap.
  - Proposal: a reader sign-in with basic scopes only. The callback accepts a missing `drive.file` when `next` is a claim path, and asks for `drive.file` later as incremental consent (the `atkomst=` pattern) the first time they start a meeting. See open question 1.
- **Claim** (`/in/<token>/klar`): reached only through the OAuth return with a fresh session (the code is single-use, so it can't be prefetched). Older than 2 minutes, it shows a button instead. Then:
  - **The signed-in Google address equals the invited address.** The server claims the token for this user (single-claim), links the people row (`member_user_id`, as `link_person_by_email` does), joins the förening as a member (as `join_org`, which shares earlier Docs) and redirects to `/orgs/<org>/mote/<meeting>?fran=inbjudan`, scrolled to Dina uppgifter.
  - **Another address** (someone who has an account under another e-mail, or a forwarded mail). The page says "Mejlet gick till o•••@exempel.se". **Skicka en länk dit** sends a one-time link (15 min) to the invited address, and opening it while signed in links the row as above. Otherwise: "Be Johanna lägga till dig".
  - **The token was already claimed** by this user: redirect. Claimed by someone else: "Inbjudan är redan använd". The page gives no access and no content.
  - **Expired**: the same page with a plain sign-in. A matching confirmed address still links through the existing join path.
- **Why this is safe when forwarded:** the token never grants access on its own. Access needs a Google-confirmed address equal to the invited one, or proof of the invited inbox. The token carries attribution and routing only.
- **A calendar-only guest** (no people row) has no row to link to. See open question 2. Default proposal: on claim, create a people row (Google name) and give **meeting-scoped read** (`meeting_readers`) instead of full membership, plus a "Gå med i föreningen" request an admin approves.

## Reminder
- **One reminder, only if not clicked, never more** **[Simon]**.
- **Mechanism:**
  - A new step in the existing 5-minute cron. The summary sweep stops at 48 h, so this step has its own pickup.
  - It picks rows where `sent_at ≤ now − 48 h`, `clicked_human_at` and `claimed_at` are null, `reminder_at` is null and `sent_at > now − 96 h`. Rows that are too old are skipped, never sent late.
  - Every check runs again: still no account, the gate still allows (with the category re-read), the setting still on, the meeting not deleted.
  - Sends only 08–20 Stockholm time, otherwise at the next 08:00.
  - Ledger first, then send, with the Resend Idempotency-Key `inv-<id>-r`, as the invites do (0038).
- **Content:**
  - Subject: `(Påminnelse) Johanna bjöd in dig till "…"`.
  - Body: the tasks and the button only, with "Det här är den enda påminnelsen".
  - No upsell line (mine: keeps the reminder plainly informational).

## Tracking (funnel per meeting: sent → opened → clicked → signed up → came back in 7 days) **[Simon]**
| Step | Source | Note |
|---|---|---|
| sent | our row: Resend accepted | `sent_at` |
| delivered / bounced / complained | Resend webhook (Svix-signed) `/api/resend/webhook` | bounce → suppress address; complaint → `meeting_invite` off for that address |
| opened | Resend `email.opened` | Unreliable: Apple Mail Privacy Protection opens everything and many clients block the pixel. Shown as "≥ X". Open tracking is per sending domain, so turn it on **only** for an invite subdomain (e.g. `mote.harrysson.co`) and never on summary or other mail. Resend click tracking stays off. |
| clicked | own redirect + JS beacon | `clicked_human_at` is the funnel number; raw GETs are kept to measure scanner noise |
| signed up | claim | `claim_kind`: new_account / existing_account / verified_other_email |
| came back ≤ 7 d | (app) layout touch | `returned_at`, set once on the first authenticated page view 12 h–7 d after `claimed_at` |

The numbers sit in a SQL view `meeting_invite_funnel` (per meeting and per förening, counts only), operator-only in v1. Logs and `invites` events hold counts, never addresses or names.

## Privacy, GDPR and marketing law (notes for review, not legal conclusions)
- **Primarily informational** **[Simon]**:
  - The mail delivers the recipient's own tasks from a meeting they took part in.
  - The upsell is a single line in the footer, missing from the reminder.
  - No discount, no "free trial" language.
- **Risks against Marknadsföringslagen 2008:486** (unsolicited e-mail to natural persons, §19) and its misleading-practice rules:
  - The subject "bjöd in dig" goes out **in the starter's name** without the starter pressing anything.
  - The mitigation is that the starter is told before Starta: "Deltagare utan konto får sina uppgifter från mötet via mejl från dig", with a per-meeting toggle (default on).
  - Have it reviewed.
- **GDPR roles.**
  - The förening is controller for its meeting content.
  - The growth/upsell aspect is Harrysson & Company's own purpose, so we are likely controller for that part. It needs a legitimate-interest assessment and new /integritet lines: calendar guests' addresses kept for this mail, the click and open tracking, and the retention below.
- **Minimisation.**
  - The mail carries only the recipient's own tasks, 2 decisions and counts. Decisions can be sensitive, and a calendar-only guest is new exposure compared with today, which is one reason for open question 2.
  - Calendar guest addresses are kept in a server-only table, never in `meetings` (members can read that table). The Företag spec promises that no external addresses are stored, and Företag v1 doesn't send at all.
- **Retention:** the address and name on an unclaimed invite are nulled after 90 days. Counts are kept.
- **Opt-out:** the gate, the one-click header and `/mejl?k=meeting_invite`. A complaint is an opt-out.

## Data model sketch (no migration yet)
```
meeting_invites   id, meeting_id → meetings (cascade), org_id, person_id → people null (null = calendar-only guest),
                  email (lower), name, source ('calendar'|'name_round'|'both'), token_hash unique, expires_at,
                  status ('sending'|'sent'|'failed'|'uncertain'|'skipped'), skip_reason, idem_key,
                  sent_at, delivered_at, bounced_at, complained_at, opened_at, clicked_at, clicked_human_at,
                  reminder_status, reminder_at, claimed_at, claimed_by → auth.users, claim_kind, returned_at, created_at
                  unique (meeting_id, email); RLS: service role only
meeting_calendar_guests  meeting_id, email, name, response  -- unmatched guests, written at start (lib/meetings/start.ts), deleted 30 d after end
orgs              + invite_attendees boolean not null default true  (Företag: false)
meetings          + invite_attendees boolean not null default true  (the starter's per-meeting toggle)
email_categories()  + 'meeting_invite'
meeting_readers   meeting_id, user_id  -- only if open question 2 lands on meeting-scoped read
email_suppressions  email, reason ('bounce'|'complaint'), at  -- or fold into the 0039 address prefs
```
Code: `lib/growth/{recipients,email,send,claim}.ts`, `app/r/[token]`, `app/in/[token]`, `app/api/resend/webhook`. The mail renderer mirrors `lib/summaries/email.ts` (pure, escaped, i18n keys under `emails.invite.*`).

## Out of v1
- Företag sends.
- Privat recordings.
- More than one reminder.
- Referral rewards and A/B tests.
- A funnel UI for förening admins.
- The "inget mejl" prompt to the starter.
- SMS.
- Open pixels on the main sending domain.
- Inviting the förening itself to upgrade.

## Open questions for Simon
1. **Reader sign-in without `drive.file`?** Today the callback refuses it, so "one tap" really means a Google Drive consent screen too. Proposal: basic scopes now, `drive.file` on the first Starta.
2. **A calendar guest outside the people list:** after the claim, do they get meeting-only read access (new, small), join the förening, or no mail in v1?
3. **Sending in the starter's name:** is the per-meeting toggle plus the notice at Starta enough? And are the caps right (1 per address per förening per 7 days; stop after 3 ignored)?
4. Should a separate sending subdomain for invites (with open tracking) be set up, or should "opened" be dropped and the funnel start at clicked?
5. Upsell line in the reminder too (the owner's "at the bottom")? The draft leaves it out.
