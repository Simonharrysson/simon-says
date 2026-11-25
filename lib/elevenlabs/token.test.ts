import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useTestEnv } from "@/test/env";

useTestEnv();
const { devWsOverride, mintToken, realtimeWsUrl } = await import("./token");

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
    expect(init.signal).toBeInstanceOf(AbortSignal); // a hung mint times out
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

describe("devWsOverride (fake ElevenLabs for dev)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is off without ELEVENLABS_WS_URL", () => {
    expect(devWsOverride({ NODE_ENV: "development" })).toBeNull();
  });

  it("is used in development and tests", () => {
    expect(devWsOverride({ ELEVENLABS_WS_URL: "ws://localhost:8787/v1/speech-to-text/realtime", NODE_ENV: "development" })).toBe(
      "ws://localhost:8787/v1/speech-to-text/realtime",
    );
  });

  it("is ignored when NODE_ENV or VERCEL_ENV is production", () => {
    const url = "ws://localhost:8787/x";
    expect(devWsOverride({ ELEVENLABS_WS_URL: url, NODE_ENV: "production" })).toBeNull();
    expect(devWsOverride({ ELEVENLABS_WS_URL: url, NODE_ENV: "development", VERCEL_ENV: "production" })).toBeNull();
  });

  it("rejects a non-WebSocket URL", () => {
    expect(() => devWsOverride({ ELEVENLABS_WS_URL: "http://x", NODE_ENV: "development" })).toThrow(/ws:\/\//);
  });

  it("with the override: no real mint, and the WS URL points at the fake with the same settings", async () => {
    vi.stubEnv("ELEVENLABS_WS_URL", "ws://localhost:8787/v1/speech-to-text/realtime");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await mintToken(60)).toMatch(/^fake-/);
    expect(fetchMock).not.toHaveBeenCalled();
    const url = new URL(realtimeWsUrl());
    expect(url.origin + url.pathname).toBe("ws://localhost:8787/v1/speech-to-text/realtime");
    expect(url.searchParams.get("model_id")).toBe("scribe_v3_live");
  });
});
