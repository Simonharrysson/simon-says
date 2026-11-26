"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PickerError, usePicker } from "@/components/google/Picker";
import { LearnFormatView, useFormatFlow } from "@/components/views/FormatEditor";
import { useMeetingFolderPicker } from "@/components/views/useMeetingFolderPicker";
import type { FormatProfile } from "@/lib/formats/schema";
import { STEP_IDS, markStep, stepNumber, type OnboardingState, type StepId } from "@/lib/onboarding/steps";
import { logoUrl as versionedLogoUrl } from "@/lib/orgs/logo";
import type { BoardRow } from "@/lib/people/board";
import {
  addBoardPersonAction,
  removeBoardPersonAction,
  renameOrgAction,
  stepAction,
  updateBoardPersonAction,
  voiceConsentAction,
  type ActionResult,
} from "@/app/(app)/orgs/[id]/kom-igang/actions";
import { squareLogo } from "./logo-image";
import { OnboardingShell, StepFooter, type ShellStep } from "./OnboardingShell";
import { BoardStep, DoneStep, FolderStep, FormatStep, HistoryStep, LogoStep, VoicesStep, type StadgarPhase, type WeeklyChoice } from "./steps";

// Kom igång (todo #5), the container: one step at a time, each skippable, progress saved on
// every Fortsätt / Hoppa över (org_onboarding, 0035) and kept in the URL (?steg=n), so it can be
// left and resumed from the förening page's card.

export interface OnboardingProps {
  org: { id: string; name: string; logoUpdatedAt: string | null; folderSet: boolean; folderName: string | null };
  initialStep: ShellStep;
  state: OnboardingState;
  board: BoardRow[];
  inviteUrl: string;
  myEmail: string | null;
  pickerEnabled: boolean;
  /** The förening's default format: its kind and display name (null: none yet → Enkel). */
  format: { kind: FormatProfile["kind"] | null; name: string; profile: FormatProfile | null };
  stadgarSaved: { styrelse: boolean; arsmote: boolean };
  historyCount: number;
}

const TITLES: Record<ShellStep, { title: string; lead?: string }> = {
  namn: { title: "Välkommen! Hur ser ni ut?", lead: "Kontrollera namnet och lägg gärna till er logga, så känner alla igen föreningen." },
  styrelsen: { title: "Vilka sitter i styrelsen?", lead: "En lista för alla: namn och roll för anteckningarna, e-post för den som ska kunna starta möten." },
  mapp: { title: "Var ska mötesdokumenten ligga?", lead: "Simon Says skriver varje möte i ett Google-dokument. Välj en mapp i Drive som styrelsen delar." },
  format: { title: "Så brukar ni ha möten", lead: "Simon Says skriver protokollet i er form. Det går att ändra när som helst." },
  protokoll: { title: "Era tidigare möten", lead: "Läs in gamla protokoll, så vet Simon Says vad ni har beslutat och vad som är på gång – redan till första mötet." },
  roster: { title: "Röster (valfritt)", lead: "Simon Says kan lära sig vem som pratar, så att ni slipper namnrundan varje gång." },
  klart: { title: "Nu är ni redo", lead: "Nu kan ni förbereda första mötet. Det du hoppade över kan du göra när som helst." },
};

const msg = (r: ActionResult) => (r.ok ? null : r.message);

export function Onboarding(p: OnboardingProps) {
  const router = useRouter();
  const orgId = p.org.id;
  const orgHref = `/orgs/${orgId}`;
  const [step, setStep] = useState<ShellStep>(p.initialStep);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [state, setState] = useState(p.state);
  const [busy, setBusy] = useState(false);

  // 1. Namn och logga
  const [name, setName] = useState(p.org.name);
  const [nameError, setNameError] = useState<string | undefined>();
  const [logoAt, setLogoAt] = useState(p.org.logoUpdatedAt);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoMsg, setLogoMsg] = useState<{ text: string; tone: "neutral" | "danger" | "success" } | null>(null);

  // 3, 4, 6
  const folder = useMeetingFolderPicker(orgId);
  const [choice, setChoice] = useState<WeeklyChoice>(p.format.kind && p.format.kind !== "enkel" && p.format.kind !== "veckomote" ? "current" : "veckomote");
  const flow = useFormatFlow(orgId, p.format.profile ?? undefined);
  const picker = usePicker();
  const [stadgar, setStadgar] = useState<StadgarPhase>({ phase: "idle" });
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
    const sq = await squareLogo(file);
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
      if (!res.ok || !json?.updatedAt) setLogoMsg({ text: json?.message ?? "Loggan kunde inte sparas. Försök igen.", tone: "danger" });
      else {
        setLogoAt(json.updatedAt);
        setLogoMsg({ text: "Loggan är sparad.", tone: "success" });
        router.refresh();
      }
    } catch {
      setLogoMsg({ text: "Vi nådde inte servern. Kontrollera nätet och försök igen.", tone: "danger" });
    }
    setLogoBusy(false);
  };

  const removeLogo = async () => {
    setLogoBusy(true);
    const res = await fetch(`/api/orgs/${orgId}/logo`, { method: "DELETE" }).catch(() => null);
    if (res?.ok) {
      setLogoAt(null);
      setLogoMsg({ text: "Loggan är borttagen.", tone: "neutral" });
      router.refresh();
    } else setLogoMsg({ text: "Loggan kunde inte tas bort. Försök igen.", tone: "danger" });
    setLogoBusy(false);
  };

  const pickStadgar = async () => {
    let picked;
    try {
      picked = await picker.open({ mode: "doc-or-pdf", title: "Välj föreningens stadgar" });
    } catch (err) {
      setStadgar({ phase: "error", message: err instanceof PickerError ? err.message : "Google-väljaren kunde inte öppnas. Försök igen." });
      return;
    }
    if (!picked?.[0]) return;
    setStadgar({ phase: "reading" });
    try {
      const res = await fetch(`/api/orgs/${orgId}/onboarding/stadgar`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileId: picked[0].id }),
      });
      const json = (await res.json().catch(() => null)) as { board?: string[]; arsmote?: string[]; message?: string } | null;
      if (!res.ok || !Array.isArray(json?.board) || !Array.isArray(json?.arsmote)) {
        setStadgar({ phase: "error", message: json?.message ?? "Simon Says kunde inte läsa stadgarna. Försök igen." });
        return;
      }
      setStadgar({ phase: "review", board: json.board, arsmote: json.arsmote });
    } catch {
      setStadgar({ phase: "error", message: "Vi nådde inte servern. Kontrollera nätet och försök igen." });
    }
  };

  const saveStadgar = async () => {
    if (stadgar.phase !== "review") return;
    const { board, arsmote } = stadgar;
    setStadgar({ phase: "saving", board, arsmote });
    const res = await fetch(`/api/orgs/${orgId}/onboarding/formats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ board, arsmote }),
    }).catch(() => null);
    if (res?.ok) setStadgar({ phase: "saved", board: board.length, arsmote: arsmote.length });
    else {
      const json = (await res?.json().catch(() => null)) as { message?: string } | null;
      setStadgar({ phase: "error", message: json?.message ?? "Formaten kunde inte sparas. Försök igen." });
    }
  };

  const onConsent = async (personId: string, consent: boolean) => {
    setVoicePending(personId);
    setVoiceError(msg(await voiceConsentAction(orgId, personId, consent)));
    setVoicePending(null);
    router.refresh();
  };

  const board = (r: Promise<ActionResult>) => r.then((x) => { router.refresh(); return msg(x); }, () => "Vi nådde inte servern. Försök igen.");

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
    ...TITLES[step],
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
                await finish("namn", "done");
              }}
            />
          }
        >
          <LogoStep orgName={shell.orgName} logoUrl={logoUrl} busy={logoBusy} message={logoMsg} onFile={uploadLogo} onRemove={removeLogo} name={name} onName={(v) => { setName(v); setNameError(undefined); }} nameError={nameError} />
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
            onAdd={(input, member) => board(addBoardPersonAction(orgId, input, member))}
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
                if (choice === "veckomote") {
                  setBusy(true);
                  await fetch(`/api/orgs/${orgId}/onboarding/formats`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ weekly: true }),
                  }).catch(() => null);
                }
                await finish("format", "done");
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
                <p className="text-sm text-ink-3">Google-väljaren är inte inställd än. Välj Veckomöte så länge.</p>
              )
            }
            pickerEnabled={p.pickerEnabled}
            stadgar={stadgar}
            stadgarSaved={p.stadgarSaved}
            onStadgarPick={pickStadgar}
            onStadgarChange={(b, a) => stadgar.phase === "review" && setStadgar({ phase: "review", board: b, arsmote: a })}
            onStadgarSave={saveStadgar}
            onStadgarCancel={() => setStadgar({ phase: "idle" })}
          />
        </OnboardingShell>
      );
    case "protokoll":
      return (
        <OnboardingShell
          {...shell}
          footer={<StepFooter busy={busy} onBack={back} onSkip={() => finish("protokoll", "skipped")} onNext={() => finish("protokoll", p.historyCount > 0 ? "done" : "skipped")} />}
        >
          <HistoryStep importHref={`/orgs/${orgId}/protokoll`} historyCount={p.historyCount} onOpen={() => void stepAction(orgId, "protokoll", "done")} />
        </OnboardingShell>
      );
    case "roster":
      return (
        <OnboardingShell
          {...shell}
          footer={<StepFooter busy={busy} onBack={back} onSkip={() => finish("roster", "skipped")} onNext={() => finish("roster", "done")} nextLabel="Klar" />}
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
