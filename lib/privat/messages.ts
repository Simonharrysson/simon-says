import type { Notice } from "@/lib/ui/messages";

// `?fel=` / `?klart=` codes of the Privat pages.

const notices: Record<string, Notice> = {
  raderad: { tone: "success", text: "Inspelningen är raderad: anteckningar, transkript och sammanfattning. Ett Google-dokument ligger kvar i Drive." },
  raderat: { tone: "success", text: "Sammanhanget och alla inspelningar i det är raderade." },
  aktiv: { tone: "danger", text: "En inspelning pågår. Avsluta den först, sedan kan du radera." },
  active: { tone: "danger", text: "Inspelningen pågår. Avsluta den först, sedan kan du radera den." },
  forbidden: { tone: "danger", text: "Inspelningen gick inte att radera. Ladda om sidan och försök igen." },
  not_found: { tone: "danger", text: "Inspelningen finns inte längre." },
};

export function privatNotice(fel?: string, klart?: string): Notice | null {
  return (fel && notices[fel]) || (klart && notices[klart]) || null;
}
