"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { hintClass } from "@/components/ui/Field";
import { IconChevronDown, IconChevronRight, IconRefresh } from "@/components/ui/icons";
import { controlClass } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";
import { defaultLocale } from "@/lib/i18n/config";
import { translator } from "@/lib/i18n/translator";
import { inviteBody, inviteFooter, inviteSubject, linkLikeName } from "@/lib/invites/email";
import {
  canResend,
  INVITE_LIMITS,
  parseEmails,
  RETRYABLE,
  type InviteResult,
  type InviteRow,
} from "@/lib/invites/rules";
import { cn } from "@/lib/utils";

// "Bjud in via mejl" (0038): an admin types addresses, sees the e-mail, sends, and sees what
// happened per address and every invite sent. Presentational apart from the default `send`
// (the route); the /design gallery passes its own.

export interface AddressOutcome {
  email: string;
  result: InviteResult;
  nextAt?: string;
}

export type SendResponse = { ok: true; results: AddressOutcome[]; invites: InviteRow[] } | { ok: false; message: string };
export type SendInvites = (emails: string[], resend: boolean) => Promise<SendResponse>;

export interface InviteByEmailProps {
  orgId: string;
  orgName: string;
  /** The name the e-mail will say invites (the preview). */
  inviterName: string;
  inviteUrl: string;
  invites: InviteRow[];
  /** Lowercased members' addresses: marked "redan medlem" before sending. */
  memberEmails?: string[];
  /** Pre-filled addresses. */
  initialText?: string;
  /** Addresses offered with one button (the Styrelsen step: people with an e-mail, not invited yet). */
  suggestions?: string[];
  /** Called with the list after every send (the Styrelsen step shows each person's invite). */
  onInvitesChange?: (invites: InviteRow[]) => void;
  /** Opens with the preview shown (the /design gallery). */
  initialPreview?: boolean;
  /** Initial results (the /design gallery). */
  initialResults?: AddressOutcome[];
  send?: SendInvites;
}

/** POST the addresses to the invites route (also a board row's own "Skicka inbjudan"). */
export async function sendInvites(orgId: string, emails: string[], resend: boolean, copy: { failed: string; offline: string }): Promise<SendResponse> {
  try {
    const res = await fetch(`/api/orgs/${orgId}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emails, resend }),
    });
    const body = (await res.json().catch(() => null)) as { results?: AddressOutcome[]; invites?: InviteRow[]; message?: string } | null;
    if (!res.ok || !body?.results) return { ok: false, message: body?.message ?? copy.failed };
    return { ok: true, results: body.results, invites: body.invites ?? [] };
  } catch {
    return { ok: false, message: copy.offline };
  }
}

const tone = (r: InviteResult) => (r === "sent" ? "text-green" : r === "failed" || r === "invalid" ? "text-red" : "text-ink-3");

export function InviteByEmail(p: InviteByEmailProps) {
  const t = useTranslations("invites");
  const locale = useLocale();
  const id = useId();
  const send: SendInvites = p.send ?? ((emails, resend) => sendInvites(p.orgId, emails, resend, { failed: t("sendFailed"), offline: t("offline") }));
  const [text, setText] = useState(p.initialText ?? "");
  const [preview, setPreview] = useState(Boolean(p.initialPreview));
  const [sending, setSending] = useState(false);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [results, setResults] = useState<AddressOutcome[] | null>(p.initialResults ?? null);
  const [invites, setInvites] = useState<InviteRow[]>(p.invites);
  const [seenInvites, setSeenInvites] = useState(p.invites);
  // An invite sent elsewhere (a board row's own button): the list follows.
  if (seenInvites !== p.invites) {
    setSeenInvites(p.invites);
    setInvites(p.invites);
  }
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const members = new Set(p.memberEmails ?? []);
  const parsed = parseEmails(text);
  const already = parsed.valid.filter((e) => members.has(e));
  const toSend = parsed.valid.filter((e) => !members.has(e));
  const tooMany = toSend.length > INVITE_LIMITS.perForm;
  // A förening or inviter name that looks like a link: the server refuses, say so up front (I1).
  const linkName = linkLikeName(p.inviterName, p.orgName);
  const typed = new Set(parsed.valid);
  const offer = (p.suggestions ?? []).filter((e) => !typed.has(e) && !members.has(e));

  async function run(emails: string[], resend: boolean, one?: string) {
    setError(null);
    if (one) setBusyEmail(one);
    else setSending(true);
    // In turns of 10, so each request ends well inside the server's time limit.
    const got: AddressOutcome[] = [];
    let res: SendResponse = { ok: true, results: [], invites };
    for (let i = 0; i < emails.length; i += INVITE_LIMITS.perRequest) {
      if (!one) setProgress({ done: i, total: emails.length });
      res = await send(emails.slice(i, i + INVITE_LIMITS.perRequest), resend);
      if (!res.ok) break;
      got.push(...res.results);
    }
    setSending(false);
    setBusyEmail(null);
    setProgress(null);
    if (!res.ok) {
      setError(res.message);
      if (got.length === 0) return;
      // Earlier turns went out: show them, and keep the rest in the box.
      const tried = new Set(got.map((r) => r.email));
      setResults(got);
      setText(emails.filter((e) => !tried.has(e)).join("\n"));
      return;
    }
    setInvites(res.invites);
    p.onInvitesChange?.(res.invites);
    if (one) {
      // A retry from the results or the list: update that address only.
      const outcome = res.results[0];
      if (outcome) setResults((prev) => (prev?.some((r) => r.email === one) ? prev.map((r) => (r.email === one ? outcome : r)) : [...(prev ?? []), outcome]));
      return;
    }
    setResults([...already.map((email) => ({ email, result: "member" as const })), ...parsed.invalid.map((email) => ({ email, result: "invalid" as const })), ...got.filter((r) => r.result !== "invalid")]);
    // Keep only what may need another go in the box.
    setText(got.filter((r) => RETRYABLE.has(r.result)).map((r) => r.email).join("\n"));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-emails`}>{t("emailsLabel")}</Label>
        <textarea
          id={`${id}-emails`}
          className={cn(controlClass, "min-h-24 py-2 leading-relaxed")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"anna@example.com, bo@example.com"}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-hint`}
          aria-invalid={parsed.invalid.length > 0 || tooMany ? true : undefined}
        />
        <p id={`${id}-hint`} className={hintClass} aria-live="polite">
          {text.trim() === "" ? (
            t("hint")
          ) : (
            <>
              {t("addresses", { count: toSend.length })}
              {already.length > 0 && t("alreadyMembers", { count: already.length })}
              {parsed.invalid.length > 0 && <span className="text-red">{t("notEmail", { list: parsed.invalid.join(", ") })}</span>}
              {tooMany && <span className="text-red">{t("tooMany", { max: INVITE_LIMITS.perForm })}</span>}
            </>
          )}
        </p>
      </div>

      {offer.length > 0 && (
        <div>
          <Button size="sm" variant="secondary" onClick={() => setText((t) => [t.trim(), ...offer].filter(Boolean).join("\n"))}>
            {t("addFromList", { count: offer.length })}
          </Button>
        </div>
      )}

      {linkName && <Banner tone="warning">{t(`linkName.${linkName}`)}</Banner>}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" loading={sending} disabled={toSend.length === 0 || tooMany || busyEmail !== null || linkName !== null} onClick={() => run(toSend, false)}>
          {sending
            ? progress && progress.total > INVITE_LIMITS.perRequest
              ? t("sendingRange", { from: progress.done + 1, to: Math.min(progress.done + INVITE_LIMITS.perRequest, progress.total), total: progress.total })
              : t("sending")
            : toSend.length > 0
              ? t("sendCount", { count: toSend.length })
              : t("sendOne")}
        </Button>
        <Button variant="ghost" icon={preview ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />} aria-expanded={preview} aria-controls={`${id}-preview`} onClick={() => setPreview(!preview)}>
          {preview ? t("hideEmail") : t("showEmail")}
        </Button>
      </div>

      {preview && <EmailPreview id={`${id}-preview`} orgName={p.orgName} inviterName={p.inviterName} inviteUrl={p.inviteUrl} />}

      {error && <Banner tone="danger">{error}</Banner>}

      {results && results.length > 0 && (
        <ul className="flex flex-col rounded-md border border-line" aria-label={t("results")}>
          {results.map((r) => (
            <li key={r.email} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-sm first:border-t-0">
              <span className="min-w-0 flex-1 wrap-anywhere">{r.email}</span>
              <span className={cn("flex-none", tone(r.result))}>
                {t(`result.${r.result}`)}
                {r.result === "resend_limit" && r.nextAt && t("againAt", { date: formatDateTime(r.nextAt, locale) })}
              </span>
              {RETRYABLE.has(r.result) && (
                <Button size="sm" variant="secondary" icon={<IconRefresh size={14} />} loading={busyEmail === r.email} disabled={sending} onClick={() => run([r.email], true, r.email)}>
                  {t("tryAgain")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {invites.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium" id={`${id}-sent`}>
            {t("sentInvites")}
          </span>
          <ul className="flex flex-col rounded-md border border-line" aria-labelledby={`${id}-sent`}>
            {invites.map((inv) => (
              <InviteListRow key={inv.email} invite={inv} busy={busyEmail === inv.email} disabled={sending || (busyEmail !== null && busyEmail !== inv.email)} onResend={() => run([inv.email], true, inv.email)} />
            ))}
          </ul>
          <p className={hintClass}>{t("resendRule")}</p>
        </div>
      )}
    </div>
  );
}

function InviteListRow({ invite: inv, busy, disabled, onResend }: { invite: InviteRow; busy: boolean; disabled: boolean; onResend: () => void }) {
  const when = inv.status === "accepted" && inv.acceptedAt ? inv.acceptedAt : inv.lastSentAt;
  const t = useTranslations("invites");
  const locale = useLocale();
  const resendable = canResend(inv);
  return (
    <li className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-sm first:border-t-0">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="wrap-anywhere">{inv.email}</span>
        <span className={cn("text-xs", inv.status === "accepted" ? "text-green" : inv.status === "failed" ? "text-red" : "text-ink-3")}>
          {t(`status.${inv.status}`)}
          {when && ` · ${formatDateTime(when, locale)}`}
        </span>
      </span>
      {inv.status !== "accepted" &&
        (resendable ? (
          <Button size="sm" variant="secondary" icon={<IconRefresh size={14} />} loading={busy} disabled={disabled} onClick={onResend}>
            {inv.status === "sent" ? t("resend") : t("tryAgain")}
          </Button>
        ) : (
          inv.nextResendAt && <span className="text-xs text-ink-3">{t("againShort", { date: formatDateTime(inv.nextResendAt, locale) })}</span>
        ))}
    </li>
  );
}

/** The preview shows the mail most invitees get: in Swedish (the default for an unknown address). */
const MAIL_LOCALE = defaultLocale;

/** The e-mail as the invitee sees it (design A), drawn with React: every value is text, never HTML. */
export function EmailPreview({ id, orgName, inviterName, inviteUrl }: { id?: string; orgName: string; inviterName: string; inviteUrl: string }) {
  const t = useTranslations("invites");
  const locale = useLocale();
  // The mail itself is in the recipient's language: Swedish unless their account chose English.
  const mail = translator(MAIL_LOCALE);
  return (
    <figure id={id} className="m-0 flex flex-col gap-2" aria-label={t("previewLabel")}>
      <figcaption className="flex flex-col text-xs text-ink-3">
        <span>
          <span className="font-medium text-ink-2">{t("subject")}</span> {inviteSubject(inviterName, orgName, MAIL_LOCALE)}
        </span>
        <span>{t("from")}</span>
        {locale !== MAIL_LOCALE && <span>{t("previewLanguage")}</span>}
      </figcaption>
      <div className="rounded-md bg-[#fafafa] p-4 text-[#171717] max-md:p-2">
        <div className="mb-3 px-1 font-serif text-xl">Simon Says</div>
        <div className="rounded-lg border border-[#ebebeb] bg-white p-6 max-md:p-4">
          <p className="m-0 mb-3 text-xl font-semibold tracking-tight wrap-anywhere" lang={MAIL_LOCALE}>
            {mail("emails.invite.heading", { org: orgName })}
          </p>
          <p className="m-0 mb-5 text-sm leading-relaxed text-[#4d4d4d]" lang={MAIL_LOCALE}>
            {inviteBody(inviterName, MAIL_LOCALE)}
          </p>
          <span className="inline-block rounded-md bg-[#171717] px-4 py-2.5 text-sm font-medium text-white" lang={MAIL_LOCALE}>
            {mail("emails.invite.button", { org: orgName })}
          </span>
          <p className="m-0 mt-4 text-xs text-[#666]" lang={MAIL_LOCALE}>
            {mail("emails.invite.fallback")}
            <br />
            <span className="font-mono break-all text-[#0068d6]">{inviteUrl.replace(/^https?:\/\//, "")}</span>
          </p>
        </div>
        <p className="m-0 mt-3 px-1 text-xs leading-relaxed text-[#666]" lang={MAIL_LOCALE}>
          {inviteFooter(inviterName, orgName, MAIL_LOCALE)}
        </p>
      </div>
    </figure>
  );
}
