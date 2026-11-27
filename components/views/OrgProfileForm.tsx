"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import { Field, fieldErrorClass, hintClass } from "@/components/ui/Field";
import { IconAlert } from "@/components/ui/icons";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ABOUT_MAX, type OrgProfile, type ProfileErrors, type ProfileField, type ProfileInput } from "@/lib/orgs/profile";
import { cn } from "@/lib/utils";

export type SaveProfile = (
  orgId: string,
  input: ProfileInput,
) => Promise<{ ok: true; profile: OrgProfile } | { ok: false; message: string; errors?: ProfileErrors }>;

/**
 * The "Om oss" fields (todo #13): the short text and the three links. Controlled, so Kom igång's
 * first step and Inställningar → Föreningen share them (`useOrgDetails`); the server (lib/orgs/profile.ts) decides what is valid.
 */
export function OrgProfileFields({
  value,
  onChange,
  errors,
  fields = ["about", "website", "facebook", "instagram"],
}: {
  value: ProfileInput;
  onChange: (field: keyof ProfileInput, text: string) => void;
  errors?: ProfileErrors;
  /** Which fields to show (Företag: the website only). */
  fields?: ProfileField[];
}) {
  const t = useTranslations("profile");
  const id = useId();
  const count = [...value.about.replace(/\r\n?/g, "\n")].length;
  const over = count > ABOUT_MAX;
  return (
    <div className="flex flex-col gap-5">
      {fields.includes("about") && (
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
      )}
      {fields.includes("website") && (
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
      )}
      {fields.includes("facebook") && (
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
      )}
      {fields.includes("instagram") && (
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
      )}
    </div>
  );
}
