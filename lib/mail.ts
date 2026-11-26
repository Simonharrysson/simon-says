import "server-only";
import { getEnv } from "@/lib/env";

// Outgoing email behind a small interface. With RESEND_API_KEY set it sends through Resend's
// HTTP API; without it, it only logs (subject, never the body or the key) and reports `false`.
// Callers record what they tried (meeting_events), so nothing is lost.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML part (the text part stays the fallback). */
  html?: string;
  /** Optional Reply-To, e.g. the person who sent an invite. */
  replyTo?: string;
  /** Optional Resend Idempotency-Key: a retry with the same key is never delivered twice (24 h). */
  idempotencyKey?: string;
}

/** sent: the provider took it · failed: it did not · uncertain: no answer (timeout, 5xx), may have gone out. */
export type MailOutcome = "sent" | "failed" | "uncertain";

export interface Mailer {
  /** True when the message was handed to the mail provider. */
  send(message: MailMessage): Promise<boolean>;
  /** Optional: the same, telling a refusal from no answer. */
  sendWithOutcome?(message: MailMessage): Promise<MailOutcome>;
}

export const DEFAULT_MAIL_FROM = "Simon Says <noreply@harrysson.co>";

export function resendMailer(apiKey: string, from: string, fetchFn: typeof fetch = fetch): Mailer {
  async function sendWithOutcome(message: MailMessage): Promise<MailOutcome> {
    try {
      const res = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...(message.idempotencyKey ? { "idempotency-key": message.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.error(`mail: Resend answered ${res.status} for "${message.subject}"`);
        return res.status >= 500 ? "uncertain" : "failed";
      }
      return "sent";
    } catch (e) {
      console.error(`mail: send failed for "${message.subject}": ${(e as Error).name}`);
      // A timeout or a dropped connection: Resend may have taken it.
      return "uncertain";
    }
  }
  return {
    sendWithOutcome,
    async send(message) {
      return (await sendWithOutcome(message)) === "sent";
    },
  };
}

export function defaultMailer(): Mailer {
  const env = getEnv();
  if (env.RESEND_API_KEY) return resendMailer(env.RESEND_API_KEY, env.MAIL_FROM ?? DEFAULT_MAIL_FROM);
  return {
    async send(message) {
      console.warn(`mail: not sent (RESEND_API_KEY not set): "${message.subject}"`);
      return false;
    },
  };
}
