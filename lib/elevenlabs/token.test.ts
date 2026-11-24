import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useTestEnv } from "@/test/env";

useTestEnv();
const { mintToken, realtimeWsUrl } = await import("./token");

describe("mintToken", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to the realtime_scribe mint with max_session_duration_seconds and xi-api-key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: "tok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await mintToken(14_400)).toBe("tok");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(
      "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe?max_session_duration_seconds=14400",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("el");
  });

  it("throws with ElevenLabs' status and message on an error response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("quota_exceeded", { status: 401 })));
    await expect(mintToken(60)).rejects.toThrow(/ElevenLabs 401: quota_exceeded/);
  });

  it("rejects a non-positive or fractional duration before calling ElevenLabs", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(mintToken(0)).rejects.toThrow(/positive integer/);
    await expect(mintToken(1.5)).rejects.toThrow(/positive integer/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("realtimeWsUrl", () => {
  let url: URL;
  beforeAll(() => {
    url = new URL(realtimeWsUrl());
  });

  it("targets the realtime endpoint with every Task 0 setting", () => {
    expect(url.origin + url.pathname).toBe("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model_id: "scribe_v3_live",
      diarize: "true",
      multilang_mode: "true",
      include_timestamps: "true",
      include_language_detection: "true",
      audio_format: "pcm_16000",
      commit_strategy: "vad",
    });
  });

  it("carries no token and no session duration (both belong to the mint)", () => {
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.searchParams.has("max_session_duration_seconds")).toBe(false);
  });
});
