import { useTranslations } from "next-intl";
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
  /** Företag (0050): the user's companies, and "Skapa ett företag" for the allow-list only. */
  companies?: { id: string; name: string; role: "admin" | "member"; logoUrl?: string | null }[];
  createForetag?: FormAction;
}

export function OrgsView({ orgs, notice, createOrg, nameError, companies = [], createForetag }: OrgsViewProps) {
  const t = useTranslations("orgs");
  const tf = useTranslations("foretag.orgs");
  return (
    <div className="mx-auto w-full px-gutter max-w-[40rem] flex flex-col gap-8">
      <PageHeader
        title={t("title")}
        meta={<p className="text-ink-2">{t("intro")}</p>}
      />
      <NoticeBanner notice={notice} />

      {orgs.length === 0 ? (
        <EmptyState title={t("emptyTitle")}>
          <p>{t("emptyText")}</p>
        </EmptyState>
      ) : (
        <Panel flush title={t("yours")} titleId="orgs-title">
          <ul  aria-labelledby="orgs-title">
            {orgs.map((org) => (
              <ListRow
                key={org.id}
                href={`/orgs/${org.id}`}
                leading={<OrgLogo name={org.name} src={org.logoUrl} size="sm" />}
                title={org.name}
                actions={
                  <>
                    {org.role === "admin" && <Badge tone="info">{t("admin")}</Badge>}
                    <IconArrowRight size={18} className="text-ink-3 transition-transform duration-120 ease-out group-hover/row:translate-x-[3px] group-hover/row:text-ink" />
                  </>
                }
              />
            ))}
          </ul>
        </Panel>
      )}

      {companies.length > 0 && (
        <Panel flush title={tf("yours")} titleId="companies-title">
          <ul aria-labelledby="companies-title">
            {companies.map((c) => (
              <ListRow
                key={c.id}
                href={`/orgs/${c.id}`}
                leading={<OrgLogo name={c.name} src={c.logoUrl} size="sm" />}
                title={c.name}
                actions={
                  <>
                    {c.role === "admin" && <Badge tone="info">{t("admin")}</Badge>}
                    <IconArrowRight size={18} className="text-ink-3 transition-transform duration-120 ease-out group-hover/row:translate-x-[3px] group-hover/row:text-ink" />
                  </>
                }
              />
            ))}
          </ul>
        </Panel>
      )}

      <Panel title={t("createTitle")} titleId="create-title">
        <form action={createOrg} className="flex flex-col gap-8">
          <div className="flex items-end gap-2 max-[30rem]:flex-col max-[30rem]:items-stretch">
            <Field
              id="org-name"
              name="name"
              label={t("name")}
              placeholder={t("namePlaceholder")}
              required
              maxLength={100}
              autoComplete="organization"
              error={nameError}
              className="min-w-0 flex-1"
            />
            <SubmitButton variant="primary" icon={<IconPlus />} pendingLabel={t("creating")}>
              {t("create")}
            </SubmitButton>
          </div>
          <p className="text-xs text-ink-3">{t("limit")}</p>
        </form>
      </Panel>

      {createForetag && (
        <Panel title={tf("createTitle")} titleId="create-company-title">
          <form action={createForetag} className="flex flex-col gap-4">
            <p className="max-w-[60ch] text-sm text-ink-2">{tf("createText")}</p>
            <div className="flex items-end gap-2 max-[30rem]:flex-col max-[30rem]:items-stretch">
              <Field id="company-name" name="name" label={tf("name")} placeholder={tf("namePlaceholder")} required maxLength={100} autoComplete="organization" className="min-w-0 flex-1" />
              <SubmitButton variant="secondary" icon={<IconPlus />} pendingLabel={tf("creating")}>
                {tf("create")}
              </SubmitButton>
            </div>
          </form>
        </Panel>
      )}
    </div>
  );
}
