import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { ConfirmAction } from "@/components/ui/ConfirmAction";
import { IconTrash } from "@/components/ui/icons";
import { Panel } from "@/components/ui/Panel";
import type { OrgDetailViewProps } from "@/components/views/OrgDetailView";
import { OrgFlag, OrgFlagsProvider } from "./OrgFlags";
import { SettingsSections } from "./SettingsSections";

/**
 * The förening page's Inställningar tab (admins): every setting of the förening, each in exactly
 * one section. Kom igång renders the same editors (OrgDetailsForm's fields, OrgBoard,
 * MeetingFolderSetting, FormatCard, VoicesSetting) and links here once a step is done.
 */
export function OrgSettings(props: OrgDetailViewProps & { memberControls: Record<string, ReactNode>; rotateInvite: ReactNode }) {
  const { org, actions, boardList, memberControls, rotateInvite, detailsSettings, formatCard, folderSettings, calendarSettings, voiceSettings, summarySettings } = props;
  const t = useTranslations("org");
  const tasks = useTranslations("tasks.settings");
  const s = useTranslations("org.settings");

  return (
    <OrgFlagsProvider org={org} updateOrg={actions.updateOrg}>
      <SettingsSections
        initial={props.settingsSection ?? "foreningen"}
        sections={{
          foreningen: (
            <>
              {detailsSettings && (
                <Panel title={s("detailsTitle")} titleId="details-title">
                  {detailsSettings}
                </Panel>
              )}
              <Panel title={s("visibilityTitle")} titleId="visibility-title">
                <OrgFlag name="show_on_status" id="settings-status" title={t("showOnStatus")}>
                  {t("showOnStatusText")}
                </OrgFlag>
              </Panel>
            </>
          ),
          styrelsen: (
            <Panel sunk title={t("boardTitle")} titleId="board-title">
              <p className="-mt-2 mb-4 max-w-[68ch] text-sm text-ink-3">{t("boardText")}</p>
              {boardList?.(memberControls, rotateInvite)}
            </Panel>
          ),
          moten: (
            <>
              {formatCard}
              {folderSettings && (
                <Panel title={s("folderTitle")} titleId="folder-title">
                  {folderSettings}
                </Panel>
              )}
              {calendarSettings && <Panel>{calendarSettings}</Panel>}
              <Panel title={s("duringTitle")} titleId="during-title">
                <div className="flex max-w-[44rem] flex-col gap-5">
                  <OrgFlag name="share_transcript" id="settings-share" title={t("shareTranscript")}>
                    {t("shareTranscriptText")}
                  </OrgFlag>
                  <OrgFlag name="require_task_fields" id="settings-tasks" title={tasks("label")}>
                    {tasks("hint")}
                  </OrgFlag>
                </div>
              </Panel>
              {voiceSettings && (
                <Panel title={s("voicesTitle")} titleId="voices-title">
                  {voiceSettings}
                </Panel>
              )}
            </>
          ),
          "efter-motet": summarySettings ? <Panel>{summarySettings}</Panel> : null,
          radera: (
            <Panel title={t("deleteOrgTitle")} titleId="danger-title" className="shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_40%,var(--line))]">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <p className="max-w-[68ch] text-sm text-ink-3">{t("deleteOrgText")}</p>
                <ConfirmAction
                  action={actions.deleteOrg}
                  hidden={{ orgId: org.id }}
                  trigger={t("deleteOrg")}
                  triggerVariant="danger"
                  triggerSize="md"
                  triggerIcon={<IconTrash size={18} />}
                  title={t("deleteOrgConfirmTitle", { org: org.name })}
                  description={t("deleteOrgConfirmText")}
                  requireText={{
                    name: "confirmName",
                    value: org.name,
                    label: <>{t.rich("deleteOrgType", { org: org.name, strong: (chunks) => <strong>{chunks}</strong> })}</>,
                  }}
                  confirmLabel={t("deleteForever")}
                  pendingLabel={t("deleting")}
                />
              </div>
            </Panel>
          ),
        }}
      />
    </OrgFlagsProvider>
  );
}
