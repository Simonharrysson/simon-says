import type { ReactNode } from "react";
import { Panel } from "@/components/ui/Panel";
import { SummarySettingsForm, type SummaryPersonOption } from "@/components/views/SummarySettingsForm";
import { UnsubscribeView } from "@/components/views/UnsubscribeView";
import { renderSummaryEmail } from "@/lib/summaries/email";
import { demoSummaryEmails } from "@/emails/summary/demo";

// The summary e-mail's states for the /design gallery (0037): the setting, the e-mail itself (in
// an iframe, as a mail client shows it; dark mode follows the system) and the unsubscribe page.

const noopAction = async () => {};
const ORG_ID = "00000000-0000-4000-8000-0000000000aa";

const options: SummaryPersonOption[] = [
  { id: "p1", name: "Anna Berg", role: "Ordförande", hasEmail: true, selected: true, unsubscribed: false },
  { id: "p2", name: "Erik Lund", role: "Kassör", hasEmail: true, selected: true, unsubscribed: false },
  { id: "p5", name: "Johan Ek", role: null, hasEmail: false, selected: false, unsubscribed: false },
  { id: "p3", name: "Sara Nyström", role: "Sekreterare", hasEmail: true, selected: false, unsubscribed: true },
  { id: "p4", name: "Simon", role: null, hasEmail: true, selected: false, unsubscribed: false },
];

/** The setting alone, as Inställningar shows it (also used in the gallery's "org-admin"). */
export function SummarySettingsDemo({ mode = "missed" }: { mode?: "missed" | "selected" }) {
  return <SummarySettingsForm orgId={ORG_ID} mode={mode} people={options} action={noopAction} />;
}

function Settings({ mode }: { mode: "missed" | "selected" }) {
  return (
    <div className="mx-auto w-full max-w-page px-gutter py-8">
      <Panel title="Inställningar" titleId={`summary-${mode}`}>
        <SummarySettingsDemo mode={mode} />
      </Panel>
    </div>
  );
}

function Email({ which }: { which: keyof typeof demoSummaryEmails }) {
  const mail = renderSummaryEmail(demoSummaryEmails[which]);
  return (
    <div className="flex flex-col gap-3 p-6">
      <p className="text-sm text-ink-2">
        <span className="font-medium text-ink">Ämne:</span> {mail.subject} <span className="text-ink-3">· {mail.preview}</span>
      </p>
      <iframe title={mail.subject} srcDoc={mail.html} className="h-[56rem] w-full rounded-md border-0 bg-board" />
    </div>
  );
}

export const summaryRender: Record<string, () => ReactNode> = {
  "org-summary-missed": () => <Settings mode="missed" />,
  "org-summary-selected": () => <Settings mode="selected" />,
  "summary-email": () => <Email which="missed" />,
  "summary-email-admin": () => <Email which="admin" />,
  "summary-email-short": () => <Email which="short" />,
  "unsubscribe-confirm": () => <UnsubscribeView state="confirm" token="demo" orgName="Exempelföreningen" unsubscribe={noopAction} />,
  "unsubscribe-done": () => <UnsubscribeView state="done" orgName="Exempelföreningen" />,
  "unsubscribe-invalid": () => <UnsubscribeView state="invalid" />,
};
