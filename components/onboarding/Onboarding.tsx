"use client";

import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { Banner } from "@/components/ui/Banner";
import { MeetingFolderSetting, VoicesSetting } from "@/components/settings/MeetingSettings";
import type { DriveAccountResult } from "@/components/onboarding/steps";
import type { DriveAccountView } from "@/lib/google/drive-account-rules";
import { useOrgDetails } from "@/components/settings/OrgDetails";
import { OrgBoard } from "@/components/views/OrgBoard";
import { STEP_IDS, markStep, stepNumber, type OnboardingState, type StepId } from "@/lib/onboarding/steps";
import type { OrgProfile } from "@/lib/orgs/profile";
import { settingsHref, type SettingsSectionId } from "@/lib/orgs/tabs";
import type { BoardRow } from "@/lib/people/board";
import type { InviteRow } from "@/lib/invites/rules";
import { stepAction } from "@/app/(app)/orgs/[id]/kom-igang/actions";
import { OnboardingShell, StepFooter, type ShellStep } from "./OnboardingShell";
import { DoneStep, HistoryStep, LogoStep } from "./steps";

// Kom igång (todo #5), the container: one step at a time, each skippable, progress saved on
// every Fortsätt / Hoppa över (org_onboarding, 0035) and kept in the URL (?steg=n), so it can be
// left and resumed from the förening page's card.
//
// A checklist, not a second editor: each step renders the very component Inställningar uses
// (Föreningen's editor, the board list, the meeting folder, the format card, the voices), and a
// done step says where that setting lives from now on.

/** Where each step's setting lives in Inställningar (Era tidigare möten: the import page). */
export const STEP_SECTION: Record<Exclude<StepId, "protokoll">, SettingsSectionId> = {
  namn: "foreningen",
  styrelsen: "styrelsen",
  mapp: "moten",
  format: "moten",
  roster: "moten",
};

export interface OnboardingProps {
  org: { id: string; name: string; logoUpdatedAt: string | null; folderSet: boolean; folderName: string | null; profile?: Partial<OrgProfile> };
  initialStep: ShellStep;
  state: OnboardingState;
  board: BoardRow[];
  inviteUrl: string;
  myEmail: string | null;
  /** Invites sent by e-mail (0038) and the name the e-mail says invites. */
  invites: InviteRow[];
  inviterName: string;
  pickerEnabled: boolean;
  /** 0070: the förening's own Drive account (admins), and `?drivekonto=` after connecting. */
  driveAccount?: DriveAccountView | null;
  driveResult?: DriveAccountResult | null;
  stuckShares?: number;
  /** The format card (`FormatCard`), as on Inställningar → Möten. */
  formatCard: ReactNode;
  historyCount: number;
}

// Each step's heading and lead: onboarding.titles.<step> in the catalogs.

export function Onboarding(p: OnboardingProps) {
  const t = useTranslations("onboarding");
  const sections = useTranslations("org.settings.sections");
  const orgId = p.org.id;
  const orgHref = `/orgs/${orgId}`;
  const [step, setStep] = useState<ShellStep>(p.initialStep);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [state, setState] = useState(p.state);
  const [busy, setBusy] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);
  const details = useOrgDetails(p.org);

  const go = (to: ShellStep, dir: "forward" | "back" = "forward") => {
    setDirection(dir);
    setStep(to);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("steg", to === "klart" ? "klart" : String(stepNumber(to)));
      window.history.replaceState(null, "", url);
    } catch {
      /* the URL is a convenience */
    }
  };
  const nextOf = (s: StepId): ShellStep => STEP_IDS[STEP_IDS.indexOf(s) + 1] ?? "klart";
  const prevOf = (s: StepId): StepId | null => STEP_IDS[STEP_IDS.indexOf(s) - 1] ?? null;

  const finish = async (s: StepId, how: "done" | "skipped") => {
    setBusy(true);
    setState((cur) => markStep(cur, s, how, new Date().toISOString()));
    await stepAction(orgId, s, how).catch(() => null);
    setBusy(false);
    go(nextOf(s));
  };

  const onGo = (s: StepId) => go(s, step !== "klart" && STEP_IDS.indexOf(s) < STEP_IDS.indexOf(step) ? "back" : step === "klart" ? "back" : "forward");

  const editHref = (s: StepId) => (s === "protokoll" ? `/orgs/${orgId}/protokoll` : settingsHref(orgId, STEP_SECTION[s]));
  // A step done before says where its setting lives now: the same editor, in Inställningar.
  const doneNote =
    step !== "klart" && state.done.includes(step)
      ? step === "protokoll"
        ? t.rich("shell.importNote", { link: (chunks) => <a href={editHref(step)}>{chunks}</a> })
        : t.rich("shell.doneNote", { section: sections(STEP_SECTION[step]), link: (chunks) => <a href={editHref(step)}>{chunks}</a> })
      : undefined;

  const shell = {
    orgName: details.fields.orgName,
    orgHref,
    logoUrl: details.fields.logoUrl,
    step,
    done: state.done,
    skipped: state.skipped,
    onGo,
    direction,
    title: t(`titles.${step}.title`),
    lead: t(`titles.${step}.lead`),
    note: doneNote,
  };
  const back = step !== "klart" && prevOf(step) ? () => go(prevOf(step as StepId)!, "back") : undefined;

  switch (step) {
    case "namn":
      return (
        <OnboardingShell
          {...shell}
          footer={
            <StepFooter
              busy={busy}
              onNext={async () => {
                setBusy(true);
                const error = await details.save();
                setBusy(false);
                if (!error) await finish("namn", "done");
              }}
            />
          }
        >
          <LogoStep {...details.fields} />
        </OnboardingShell>
      );
    case "styrelsen":
      return (
        <OnboardingShell {...shell} footer={<StepFooter busy={busy} onBack={back} onSkip={() => finish("styrelsen", "skipped")} onNext={() => finish("styrelsen", p.board.some((r) => r.personId) ? "done" : "skipped")} />}>
          <OrgBoard orgId={orgId} orgName={shell.orgName} rows={p.board} inviteUrl={p.inviteUrl} myEmail={p.myEmail} invites={p.invites} inviterName={p.inviterName} />
        </OnboardingShell>
      );
    case "mapp":
      return (
        <OnboardingShell {...shell} footer={<StepFooter busy={busy} onBack={back} onSkip={() => finish("mapp", "skipped")} onNext={() => finish("mapp", p.org.folderSet ? "done" : "skipped")} />}>
          <MeetingFolderSetting
            orgId={orgId}
            folderName={p.org.folderName}
            folderSet={p.org.folderSet}
            pickerEnabled={p.pickerEnabled}
            driveAccount={p.driveAccount ?? null}
            driveResult={p.driveResult ?? null}
            stuckShares={p.stuckShares ?? 0}
            from="kom-igang"
          />
        </OnboardingShell>
      );
    case "format":
      return (
        <OnboardingShell
          {...shell}
          footer={
            <StepFooter
              busy={busy}
              onBack={back}
              onSkip={() => finish("format", "skipped")}
              onNext={async () => {
                setFormatError(null);
                // Nothing chosen yet: the förening gets the Veckomöte the card shows as its start
                // (the route keeps any format already chosen, also one chosen in the card just now).
                {
                  setBusy(true);
                  const res = await fetch(`/api/orgs/${orgId}/onboarding/formats`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ weekly: true }),
                  }).catch(() => null);
                  if (!res?.ok) {
                    setBusy(false);
                    const json = (await res?.json().catch(() => null)) as { message?: string } | null;
                    return setFormatError(json?.message ?? t("weeklyFailed"));
                  }
                }
                await finish("format", "done");
              }}
            />
          }
        >
          {p.formatCard}
          {formatError && (
            <Banner tone="danger" live={false}>
              {formatError}
            </Banner>
          )}
        </OnboardingShell>
      );
    case "protokoll":
      return (
        <OnboardingShell
          {...shell}
          footer={<StepFooter busy={busy} onBack={back} onSkip={() => finish("protokoll", "skipped")} onNext={() => finish("protokoll", p.historyCount > 0 ? "done" : "skipped")} />}
        >
          <HistoryStep importHref={`/orgs/${orgId}/protokoll`} historyCount={p.historyCount} />
        </OnboardingShell>
      );
    case "roster":
      return (
        <OnboardingShell
          {...shell}
          footer={<StepFooter busy={busy} onBack={back} onSkip={() => finish("roster", "skipped")} onNext={() => finish("roster", "done")} nextLabel={t("shell.finish")} />}
        >
          <VoicesSetting orgId={orgId} board={p.board} onBoard={() => go("styrelsen", "back")} />
        </OnboardingShell>
      );
    default:
      return (
        <OnboardingShell {...shell}>
          <DoneStep done={state.done} skipped={state.skipped} prepareHref={`/orgs/${orgId}/forbered`} orgHref={orgHref} onGo={onGo} editHref={editHref} />
        </OnboardingShell>
      );
  }
}
