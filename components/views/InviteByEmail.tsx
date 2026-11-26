"use client";

import { useId, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { hintClass } from "@/components/ui/Field";
import { IconChevronDown, IconChevronRight, IconRefresh } from "@/components/ui/icons";
import { controlClass } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime, plural } from "@/lib/format";
import { inviteBody, inviteFooter, inviteSubject } from "@/lib/invites/email";
import {
  canResend,
  INVITE_LIMITS,
  parseEmails,
  RESULT_LABEL,
  RETRYABLE,
  STATUS_LABEL,
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

async function postInvites(orgId: string, emails: string[], resend: boolean): Promise<SendResponse> {
  try {
    const res = await fetch(`/api/orgs/${orgId}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emails, resend }),
    });
    const body = (await res.json().catch(() => null)) as { results?: AddressOutcome[]; invites?: InviteRow[]; message?: string } | null;
    if (!res.ok || !body?.results) return { ok: false, message: body?.message ?? "Inbjudningarna kunde inte skickas. Försök igen." };
    return { ok: true, results: body.results, invites: body.invites ?? [] };
  } catch {
    return { ok: false, message: "Ingen kontakt med servern. Kontrollera nätet och försök igen." };
  }
}

const tone = (r: InviteResult) => (r === "sent" ? "text-green" : r === "failed" || r === "invalid" ? "text-red" : "text-ink-3");

export function InviteByEmail(p: InviteByEmailProps) {
  const id = useId();
  const send: SendInvites = p.send ?? ((emails, resend) => postInvites(p.orgId, emails, resend));
  const [text, setText] = useState(p.initialText ?? "");
  const [preview, setPreview] = useState(Boolean(p.initialPreview));
  const [sending, setSending] = useState(false);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [results, setResults] = useState<AddressOutcome[] | null>(p.initialResults ?? null);
  const [invites, setInvites] = useState<InviteRow[]>(p.invites);
  const [error, setError] = useState<string | null>(null);

  const members = new Set(p.memberEmails ?? []);
  const parsed = parseEmails(text);
  const already = parsed.valid.filter((e) => members.has(e));
  const toSend = parsed.valid.filter((e) => !members.has(e));
  const tooMany = toSend.length > INVITE_LIMITS.perRequest;
  const typed = new Set(parsed.valid);
  const offer = (p.suggestions ?? []).filter((e) => !typed.has(e) && !members.has(e));

  async function run(emails: string[], resend: boolean, one?: string) {
    setError(null);
    if (one) setBusyEmail(one);
    else setSending(true);
    const res = await send(emails, resend);
    setSending(false);
    setBusyEmail(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setInvites(res.invites);
    p.onInvitesChange?.(res.invites);
    if (one) {
      // A retry from the results or the list: update that address only.
      setResults((prev) => (prev ? prev.map((r) => (r.email === one ? (res.results[0] ?? r) : r)) : res.results));
      return;
    }
    setResults([...already.map((email) => ({ email, result: "member" as const })), ...parsed.invalid.map((email) => ({ email, result: "invalid" as const })), ...res.results.filter((r) => r.result !== "invalid")]);
    // Keep only what may need another go in the box.
    setText(res.results.filter((r) => RETRYABLE.has(r.result)).map((r) => r.email).join("\n"));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-emails`}>E-postadresser</Label>
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
            "En eller flera, med komma eller ny rad emellan. Vi skickar ett mejl med föreningens länk."
          ) : (
            <>
              {plural(toSend.length, "adress", "adresser")}
              {already.length > 0 && ` · ${plural(already.length, "är redan medlem", "är redan medlemmar")}`}
              {parsed.invalid.length > 0 && <span className="text-red"> · inte e-post: {parsed.invalid.join(", ")}</span>}
              {tooMany && <span className="text-red"> · högst {INVITE_LIMITS.perRequest} åt gången</span>}
            </>
          )}
        </p>
      </div>

      {offer.length > 0 && (
        <div>
          <Button size="sm" variant="secondary" onClick={() => setText((t) => [t.trim(), ...offer].filter(Boolean).join("\n"))}>
            {`Lägg till ${plural(offer.length, "adress", "adresser")} från listan`}
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" loading={sending} disabled={toSend.length === 0 || tooMany || busyEmail !== null} onClick={() => run(toSend, false)}>
          {sending ? "Skickar…" : toSend.length > 0 ? `Skicka ${plural(toSend.length, "inbjudan", "inbjudningar")}` : "Skicka inbjudan"}
        </Button>
        <Button variant="ghost" icon={preview ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />} aria-expanded={preview} aria-controls={`${id}-preview`} onClick={() => setPreview(!preview)}>
          {preview ? "Dölj mejlet" : "Visa mejlet"}
        </Button>
      </div>

      {preview && <EmailPreview id={`${id}-preview`} orgName={p.orgName} inviterName={p.inviterName} inviteUrl={p.inviteUrl} />}

      {error && <Banner tone="danger">{error}</Banner>}

      {results && results.length > 0 && (
        <ul className="flex flex-col rounded-md border border-line" aria-label="Resultat">
          {results.map((r) => (
            <li key={r.email} className="flex min-h-11 items-center gap-3 border-t border-line px-3 py-2 text-sm first:border-t-0">
              <span className="min-w-0 flex-1 wrap-anywhere">{r.email}</span>
              <span className={cn("flex-none", tone(r.result))}>
                {RESULT_LABEL[r.result]}
                {r.result === "resend_limit" && r.nextAt && ` · igen ${formatDateTime(r.nextAt)}`}
              </span>
              {RETRYABLE.has(r.result) && (
                <Button size="sm" variant="secondary" icon={<IconRefresh size={14} />} loading={busyEmail === r.email} disabled={sending} onClick={() => run([r.email], true, r.email)}>
                  Försök igen
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {invites.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium" id={`${id}-sent`}>
            Skickade inbjudningar
          </span>
          <ul className="flex flex-col rounded-md border border-line" aria-labelledby={`${id}-sent`}>
            {invites.map((inv) => (
              <InviteListRow key={inv.email} invite={inv} busy={busyEmail === inv.email} disabled={sending || (busyEmail !== null && busyEmail !== inv.email)} onResend={() => run([inv.email], true, inv.email)} />
            ))}
          </ul>
          <p className={hintClass}>”Skicka igen” går en gång per dygn och adress.</p>
        </div>
      )}
    </div>
  );
}

function InviteListRow({ invite: inv, busy, disabled, onResend }: { invite: InviteRow; busy: boolean; disabled: boolean; onResend: () => void }) {
  const when = inv.status === "accepted" && inv.acceptedAt ? inv.acceptedAt : inv.lastSentAt;
  const resendable = canResend(inv);
  return (
    <li className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-sm first:border-t-0">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="wrap-anywhere">{inv.email}</span>
        <span className={cn("text-xs", inv.status === "accepted" ? "text-green" : inv.status === "failed" ? "text-red" : "text-ink-3")}>
          {STATUS_LABEL[inv.status]}
          {when && ` · ${formatDateTime(when)}`}
        </span>
      </span>
      {inv.status !== "accepted" &&
        (resendable ? (
          <Button size="sm" variant="secondary" icon={<IconRefresh size={14} />} loading={busy} disabled={disabled} onClick={onResend}>
            {inv.status === "failed" ? "Försök igen" : "Skicka igen"}
          </Button>
        ) : (
          inv.nextResendAt && <span className="text-xs text-ink-3">Igen {formatDateTime(inv.nextResendAt)}</span>
        ))}
    </li>
  );
}

/** The e-mail as the invitee sees it (design A), drawn with React: every value is text, never HTML. */
export function EmailPreview({ id, orgName, inviterName, inviteUrl }: { id?: string; orgName: string; inviterName: string; inviteUrl: string }) {
  return (
    <figure id={id} className="m-0 flex flex-col gap-2" aria-label="Förhandsvisning av mejlet">
      <figcaption className="flex flex-col text-xs text-ink-3">
        <span>
          <span className="font-medium text-ink-2">Ämne:</span> {inviteSubject(inviterName, orgName)}
        </span>
        <span>Från Simon Says · svar går till dig</span>
      </figcaption>
      <div className="rounded-md bg-[#fafafa] p-4 text-[#171717] max-md:p-2">
        <div className="mb-3 px-1 font-serif text-xl">Simon Says</div>
        <div className="rounded-lg border border-[#ebebeb] bg-white p-6 max-md:p-4">
          <p className="m-0 mb-3 text-2xl font-semibold tracking-tight">Gå med i {orgName}</p>
          <p className="m-0 mb-5 text-sm leading-relaxed text-[#4d4d4d]">{inviteBody(inviterName)}</p>
          <span className="inline-block rounded-md bg-[#171717] px-4 py-2.5 text-sm font-medium text-white">Gå med i {orgName}</span>
          <p className="m-0 mt-4 text-xs text-[#666]">
            Fungerar inte knappen? Öppna länken:
            <br />
            <span className="font-mono break-all text-[#0068d6]">{inviteUrl.replace(/^https?:\/\//, "")}</span>
          </p>
        </div>
        <p className="m-0 mt-3 px-1 text-xs leading-relaxed text-[#666]">{inviteFooter(inviterName, orgName)}</p>
      </div>
    </figure>
  );
}
