"use client";

import { useTranslations } from "next-intl";

import { useEffect, useId, useState } from "react";
import { Field, fieldErrorClass, hintClass } from "@/components/ui/Field";
import { IconAlert, IconCheck } from "@/components/ui/icons";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Textarea } from "@/components/ui/textarea";
import { ABOUT_MAX, profileInput, type OrgProfile, type ProfileErrors, type ProfileInput } from "@/lib/orgs/profile";
import { cn } from "@/lib/utils";

export type SaveProfile = (
  orgId: string,
  input: ProfileInput,
) => Promise<{ ok: true; profile: OrgProfile } | { ok: false; message: string; errors?: ProfileErrors }>;

/**
 * The "Om oss" fields (todo #13): the short text and the three links. Controlled, so Kom igång's
 * first step and Inställningar share them; the server (lib/orgs/profile.ts) decides what is valid.
 */
export function OrgProfileFields({
  value,
  onChange,
  errors,
}: {
  value: ProfileInput;
  onChange: (field: keyof ProfileInput, text: string) => void;
  errors?: ProfileErrors;
}) {
  const t = useTranslations("profile");
  const id = useId();
  const count = [...value.about.replace(/\r\n?/g, "\n")].length;
  const over = count > ABOUT_MAX;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-about`}>{t("about")}</Label>
        <Textarea
          id={`${id}-about`}
          name="about"
          value={value.about}
          rows={4}
          onChange={(e) => onChange("about", e.target.value)}
          aria-invalid={errors?.about || over ? true : undefined}
          aria-describedby={`${id}-about-hint${errors?.about ? ` ${id}-about-error` : ""}`}
        />
        <p id={`${id}-about-hint`} className={cn(hintClass, "flex justify-between gap-4")}>
          <span>{t("aboutHint")}</span>
          <span className={cn("font-mono tabular-nums", over && "text-red")}>
            {count}/{ABOUT_MAX}
          </span>
        </p>
        {errors?.about && (
          <p id={`${id}-about-error`} className={fieldErrorClass}>
            <IconAlert size={16} />
            {errors.about}
          </p>
        )}
      </div>
      <Field
        id={`${id}-website`}
        name="website"
        label={t("websiteLabel")}
        value={value.website}
        inputMode="url"
        autoComplete="url"
        placeholder="https://exempel.se"
        onChange={(e) => onChange("website", e.target.value)}
        error={errors?.website}
      />
      <Field
        id={`${id}-facebook`}
        name="facebook"
        label="Facebook"
        value={value.facebook}
        autoComplete="off"
        placeholder="facebook.com/exempel"
        onChange={(e) => onChange("facebook", e.target.value)}
        error={errors?.facebook}
      />
      <Field
        id={`${id}-instagram`}
        name="instagram"
        label="Instagram"
        value={value.instagram}
        autoComplete="off"
        autoCapitalize="none"
        placeholder="@exempel"
        onChange={(e) => onChange("instagram", e.target.value)}
        error={errors?.instagram}
      />
    </div>
  );
}

/** Inställningar → "Om oss". Saves through `save` (saveProfileAction) and shows the stored form back. */
export function OrgProfileForm({ orgId, profile, save }: { orgId: string; profile: Partial<OrgProfile>; save: SaveProfile }) {
  const t = useTranslations("profile");
  const [value, setValue] = useState(() => profileInput(profile));
  const [errors, setErrors] = useState<ProfileErrors | undefined>();
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(timer);
  }, [saved]);

  return (
    <form
      className="flex max-w-[40rem] flex-col gap-5"
      action={async () => {
        setSaved(false);
        setMessage(null);
        const r = await save(orgId, value).catch(() => ({ ok: false as const, message: t("offline"), errors: undefined }));
        if (r.ok) {
          setValue(profileInput(r.profile));
          setErrors(undefined);
          setSaved(true);
        } else {
          setErrors(r.errors);
          setMessage(r.message);
        }
      }}
    >
      <fieldset className="flex flex-col gap-5">
        <legend className="mb-1 font-medium">{t("legend")}</legend>
        <p className="-mt-3 text-sm text-ink-2">{t("intro")}</p>
        <OrgProfileFields
          value={value}
          errors={errors}
          onChange={(field, text) => {
            setValue((v) => ({ ...v, [field]: text }));
            setErrors((e) => (e?.[field] ? { ...e, [field]: undefined } : e));
            setSaved(false);
          }}
        />
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="primary" pendingLabel={t("saving")}>
          {t("save")}
        </SubmitButton>
        <span className={cn("inline-flex items-center gap-1 text-sm font-semibold", saved ? "text-green" : "text-red")} role="status" aria-live="polite">
          {saved ? (
            <>
              <IconCheck size={18} /> {t("saved")}
            </>
          ) : (
            message
          )}
        </span>
      </div>
    </form>
  );
}
