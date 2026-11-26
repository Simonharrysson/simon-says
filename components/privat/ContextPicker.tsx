"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Check, fieldErrorClass, hintClass } from "@/components/ui/Field";
import { IconPlus } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

export interface PrivatChoice {
  contextId: string;
  withDoc: boolean;
}

export type CreateContext = (name: string) => Promise<{ ok: true; context: { id: string; name: string } } | { ok: false; message: string }>;

const NEW = "__new";

/**
 * Before a Privat recording (in the live page's consent step, where a förening picks its agenda):
 * what the recording is about. The last used context is preselected; "Nytt sammanhang…" adds one
 * inline. "Skriv även i ett Google-dokument" is off by default: the notes then stay in Simon Says.
 */
export function ContextPicker({
  contexts: initial,
  initialId,
  create,
  onChange,
  disabled,
}: {
  contexts: { id: string; name: string }[];
  /** Preselected: the context the user came from, else the last used one. */
  initialId: string | null;
  create: CreateContext;
  onChange: (choice: PrivatChoice | null) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("privat.picker");
  const id = useId();
  const [contexts, setContexts] = useState(initial);
  const [selected, setSelected] = useState<string>(initialId && initial.some((c) => c.id === initialId) ? initialId : (initial[0]?.id ?? NEW));
  const [name, setName] = useState(initial.length ? "" : t("defaultName"));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [withDoc, setWithDoc] = useState(false);

  useEffect(() => {
    onChange(selected !== NEW ? { contextId: selected, withDoc } : null);
  }, [selected, withDoc, onChange]);

  const add = async () => {
    setSaving(true);
    setError(null);
    const res = await create(name).catch(() => ({ ok: false as const, message: t("offline") }));
    setSaving(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setContexts((cs) => (cs.some((c) => c.id === res.context.id) ? cs : [res.context, ...cs]));
    setSelected(res.context.id);
    setName("");
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-ctx`}>{t("label")}</Label>
        {contexts.length > 0 && (
          <NativeSelect id={`${id}-ctx`} value={selected} onChange={(e) => setSelected(e.target.value)} disabled={disabled}>
            {contexts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value={NEW}>{t("newOption")}</option>
          </NativeSelect>
        )}
        {selected === NEW && (
          <form
            className="flex items-start gap-2 max-[30rem]:flex-col max-[30rem]:items-stretch"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <Input
              id={contexts.length ? `${id}-new` : `${id}-ctx`}
              aria-label={contexts.length ? t("newLabel") : undefined}
              aria-describedby={`${id}-hint${error ? ` ${id}-err` : ""}`}
              aria-invalid={error ? true : undefined}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("placeholder")}
              maxLength={80}
              disabled={disabled || saving}
              className="min-w-0 flex-1"
            />
            <Button type="submit" icon={<IconPlus size={18} />} loading={saving} disabled={disabled || !name.trim()}>
              {t("add")}
            </Button>
          </form>
        )}
        <p id={`${id}-hint`} className={hintClass}>
          {t("hint", { fallback: t("defaultName") })}
        </p>
        {error && (
          <p id={`${id}-err`} className={fieldErrorClass} role="alert">
            {error}
          </p>
        )}
      </div>
      <Check
        id={`${id}-doc`}
        title={t("withDoc")}
        checked={withDoc}
        onCheckedChange={(on) => setWithDoc(on === true)}
        disabled={disabled}
      >
        {t("withDocText")}
      </Check>
    </div>
  );
}
