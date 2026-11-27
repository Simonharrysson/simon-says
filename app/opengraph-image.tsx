import { ImageResponse } from "next/og";
import landing from "@/lib/i18n/messages/sv/landing.json";
import { headlineFont, wordmarkFont } from "@/lib/og/fonts";
import { appOrigin } from "@/lib/origin";

// The share card for every page (Twitter reuses it: app/twitter-image.tsx). Swedish: link
// previews are fetched without the language cookie. Built once at build time.

export const alt = landing.demoLabel;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const ink = "#171717";
const ink2 = "#4d4d4d";
const docGrey = "#5f6368";

export default async function OpengraphImage() {
  const d = landing.doc;
  const heading = (text: string) => (
    <div style={{ marginTop: 22, paddingBottom: 6, borderBottom: "1px solid #e0e0e0", fontSize: 15, letterSpacing: 1, color: docGrey, textTransform: "uppercase" }}>{text}</div>
  );
  const line = (mark: "check" | "box", text: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10, fontSize: 19, color: "#202124" }}>
      {mark === "check" ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#137333" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 12.5l5 5L20 6.5" />
        </svg>
      ) : (
        <div style={{ width: 16, height: 16, border: `2px solid ${docGrey}`, borderRadius: 3 }} />
      )}
      {text}
    </div>
  );
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#fafafa", padding: "64px 72px", fontFamily: "Geist", color: ink }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 560 }}>
          <div style={{ fontFamily: "Instrument Serif", fontSize: 44, letterSpacing: -0.5 }}>Simon Says</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <div style={{ fontSize: 68, lineHeight: 1.04, letterSpacing: -2 }}>{landing.heroTitle}</div>
            <div style={{ fontSize: 26, lineHeight: 1.35, color: ink2, fontFamily: "Geist" }}>{landing.freeLine}</div>
          </div>
          <div style={{ fontSize: 20, color: ink2 }}>{new URL(appOrigin()).host}</div>
        </div>
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "flex-end" }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              width: 490,
              background: "#ffffff",
              borderRadius: 8,
              padding: "36px 36px 40px",
              boxShadow: "0 0 0 1px rgba(0,0,0,0.08), 0 24px 48px -16px rgba(0,0,0,0.18)",
              transform: "rotate(1.5deg)",
            }}
          >
            <div style={{ fontSize: 30, color: "#202124" }}>{d.title}</div>
            <div style={{ marginTop: 6, fontSize: 16, color: "#b3261e" }}>{d.live}</div>
            {heading(d.decisions)}
            {line("check", d.decision1)}
            {heading(d.todo)}
            {line("box", d.todo1)}
            {line("box", d.todo2)}
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: [await headlineFont(), await wordmarkFont()] },
  );
}
