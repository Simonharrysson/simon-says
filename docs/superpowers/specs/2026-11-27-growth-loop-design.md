# Growth loop — design (draft for Simon, 2026-11-27; no product code yet)

Simon 2026-11-27 (binding, marked **[Simon]**): copy tl;dv's mechanism, not its look. After a meeting, each attendee **without an account** gets an e-mail with a real text teaser and one button into the app. Attendees **with an account** get our normal mail as today (the summary, or "Du missade mötet") and never this one. Mock with fictional data: `~/simon-says-private/growth-loop/`. It has the invite and the reminder, in light and dark, at desktop and phone widths. `build.mjs` builds it on the shell of the real summary renderer, lib/summaries/email.ts.

## The mail
- **Subject:** `Johanna bjöd in dig till "Styrelsemöte november"`. Johanna is the first name of the person who started the meeting. The title is the calendar title, else "Mötet 24 november". **[Simon]**
- **Preheader:** "Du har 2 uppgifter från mötet" or "Du nämndes i mötet" **[Simon]**. A calendar guest who was never named gets "4 beslut och 6 uppgifter från mötet" instead, so the preheader never claims a mention that didn't happen. (mine)
- **Body:** design A, in this order:
  - the eyebrow "Johanna Linds anteckningar · förening", the title, one lead line, and a chip "4 beslut · 6 uppgifter";
  - **Dina uppgifter** in full, with Vem, När and Klart när;
  - the first 2 decisions in stepped greys, ending in "…och N beslut till";
  - the button **Läs allt och bocka av** **[Simon]**.
  - The fade is stepped text colours, so it survives Outlook, Gmail and dark mode. There is no image.
- **Footer:** a reason line that is true for this recipient ("…du stod på mötets gästlista" or "…du var med på mötet"), plus List-Unsubscribe and "Avsluta prenumeration". Under a rule sits one line: "Gratis för din förening – starta ett eget möte" **[Simon]**.
- **Sender and language:** the mail has a plain-text part and goes in the recipient's language (`localeForEmail`, Swedish by default). From is `Johanna via Simon Says` (mine) on the sending domain chosen under Tracking.

## Flow
1. The trigger is the same as for summaries: `finishMeeting` plus the 5-minute cron. `sendMeetingSummaries` is extended to compute **both lists once** before anything is sent. The invite list comes first; the summary list is then reduced by the invite addresses.
2. Each invite gets a `meeting_invites` row (unique per meeting and address) **before** the mailer is called, with a Resend Idempotency-Key. This copies the summary and invite ledgers (0037, 0038), so a resumed or second run never mails anyone twice.
3. A separate cron step sends the reminder (see Reminder).

## Recipients (pure `inviteRecipients()`, next to `summaryRecipients()`)
- **Candidates** **[Simon]:**
  - calendar guests of the linked event who did not decline;
  - people the name round identified (`speaker_map` → person, not `needs_confirm`) who have an e-mail in the people list.
- **Has an account:** a confirmed `auth.users` address equal to the candidate's, or a linked people row (`member_user_id`). These candidates drop out here and stay in today's flow.
- **Dedupe:** by trimmed, lowercased address. A guest who matches a people row is one person. Each address gets one mail per meeting across both ledgers.
  - Summary mode `all`, and ticked people in `selected`: a no-account attendee gets the invite *instead of* the summary.
  - An unticked attendee in `selected` gets the invite only.
  - Absentees are unchanged **[Simon]**. In `missed` the lists can't overlap, because nobody expected or present counts as missed.
- **Per-förening settings** **[Simon]:**
  - `summary_mode = off` means no invites either.
  - A new switch, **Skicka anteckningar till deltagare utan konto**, defaults to on. It sits under Inställningar → Sammanfattning efter mötet.
  - The starter gets a per-meeting toggle at Starta, next to the notice "Deltagare utan konto får sina uppgifter via mejl från dig".
- **People without an e-mail** get nothing. Their count goes in the `invites` event.
- **Someone whose account uses another address** gets the invite at the listed address and can link at the landing (below).
- **Never sent:**
  - to the starter;
  - for `is_test` meetings, Privat spaces or `no_notes` meetings;
  - when the gate says no: the new category `meeting_invite` (`email_categories()` migration), "Inga mejl alls", or a per-address choice, which 0039 already supports without an account;
  - to bounced or complained addresses.
- **Caps (mine):**
  - at most 25 invites per meeting;
  - at most 1 per address per förening per 7 days;
  - after 3 unclicked invites in a row from one förening, a 90-day pause for that address.
- **Företag** (on `origin/foretag`'s 0050): no sends in v1 (DPA gate). Later rules:
  - people rows inside the company only, never external guests or customers;
  - only when `can_see_meeting` would be true once the row is linked;
  - never a `private` meeting **[Simon]**, and never a task held in `task_handoffs`.

## Landing after the click
- **Link:** `/r/<token>`. The token is 128 random bits, stored as a SHA-256 hash, and expires after 30 days.
- **GET only logs and redirects.** Mail scanners prefetch links, so a GET never claims.
  - The public, noindex page `/in/<token>` fires a JS beacon that sets `clicked_human_at`.
  - The page shows only what the mail showed, plus **Fortsätt med Google**.
- **Sign-in:** `/login?next=/in/<token>/klar`.
  - **Blocker:** `auth/callback` signs out anyone who did not grant `drive.file`, so today a reader also sees the Drive consent screen.
  - **Proposal:** the callback accepts basic scopes when `next` is a claim path. `drive.file` is then asked as incremental consent (the `atkomst=` pattern) on the reader's first Starta.
- **Claim** at `/in/<token>/klar`, reached through the OAuth return with a fresh session (under 2 minutes old; otherwise a button):
  - **The Google address equals the invited one.** Claim the token (single-claim), link the people row (as `link_person_by_email`), join as a member (as `join_org`), then go to `/orgs/<org>/mote/<meeting>?fran=inbjudan` at Dina uppgifter.
    - This joins as a side effect of sign-in. That is a **deliberate exception** to `/join`'s "joining is a POST", for Simon's one tap. It is safe because the OAuth code can't be prefetched and the address is proven.
  - **Another address** (an account under another e-mail, or a forwarded mail). The page says "Mejlet gick till o•••@exempel.se", and **Skicka en länk dit** sends a 15-minute one-time link to the invited inbox. Opening that link while signed in links the row. Otherwise: "Be Johanna lägga till dig".
  - **Claimed by someone else:** "Inbjudan är redan använd", with no content.
  - **Expired:** a plain sign-in. A matching address still links through the existing join path.
- **Forwarding:** the token never grants access. It only carries attribution and the route. Access needs a Google-confirmed address equal to the invited one, or proof of that inbox.
- **A calendar-only guest** (no people row): see open question 2. The default proposal is a new people row plus **meeting-only read access** (`meeting_readers`), with "Gå med i föreningen" left for an admin to approve.

## Reminder (one, only if not clicked, never more) **[Simon]**
- **Picked up by** a cron step with its own query, because the summary sweep stops at 48 h. It takes rows where:
  - `sent_at` is at least 48 h ago and less than 96 h ago (anything older is skipped, never sent late);
  - there is no human click, no claim and no reminder yet.
- **Checked again before sending:** still no account, the gate, the setting, the meeting still exists.
- **Sending:** only between 08 and 20 Stockholm time. Ledger first, then the send, with the key `inv-<id>-r`.
- **Content:**
  - subject `(Påminnelse) Johanna bjöd in dig till "…"`;
  - the tasks and the button only, with "Det här är den enda påminnelsen";
  - no upsell line (mine).

## Tracking: sent → opened → clicked → signed up → back within 7 days **[Simon]**
| Step | Source |
|---|---|
| sent | our ledger, when Resend accepted the mail |
| delivered / bounced / complained | Resend webhook (Svix-signed) at `/api/resend/webhook`. A bounce suppresses the address; a complaint turns `meeting_invite` off for it. |
| opened | Resend `email.opened`, shown as "≥ X". It is unreliable: Apple's privacy protection fakes opens and many clients block pixels. Resend tracks per domain, so turn it on **only** on an invite subdomain (e.g. `mote.harrysson.co`), never for summaries. Resend's click tracking stays off. |
| clicked | our own redirect plus the beacon (`clicked_human_at`). Raw GETs are kept to measure scanner noise. |
| signed up | the claim; `claim_kind` is new_account, existing_account or verified_other_email |
| came back | `returned_at`: the first signed-in page view between 12 h and 7 days after the claim, set from the (app) layout |

The view `meeting_invite_funnel` counts per meeting and per förening. In v1 only the operator sees it. Logs hold counts only.

## Privacy and marketing law (notes for review, not conclusions)
- **Primarily informational** **[Simon]:** the mail carries the recipient's own tasks from a meeting they were part of. The upsell is one footer line and is absent from the reminder.
- **Marknadsföringslagen** (2008:486, §19, unsolicited e-mail) and its rules on misleading practices: the risk is "bjöd in dig" going out in the starter's name without the starter acting. The notice and toggle at Starta are the mitigation. Have this reviewed.
- **GDPR roles:** the förening controls its meeting content. The upsell is Harrysson & Company's own purpose, so it needs a legitimate-interest assessment and new /integritet lines covering guest addresses, click and open tracking, and retention.
- **What is stored:** the mail carries only the recipient's own tasks, 2 decisions and counts. Guest addresses live in a server-only table, never in `meetings`, which members can read. An unclaimed invite's address and name are nulled after 90 days.

## Data model sketch (no migration yet)
```
meeting_invites  id, meeting_id → meetings cascade, org_id, person_id → people null (null = calendar-only guest),
                 email (lower), name, source ('calendar'|'name_round'|'both'), token_hash unique, expires_at,
                 status ('sending'|'sent'|'failed'|'uncertain'|'skipped'), skip_reason, idem_key, sent_at,
                 delivered_at, bounced_at, complained_at, opened_at, clicked_at, clicked_human_at,
                 reminder_status, reminder_at, claimed_at, claimed_by → auth.users, claim_kind, returned_at
                 unique (meeting_id, email); service role only
meeting_calendar_guests  meeting_id, email, name, response   -- unmatched guests, written at start, deleted 30 d after end
orgs      + invite_attendees boolean default true (Företag false)
meetings  + invite_attendees boolean default true (the starter's toggle)
email_categories() + 'meeting_invite'
meeting_readers  meeting_id, user_id   -- only if open question 2 lands there
```
Code goes in `lib/growth/{recipients,email,send,claim}.ts`, `app/r/[token]`, `app/in/[token]` and `app/api/resend/webhook`. The renderer mirrors `lib/summaries/email.ts`: pure, escaped, with `emails.invite.*` keys.

## Out of v1
- Företag sends.
- Privat.
- A second reminder.
- Rewards and A/B tests.
- A funnel UI for admins.
- An "inget mejl" prompt.
- SMS.
- Open pixels on the main domain.

## Open questions
1. **Reader sign-in without `drive.file`?** Without it, one tap is really a Drive consent screen as well.
2. **Calendar guests outside the people list:** meeting-only read access, membership, or no mail in v1?
3. **Sending in the starter's name:** are the notice and toggle at Starta enough? And are the caps right?
4. Should the invite subdomain with open tracking be set up, or should "opened" be dropped?
5. Should the upsell line also go in the reminder?
