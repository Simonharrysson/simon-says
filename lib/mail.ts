import "server-only";
import { getEnv } from "@/lib/env";

// Outgoing email behind a small interface. With RESEND_API_KEY set it sends through Resend's
// HTTP API; without it, it only logs (subject, never the body or the key) and reports `false`.
// Callers record what they tried (meeting_events), so nothing is lost.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Extra headers, e.g. List-Unsubscribe (lib/email/token.ts listUnsubscribeHeaders). */
  headers?: Record<string, string>;
}

export interface Mailer {
  /** True when the message was handed to the mail provider. */
  send(message: MailMessage): Promise<boolean>;
}

export const DEFAULT_MAIL_FROM = "Simon Says <noreply@harrysson.co>";

export function resendMailer(apiKey: string, from: string, fetchFn: typeof fetch = fetch): Mailer {
  return {
    async send(message) {
      try {
        const res = await fetchFn("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.headers ? { headers: message.headers } : {}),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          console.error(`mail: Resend answered ${res.status} for "${message.subject}"`);
          return false;
        }
        return true;
      } catch (e) {
        console.error(`mail: send failed for "${message.subject}": ${(e as Error).name}`);
        return false;
      }
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
