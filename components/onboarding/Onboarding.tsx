"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Banner } from "@/components/ui/Banner";
import { LearnFormatView, useFormatFlow } from "@/components/views/FormatEditor";
import { useStadgarArsmote } from "@/components/views/StadgarArsmote";
import { useMeetingFolderPicker } from "@/components/views/useMeetingFolderPicker";
import type { FormatProfile } from "@/lib/formats/schema";
import { STEP_IDS, markStep, stepNumber, type OnboardingState, type StepId } from "@/lib/onboarding/steps";
import { logoUrl as versionedLogoUrl } from "@/lib/orgs/logo";
import { parseProfile, profileInput, sameProfile, type OrgProfile, type ProfileErrors, type ProfileInput } from "@/lib/orgs/profile";
import type { BoardRow } from "@/lib/people/board";
import type { InviteRow } from "@/lib/invites/rules";
import { InviteByEmail } from "@/components/views/InviteByEmail";
import {
  addBoardPersonAction,
  removeBoardPersonAction,
  renameOrgAction,
  saveProfileAction,
  stepAction,
  updateBoardPersonAction,
  voiceConsentAction,
  type ActionResult,
} from "@/app/(app)/orgs/[id]/kom-igang/actions";
import { squareLogo } from "./logo-image";
import { OnboardingShell, StepFooter, type ShellStep } from "./OnboardingShell";
import { BoardStep, DoneStep, FolderStep, FormatStep, HistoryStep, LogoStep, VoicesStep, type WeeklyChoice } from "./steps";

// Kom igång (todo #5), the container: one step at a time, each skippable, progress saved on
// every Fortsätt / Hoppa över (org_onboarding, 0035) and kept in the URL (?steg=n), so it can be
// left and resumed from the förening page's card.

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
  /** The förening's default format: its kind and display name (null: none yet → Enkel). */
  format: { kind: FormatProfile["kind"] | null; name: string; profile: FormatProfile | null };
  /** An årsmöte from the stadgar is saved (orgs.arsmote_format_id). */
  stadgarSaved: boolean;
  historyCount: number;
}

// Each step's heading and lead: onboarding.titles.<step> in the catalogs.

const msg = (r: ActionResult) => (r.ok ? null : r.message);

export function Onboarding(p: OnboardingProps) {
  const t = useTranslations("onboarding");
  const locale = useLocale();
  const router = useRouter();
  const orgId = p.org.id;
  const orgHref = `/orgs/${orgId}`;
  const [step, setStep] = useState<ShellStep>(p.initialStep);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [state, setState] = useState(p.state);
  const [busy, setBusy] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);
  const [invites, setInvites] = useState(p.invites);

  // 1. Namn och logga
  const [name, setName] = useState(p.org.name);
  const [nameError, setNameError] = useState<string | undefined>();
  const [logoAt, setLogoAt] = useState(p.org.logoUpdatedAt);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoMsg, setLogoMsg] = useState<{ text: string; tone: "neutral" | "danger" | "success" } | null>(null);
  const [savedProfile, setSavedProfile] = useState<Partial<OrgProfile>>(p.org.profile ?? {});
  const [profile, setProfile] = useState<ProfileInput>(() => profileInput(p.org.profile ?? {}));
  const [profileErrors, setProfileErrors] = useState<ProfileErrors | undefined>();

  // 3, 4, 6
  const folder = useMeetingFolderPicker(orgId);
  const [choice, setChoice] = useState<WeeklyChoice>(p.format.kind && p.format.kind !== "enkel" && p.format.kind !== "veckomote" ? "current" : "veckomote");
  const flow = useFormatFlow(orgId, p.format.profile ?? undefined);
  const stadgarFlow = useStadgarArsmote(orgId);
  const stadgar = stadgarFlow.stadgar;
  const [voicePending, setVoicePending] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);

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

  const uploadLogo = async (file: File) => {
    setLogoBusy(true);
    setLogoMsg(null);
    const sq = await squareLogo(file, locale);
    if (!sq.ok) {
      setLogoMsg({ text: sq.message, tone: "danger" });
      setLogoBusy(false);
      return;
    }
    const form = new FormData();
    form.set("logo", sq.blob, "logo");
    try {
      const res = await fetch(`/api/orgs/${orgId}/logo`, { method: "POST", body: form });
      const json = (await res.json().catch(() => null)) as { updatedAt?: string; message?: string } | null;
      if (!res.ok || !json?.updatedAt) setLogoMsg({ text: json?.message ?? t("logo.saveFailed"), tone: "danger" });
      else {
        setLogoAt(json.updatedAt);
        setLogoMsg({ text: t("logo.saved"), tone: "success" });
        router.refresh();
      }
    } catch {
      setLogoMsg({ text: t("logo.offline"), tone: "danger" });
    }
    setLogoBusy(false);
  };

  const removeLogo = async () => {
    setLogoBusy(true);
    const res = await fetch(`/api/orgs/${orgId}/logo`, { method: "DELETE" }).catch(() => null);
    if (res?.ok) {
      setLogoAt(null);
      setLogoMsg({ text: t("logo.removed"), tone: "neutral" });
      router.refresh();
    } else setLogoMsg({ text: t("logo.removeFailed"), tone: "danger" });
    setLogoBusy(false);
  };

  const onConsent = async (personId: string, consent: boolean) => {
    setVoicePending(personId);
    setVoiceError(msg(await voiceConsentAction(orgId, personId, consent)));
    setVoicePending(null);
    router.refresh();
  };

  const board = (r: Promise<ActionResult>) => r.then((x) => { router.refresh(); return msg(x); }, () => t("offlineShort"));
  const boardAdd = (r: Promise<ActionResult>) =>
    r.then(
      (x) => {
        router.refresh();
        return x.ok ? null : x.editPersonId ? { message: x.message, editPersonId: x.editPersonId } : x.message;
      },
      () => t("offlineShort"),
    );

  const logoUrl = versionedLogoUrl(orgId, logoAt);
  const shell = {
    orgName: name.trim() || p.org.name,
    orgHref,
    logoUrl,
    step,
    done: state.done,
    skipped: state.skipped,
    onGo,
    direction,
    title: t(`titles.${step}.title`),
    lead: t(`titles.${step}.lead`),
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
                if (name.trim() !== p.org.name) {
                  const r = await renameOrgAction(orgId, name);
                  if (!r.ok) return setNameError(r.message);
                }
                // Om oss (optional): saved only when something changed; empty fields are fine.
                const parsed = parseProfile(profile, locale);
                if (!parsed.ok) return setProfileErrors(parsed.errors);
                if (!sameProfile(parsed.profile, savedProfile)) {
                  const r = await saveProfileAction(orgId, profile).catch(() => ({ ok: false as const, message: t("offlineShort"), errors: undefined }));
                  if (!r.ok) return setProfileErrors(r.errors ?? { about: r.message });
                  setSavedProfile(r.profile);
                }
                await finish("namn", "done");
              }}
            />
          }
        >
          <LogoStep orgName={shell.orgName} logoUrl={logoUrl} busy={logoBusy} message={logoMsg} onFile={uploadLogo} onRemove={removeLogo} name={name} onName={(v) => { setName(v); setNameError(undefined); }} nameError={nameError}
            profile={profile}
            onProfile={(field, text) => {
              setProfile((v) => ({ ...v, [field]: text }));
              setProfileErrors((e) => (e?.[field] ? { ...e, [field]: undefined } : e));
            }}
            profileErrors={profileErrors}
          />
        </OnboardingShell>
      );
    case "styrelsen":
      return (
        <OnboardingShell {...shell} footer={<StepFooter busy={busy} onBack={back} onSkip={() => finish("styrelsen", "skipped")} onNext={() => finish("styrelsen", p.board.some((r) => r.personId) ? "done" : "skipped")} />}>
          <BoardStep
            orgName={shell.orgName}
            rows={p.board}
            inviteUrl={p.inviteUrl}
            myEmail={p.myEmail}
            invites={invites}
            inviteEmail={
              <InviteByEmail
                orgId={orgId}
                orgName={shell.orgName}
                inviterName={p.inviterName}
                inviteUrl={p.inviteUrl}
                invites={invites}
                memberEmails={p.board.flatMap((r) => (r.member?.email ? [r.member.email.toLowerCase()] : []))}
                suggestions={p.board.flatMap((r) => (r.status === "invited" && r.email && !invites.some((i) => i.email === r.email!.toLowerCase()) ? [r.email.toLowerCase()] : []))}
                onInvitesChange={setInvites}
              />
            }
            onAdd={(input, member) => boardAdd(addBoardPersonAction(orgId, input, member))}
            onUpdate={(id, input) => board(updateBoardPersonAction(orgId, id, input))}
            onRemove={(id) => board(removeBoardPersonAction(orgId, id))}
          />
        </OnboardingShell>
      );
    case "mapp":
      return (
        <OnboardingShell {...shell} footer={<StepFooter busy={busy} onBack={back} onSkip={() => finish("mapp", "skipped")} onNext={() => finish("mapp", p.org.folderSet ? "done" : "skipped")} />}>
          <FolderStep folderName={p.org.folderName} folderSet={p.org.folderSet} pickerEnabled={p.pickerEnabled} busy={folder.busy} message={folder.message} onPick={folder.pick} />
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
              nextDisabled={stadgar.phase === "reading" || stadgar.phase === "saving" || flow.view.phase === "proposing"}
              onNext={async () => {
                setFormatError(null);
                if (choice === "veckomote") {
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
                // "Som våra gamla protokoll" without approving a learned format: nothing chosen yet.
                await finish("format", choice === "learn" ? "skipped" : "done");
              }}
            />
          }
        >
          <FormatStep
            choice={choice}
            onChoice={setChoice}
            currentName={p.format.kind && p.format.kind !== "enkel" && p.format.kind !== "veckomote" ? p.format.name : null}
            learn={
              p.pickerEnabled ? (
                <LearnFormatView
                  orgId={orgId}
                  view={flow.view}
                  variant="learn"
                  onStart={() => flow.start("learn")}
                  onCancel={flow.reset}
                  onApproved={() => {
                    flow.reset();
                    setChoice("current");
                  }}
                />
              ) : (
                <p className="text-sm text-ink-3">{t("pickerOffWeekly")}</p>
              )
            }
            pickerEnabled={p.pickerEnabled}
            stadgar={stadgar}
            stadgarSaved={p.stadgarSaved}
            onStadgarPick={stadgarFlow.pick}
            onStadgarChange={stadgarFlow.change}
            onStadgarSave={stadgarFlow.save}
            onStadgarCancel={stadgarFlow.cancel}
          />
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
          <VoicesStep
            people={p.board.filter((r) => r.personId && r.name).map((r) => ({ personId: r.personId!, name: r.name!, role: r.role, consent: r.voiceConsent }))}
            onConsent={onConsent}
            pending={voicePending}
            error={voiceError}
            onBoard={() => go("styrelsen", "back")}
          />
        </OnboardingShell>
      );
    default:
      return (
        <OnboardingShell {...shell}>
          <DoneStep done={state.done} skipped={state.skipped} prepareHref={`/orgs/${orgId}/forbered`} orgHref={orgHref} onGo={onGo} />
        </OnboardingShell>
      );
  }
}
