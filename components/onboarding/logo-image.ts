"use client";

import { LOGO_MAX_BYTES, LOGO_MAX_INPUT_BYTES, LOGO_SIZE, isLogoType, squareCrop } from "@/lib/orgs/logo";

/** The picked image as a centred 256×256 square (WebP, PNG where WebP isn't supported), or a Swedish error. */
export async function squareLogo(file: File): Promise<{ ok: true; blob: Blob } | { ok: false; message: string }> {
  if (!isLogoType(file.type)) return { ok: false, message: "Välj en PNG-, JPEG- eller WebP-bild." };
  if (file.size > LOGO_MAX_INPUT_BYTES) return { ok: false, message: "Bilden är för stor (max 15 MB)." };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, message: "Bilden gick inte att öppna. Prova en annan." };
  }
  const { sx, sy, size } = squareCrop(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = LOGO_SIZE;
  canvas.height = LOGO_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, message: "Bilden gick inte att förminska i den här webbläsaren." };
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, size, size, 0, 0, LOGO_SIZE, LOGO_SIZE);
  bitmap.close();
  const encode = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
  let blob = await encode("image/webp");
  if (!blob || blob.type !== "image/webp") blob = await encode("image/png");
  if (!blob) return { ok: false, message: "Bilden gick inte att förminska i den här webbläsaren." };
  if (blob.size > LOGO_MAX_BYTES) return { ok: false, message: "Bilden är för stor (max 1 MB)." };
  return { ok: true, blob };
}
