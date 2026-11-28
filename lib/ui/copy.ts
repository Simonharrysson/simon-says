// Copying to the clipboard, with the states a copy button shows. Pure apart from the clipboard
// it is given, so every outcome is unit-tested (copy.test.ts).

export type CopyState = "idle" | "copied" | "failed";

/** How long "Kopierad ✓" stays before the button says "Kopiera" again. */
export const COPIED_MS = 2000;

type Clipboard = Pick<globalThis.Clipboard, "writeText">;

/** "copied", or "failed" when there is no clipboard (http, old browser) or it refuses (permissions). */
export async function copyText(value: string, clipboard: Clipboard | undefined | null): Promise<Exclude<CopyState, "idle">> {
  if (!clipboard || typeof clipboard.writeText !== "function") return "failed";
  try {
    await clipboard.writeText(value);
    return "copied";
  } catch {
    return "failed";
  }
}

/** The browser's clipboard, or undefined where reading it throws or there is none. */
export function browserClipboard(): Clipboard | undefined {
  try {
    return typeof navigator === "undefined" ? undefined : navigator.clipboard;
  } catch {
    return undefined;
  }
}
