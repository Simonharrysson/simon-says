import type { Notice } from "@/lib/ui/messages";

// `?fel=` / `?klart=` codes of the Privat pages; the words are in the catalog (privat.notices.*).

const tones: Record<string, Notice["tone"]> = {
  raderad: "success",
  raderat: "success",
  aktiv: "danger",
  active: "danger",
  forbidden: "danger",
  not_found: "danger",
};

/** The notice for the page's `?fel=`/`?klart=`, its text from `t("notices.<code>")`. */
export function privatNotice(t: (key: string) => string, fel?: string, klart?: string): Notice | null {
  const code = (fel && tones[fel] && fel) || (klart && tones[klart] && klart);
  return code ? { tone: tones[code], text: t(`notices.${code}`) } : null;
}
