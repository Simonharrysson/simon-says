"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LogoStep } from "@/components/onboarding/steps";
import { squareLogo } from "@/components/onboarding/logo-image";
import { renameOrgAction, saveProfileAction } from "@/app/(app)/orgs/[id]/kom-igang/actions";
import { logoUrl as versionedLogoUrl } from "@/lib/orgs/logo";
import { parseProfile, profileInput, sameProfile, type OrgProfile, type ProfileErrors, type ProfileInput } from "@/lib/orgs/profile";
import { SaveState, useSaveState } from "./SaveState";

// Föreningen: the name, the logo and "Om oss" with its links. One editor, used by Inställningar →
// Föreningen (with its own Spara) and by Kom igång's first step (whose Fortsätt saves it).

export interface OrgDetailsInitial {
  id: string;
  name: string;
  logoUpdatedAt: string | null;
  profile?: Partial<OrgProfile>;
}

export function useOrgDetails(org: OrgDetailsInitial) {
  const t = useTranslations("onboarding");
  const pt = useTranslations("profile");
  const locale = useLocale();
  const router = useRouter();
  const [savedName, setSavedName] = useState(org.name);
  const [name, setName] = useState(org.name);
  const [nameError, setNameError] = useState<string | undefined>();
  const [logoAt, setLogoAt] = useState(org.logoUpdatedAt);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoMsg, setLogoMsg] = useState<{ text: string; tone: "neutral" | "danger" | "success" } | null>(null);
  const [savedProfile, setSavedProfile] = useState<Partial<OrgProfile>>(org.profile ?? {});
  const [profile, setProfile] = useState<ProfileInput>(() => profileInput(org.profile ?? {}));
  const [profileErrors, setProfileErrors] = useState<ProfileErrors | undefined>();

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
      const res = await fetch(`/api/orgs/${org.id}/logo`, { method: "POST", body: form });
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
    const res = await fetch(`/api/orgs/${org.id}/logo`, { method: "DELETE" }).catch(() => null);
    if (res?.ok) {
      setLogoAt(null);
      setLogoMsg({ text: t("logo.removed"), tone: "neutral" });
      router.refresh();
    } else setLogoMsg({ text: t("logo.removeFailed"), tone: "danger" });
    setLogoBusy(false);
  };

  const dirty = name.trim() !== savedName || !sameProfileInput(profile, savedProfile);

  /** Saves what changed (the name, then Om oss). Returns an error sentence, or null when saved. */
  const save = async (): Promise<string | null> => {
    if (name.trim() !== savedName) {
      const r = await renameOrgAction(org.id, name).catch(() => ({ ok: false as const, message: t("offlineShort") }));
      if (!r.ok) {
        setNameError(r.message);
        return r.message;
      }
      setSavedName(name.trim());
    }
    // Om oss (optional): saved only when something changed; empty fields are fine.
    const parsed = parseProfile(profile, locale);
    if (!parsed.ok) {
      setProfileErrors(parsed.errors);
      return pt("checkFields");
    }
    if (!sameProfile(parsed.profile, savedProfile)) {
      const r = await saveProfileAction(org.id, profile).catch(() => ({ ok: false as const, message: t("offlineShort"), errors: undefined }));
      if (!r.ok) {
        setProfileErrors(r.errors ?? { about: r.message });
        return r.message;
      }
      setSavedProfile(r.profile);
      setProfile(profileInput(r.profile));
    }
    router.refresh();
    return null;
  };

  return {
    name,
    savedName,
    dirty,
    save,
    fields: {
      orgName: name.trim() || savedName,
      logoUrl: versionedLogoUrl(org.id, logoAt),
      busy: logoBusy,
      message: logoMsg,
      onFile: uploadLogo,
      onRemove: removeLogo,
      name,
      onName: (v: string) => {
        setName(v);
        setNameError(undefined);
      },
      nameError,
      profile,
      onProfile: (field: keyof ProfileInput, text: string) => {
        setProfile((v) => ({ ...v, [field]: text }));
        setProfileErrors((e) => (e?.[field] ? { ...e, [field]: undefined } : e));
      },
      profileErrors,
    },
  };
}

const sameProfileInput = (input: ProfileInput, saved: Partial<OrgProfile>) => {
  const s = profileInput(saved);
  return (Object.keys(input) as (keyof ProfileInput)[]).every((k) => input[k].trim() === s[k].trim());
};

/** Inställningar → Föreningen: the editor with its Spara (text fields; the logo saves on its own). */
export function OrgDetailsForm({ org }: { org: OrgDetailsInitial }) {
  const t = useTranslations("org.settings");
  const details = useOrgDetails(org);
  const { status, run } = useSaveState();
  return (
    <form
      className="flex max-w-[40rem] flex-col gap-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void run(details.save);
      }}
    >
      <LogoStep {...details.fields} profileOpen />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" loading={status.state === "saving"} disabled={!details.dirty && status.state !== "error"}>
          {t("save")}
        </Button>
        <SaveState status={status} />
      </div>
    </form>
  );
}
