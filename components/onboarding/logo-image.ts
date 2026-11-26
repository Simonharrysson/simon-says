"use client";

import { defaultLocale, type Locale } from "@/lib/i18n/config";
import { translator } from "@/lib/i18n/translator";
import { LOGO_MAX_BYTES, LOGO_MAX_INPUT_BYTES, LOGO_SIZE, isLogoType, squareCrop } from "@/lib/orgs/logo";

/** The picked image as a centred 256×256 square (WebP, PNG where WebP isn't supported), or an error in the UI language. */
export async function squareLogo(file: File, locale: Locale = defaultLocale): Promise<{ ok: true; blob: Blob } | { ok: false; message: string }> {
  const t = translator(locale);
  if (!isLogoType(file.type)) return { ok: false, message: t("onboarding.logo.wrongType") };
  if (file.size > LOGO_MAX_INPUT_BYTES) return { ok: false, message: t("onboarding.logo.tooBigInput") };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, message: t("onboarding.logo.cantOpen") };
  }
  const { sx, sy, size } = squareCrop(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = LOGO_SIZE;
  canvas.height = LOGO_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, message: t("onboarding.logo.cantShrink") };
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, size, size, 0, 0, LOGO_SIZE, LOGO_SIZE);
  bitmap.close();
  const encode = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
  let blob = await encode("image/webp");
  if (!blob || blob.type !== "image/webp") blob = await encode("image/png");
  if (!blob) return { ok: false, message: t("onboarding.logo.cantShrink") };
  if (blob.size > LOGO_MAX_BYTES) return { ok: false, message: t("onboarding.logo.tooBig") };
  return { ok: true, blob };
}
