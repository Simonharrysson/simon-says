import { ImageResponse } from "next/og";
import landing from "@/lib/i18n/messages/sv/landing.json";
import { headlineFont, wordmarkFont } from "@/lib/og/fonts";
import { appOrigin } from "@/lib/origin";

// The share card for every page (Twitter reuses it: app/twitter-image.tsx): the landing's hero in
// one frame, the headline beside the finished example meeting (the demo's end state) with the
// summary mail on its way. Swedish: link previews are fetched without the language cookie. Built
// once at build time.

export const alt = landing.demo.label;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const ink = "#171717";
const ink2 = "#4d4d4d";
const docGrey = "#5f6368";
const green = "#137333";

export default async function OpengraphImage() {
  const d = landing.demo;
  const heading = (text: string) => (
    <div style={{ marginTop: 20, paddingBottom: 6, borderBottom: "1px solid #e0e0e0", fontSize: 13, letterSpacing: 1, color: docGrey, textTransform: "uppercase" }}>{text}</div>
  );
  const check = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={green} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12.5l5 5L20 6.5" />
    </svg>
  );
  const line = (mark: "check" | "box" | "done", text: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 9, fontSize: 17, color: mark === "done" ? docGrey : "#202124" }}>
      {mark === "check" ? (
        check
      ) : mark === "done" ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 15, height: 15, borderRadius: 3, background: green }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 12.5l5 5L20 6.5" />
          </svg>
        </div>
      ) : (
        <div style={{ width: 15, height: 15, border: `2px solid ${docGrey}`, borderRadius: 3 }} />
      )}
      {text}
    </div>
  );
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#fafafa", padding: "56px 64px", fontFamily: "Geist", color: ink }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 520 }}>
          <div style={{ fontFamily: "Instrument Serif", fontSize: 42, letterSpacing: -0.5 }}>Simon Says</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <div style={{ fontSize: 70, lineHeight: 1.0, letterSpacing: -2.6 }}>{landing.heroTitle}</div>
            <div style={{ fontSize: 24, lineHeight: 1.35, color: ink2 }}>{landing.freeLine}</div>
          </div>
          <div style={{ fontSize: 20, color: ink2 }}>{new URL(appOrigin()).host}</div>
        </div>
        <div style={{ display: "flex", flex: 1, position: "relative", alignItems: "center", justifyContent: "flex-end", background: "#f2f2f2", borderRadius: 28, marginLeft: 40, padding: 32 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              width: "100%",
              background: "#ffffff",
              borderRadius: 6,
              padding: "30px 30px 40px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.12), 0 12px 32px -12px rgba(0,0,0,0.25)",
            }}
          >
            <div style={{ fontSize: 26, color: "#202124" }}>{d.docTitle}</div>
            <div style={{ marginTop: 4, fontSize: 14, color: "#b3261e" }}>{d.docLive}</div>
            <div style={{ marginTop: 10, fontSize: 15, color: docGrey }}>{d.attendance}</div>
            {heading(d.decisions)}
            {line("check", d.d1)}
            {line("check", d.d2)}
            {heading(d.tasks)}
            {line("box", `${d.t1Who}: ${d.t1What} (${d.t1When})`)}
            {line("done", `${d.t2Who}: ${d.t2What} (${d.t2When}) – ${d.doneMark.replace("✓", "").trim()}`)}
          </div>
          <div
            style={{
              position: "absolute",
              right: 44,
              bottom: 30,
              display: "flex",
              alignItems: "center",
              gap: 12,
              background: ink,
              color: "#fff",
              borderRadius: 999,
              padding: "10px 22px 10px 12px",
              boxShadow: "0 12px 30px -10px rgba(0,0,0,0.45)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 999, background: "#107d32" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
                <path d="M4 7l8 6 8-6" />
              </svg>
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 16 }}>{d.mailTitle}</div>
              <div style={{ fontSize: 13, opacity: 0.75 }}>{d.mailTo}</div>
            </div>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: [await headlineFont(), await wordmarkFont()] },
  );
}
