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

export interface ForetagListViewProps {
  companies: { id: string; name: string; role: "admin" | "member" }[];
  notice: Notice | null;
  /** "Skapa ett företag": the allow-list only (lib/foretag/gate.ts). */
  createForetag?: FormAction;
  /** True when the last create failed validation (?fel=invalid), to mark the field. */
  nameError?: string;
}

/** /foretag (0050): the user's companies and, for the allow-list, Skapa ett företag. Föreningar are on /orgs. */
export function ForetagListView({ companies, notice, createForetag, nameError }: ForetagListViewProps) {
  const t = useTranslations("foretag.list");
  return (
    <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-8 px-gutter">
      <PageHeader title={t("title")} meta={<p className="text-ink-2">{t("intro")}</p>} />
      <NoticeBanner notice={notice} />

      {companies.length === 0 ? (
        <EmptyState title={t("emptyTitle")}>
          <p>{t("emptyText")}</p>
        </EmptyState>
      ) : (
        <Panel flush title={t("yours")} titleId="companies-title">
          <ul aria-labelledby="companies-title">
            {companies.map((c) => (
              <ListRow
                key={c.id}
                href={`/orgs/${c.id}`}
                leading={<OrgLogo name={c.name} size="sm" />}
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

      {createForetag && (
        <Panel title={t("createTitle")} titleId="create-company-title">
          <form action={createForetag} className="flex flex-col gap-4">
            <p className="max-w-[60ch] text-sm text-ink-2">{t("createText")}</p>
            <div className="flex items-end gap-2 max-[30rem]:flex-col max-[30rem]:items-stretch">
              <Field
                id="company-name"
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
          </form>
        </Panel>
      )}
    </div>
  );
}
