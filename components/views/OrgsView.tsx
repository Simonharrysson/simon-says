import { Badge } from "@/components/ui/badge";
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
import { OrgLogo } from "@/components/onboarding/OrgLogo";

export interface OrgsViewProps {
  orgs: { id: string; name: string; role: "admin" | "member"; logoUrl?: string | null }[];
  notice: Notice | null;
  createOrg: FormAction;
  /** True when the last create failed validation (?fel=invalid), to mark the field. */
  nameError?: string;
}

export function OrgsView({ orgs, notice, createOrg, nameError }: OrgsViewProps) {
  return (
    <div className="mx-auto w-full px-gutter max-w-[40rem] flex flex-col gap-8">
      <PageHeader
        title="Föreningar"
        meta={<p className="text-ink-2">Varje förening har sin egen personlista, sina möten och sin inbjudningslänk.</p>}
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
          <ul  aria-labelledby="orgs-title">
            {orgs.map((org) => (
              <ListRow
                key={org.id}
                href={`/orgs/${org.id}`}
                leading={<OrgLogo name={org.name} src={org.logoUrl} size="sm" />}
                title={org.name}
                actions={
                  <>
                    {org.role === "admin" && <Badge tone="info">Admin</Badge>}
                    <IconArrowRight size={18} className="text-ink-3 transition-transform duration-120 ease-out group-hover/row:translate-x-[3px] group-hover/row:text-ink" />
                  </>
                }
              />
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Skapa en förening" titleId="create-title">
        <form action={createOrg} className="flex flex-col gap-8">
          <div className="flex items-end gap-2 max-[30rem]:flex-col max-[30rem]:items-stretch">
            <Field
              id="org-name"
              name="name"
              label="Namn"
              placeholder="t.ex. LiU AI Society"
              required
              maxLength={100}
              autoComplete="organization"
              error={nameError}
              className="min-w-0 flex-1"
            />
            <SubmitButton variant="primary" icon={<IconPlus />} pendingLabel="Skapar…">
              Skapa
            </SubmitButton>
          </div>
          <p className="text-xs text-ink-3">Du kan skapa högst två föreningar. Att gå med i andras räknas inte.</p>
        </form>
      </Panel>
    </div>
  );
}
