import { ImageResponse } from "next/og";
import { wordmarkFont } from "./fonts";

/** The app icon: the wordmark's "S" in Instrument Serif, light on ink. */
export async function iconImage(px: number, radius: number): Promise<ImageResponse> {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#171717",
          borderRadius: radius,
          color: "#fafafa",
          fontFamily: "Instrument Serif",
          fontSize: px * 0.78,
          lineHeight: 1,
          paddingBottom: px * 0.06,
        }}
      >
        S
      </div>
    ),
    { width: px, height: px, fonts: [await wordmarkFont()] },
  );
}
