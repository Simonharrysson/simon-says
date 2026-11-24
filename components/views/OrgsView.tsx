import { Badge } from "@/components/ui/Badge";
import type { FormAction } from "@/components/ui/ConfirmAction";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { IconArrowRight, IconPlus } from "@/components/ui/icons";
import { ListRow } from "@/components/ui/ListRow";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { Notice } from "@/lib/ui/messages";
import { NoticeBanner } from "./NoticeBanner";

export interface OrgsViewProps {
  orgs: { id: string; name: string; role: "admin" | "member" }[];
  notice: Notice | null;
  createOrg: FormAction;
  /** True when the last create failed validation (?fel=invalid), to mark the field. */
  nameError?: string;
}

export function OrgsView({ orgs, notice, createOrg, nameError }: OrgsViewProps) {
  return (
    <div className="page page--narrow stack stack--6">
      <PageHeader
        title="Föreningar"
        meta={<p className="muted">Varje förening har sin egen personlista, sina möten och sin inbjudningslänk.</p>}
      />
      <NoticeBanner notice={notice} />

      {orgs.length === 0 ? (
        <EmptyState title="Du är inte med i någon förening än">
          <p>
            Har någon skickat en inbjudningslänk? Öppna den så hamnar du rätt. Annars skapar du föreningen här
            nedanför — du blir admin och kan bjuda in resten.
          </p>
        </EmptyState>
      ) : (
        <Panel flush title="Dina föreningar" titleId="orgs-title">
          <ul className="list" aria-labelledby="orgs-title">
            {orgs.map((org) => (
              <ListRow
                key={org.id}
                href={`/orgs/${org.id}`}
                leading={<span className="org-initial" aria-hidden="true">{org.name.trim().charAt(0).toUpperCase()}</span>}
                title={org.name}
                actions={
                  <>
                    {org.role === "admin" && <Badge tone="info">Admin</Badge>}
                    <IconArrowRight size={18} className="row__chevron" />
                  </>
                }
              />
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Skapa en förening" titleId="create-title">
        <form action={createOrg} className="stack">
          <div className="inline-form inline-form--stack-sm">
            <Field
              id="org-name"
              name="name"
              label="Namn"
              placeholder="t.ex. LiU AI Society"
              required
              maxLength={100}
              autoComplete="organization"
              error={nameError}
            />
            <SubmitButton variant="primary" icon={<IconPlus />} pendingLabel="Skapar…">
              Skapa
            </SubmitButton>
          </div>
          <p className="hint">Du kan skapa högst två föreningar. Att gå med i andras räknas inte.</p>
        </form>
      </Panel>
    </div>
  );
}
