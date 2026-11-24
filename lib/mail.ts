import "server-only";
import { getEnv } from "@/lib/env";

// Outgoing email behind a small interface. Resend is not configured yet (Task 12 plugs it in):
// until then `send` only logs and reports `false` (not sent); callers record what they tried in
// meeting_events, so nothing is lost.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** True when the message was handed to the mail provider. */
  send(message: MailMessage): Promise<boolean>;
}

export function defaultMailer(): Mailer {
  return {
    async send(message) {
      const configured = Boolean(getEnv().RESEND_API_KEY);
      // Subject only: bodies may quote meeting data.
      console.warn(
        `mail: not sent (${configured ? "sending arrives with Task 12" : "RESEND_API_KEY not set"}): "${message.subject}"`,
      );
      return false;
    },
  };
}
