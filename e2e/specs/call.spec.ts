import type { Page } from "@playwright/test";
import { expect, expectAccessible, test, type Fixtures } from "../fixtures";

// A meeting held in a video call: "I ett videosamtal" → "Välj mötesfliken" (a fake
// getDisplayMedia: a 1200 Hz tone as the tab's audio plus a canvas video track) mixed with the
// mic (a fake getUserMedia: a 300 Hz tone). Every audio block sent to (fake) ElevenLabs is
// checked for both tones, so both sources provably reach the STT pipeline. Also: no "Dela
// flikljud" ticked, and the shared tab going away mid-meeting.

const MIC_HZ = 300;
const CALL_HZ = 1200;

/** Installed before any page script. `window.__tabAudio` decides whether the "tab" has audio. */
function fakeCall({ micHz, callHz }: { micHz: number; callHz: number }) {
  const w = window as unknown as {
    __tabAudio: boolean;
    __display: MediaStream | null;
    __heard: { chunks: number; mic: number; call: number };
  };
  w.__tabAudio = true;
  w.__display = null;
  w.__heard = { chunks: 0, mic: 0, call: 0 };
  let ctx: AudioContext | null = null;
  const tone = (hz: number) => {
    ctx ??= new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = hz;
    const gain = ctx.createGain();
    gain.gain.value = 0.3;
    const out = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(out);
    osc.start();
    return out.stream;
  };
  const md = navigator.mediaDevices;
  md.getUserMedia = async () => tone(micHz);
  md.getDisplayMedia = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    canvas.getContext("2d")!.fillRect(0, 0, 16, 16);
    const tracks: MediaStreamTrack[] = [canvas.captureStream(1).getVideoTracks()[0]];
    if (w.__tabAudio) tracks.push(tone(callHz).getAudioTracks()[0]);
    const stream = new MediaStream(tracks);
    w.__display = stream;
    return stream;
  };
  // Goertzel: the amplitude of one frequency in a 16 kHz block.
  const amplitude = (pcm: Float32Array, hz: number) => {
    const k = (2 * Math.PI * hz) / 16_000;
    const coeff = 2 * Math.cos(k);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < pcm.length; i++) {
      const s0 = pcm[i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2))) / pcm.length;
  };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    try {
      if (typeof data === "string" && data.includes("audio_base_64")) {
        const bin = atob((JSON.parse(data) as { audio_base_64: string }).audio_base_64);
        const pcm = new Float32Array(bin.length >> 1);
        for (let i = 0; i < pcm.length; i++) pcm[i] = (((bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) << 16) >> 16) / 32768;
        w.__heard.chunks++;
        if (amplitude(pcm, micHz) > 0.05) w.__heard.mic++;
        if (amplitude(pcm, callHz) > 0.05) w.__heard.call++;
      }
    } catch {
      // not ours to judge
    }
    return send.call(this, data);
  };
}

async function freshStarter(seedOrg: Fixtures["seedOrg"], signedIn: Fixtures["signedIn"], newEmail: Fixtures["newEmail"]) {
  const email = newEmail("ordf");
  const org = await seedOrg({ admin: email });
  const { page } = await signedIn(email, org.url);
  await page.addInitScript(fakeCall, { micHz: MIC_HZ, callHz: CALL_HZ });
  return { org, page };
}

/**
 * "Var hålls mötet?" → I ett videosamtal, retried until hydrated: a native radio ticks before
 * hydration without React seeing it, so the choice only counts once the call steps show.
 */
async function chooseCall(page: Page) {
  const room = page.getByRole("radio", { name: "Här i rummet" });
  const call = page.getByRole("radio", { name: "I ett videosamtal (Google Meet m.fl.)" });
  await expect(async () => {
    await room.check({ timeout: 2000 });
    await call.check({ timeout: 2000 });
    await expect(page.getByText("Tryck Välj mötesfliken här nedan.")).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 45_000 });
}

test("video call: tab audio + mic mixed into the transcription, share stopped → paused → shared again", async ({ seedOrg, signedIn, newEmail, db }) => {
  const { org, page } = await freshStarter(seedOrg, signedIn, newEmail);
  await page.goto(org.url);
  await page.getByRole("link", { name: "Starta möte", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Innan ni börjar" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Här i rummet" })).toBeChecked();
  await chooseCall(page);

  // The steps and the drawing of Chrome's dialog; Start waits for the tab.
  await expect(page.getByText("Välj fliken med mötet · bocka i Dela flikljud · tryck Dela.")).toBeVisible();
  await expect(page.getByText("Så ser Chromes delningsruta ut")).toBeVisible();
  // A förening still confirms that everyone in the call knows.
  const consent = page.getByRole("checkbox", { name: "Alla i samtalet vet att mötet transkriberas och kan be om paus" });
  await consent.check();
  await expect(page.getByRole("button", { name: "Starta mötet" })).toBeDisabled();
  await expect(page.getByText("Välj mötesfliken först.")).toBeVisible();

  await page.getByRole("button", { name: "Välj mötesfliken" }).click();
  // Both meters move: the user sees that both sides are heard.
  await expect(page.getByText("Vi hör både dig och samtalet.")).toBeVisible();
  await expect.poll(async () => Number(await page.getByRole("meter", { name: "Ljudnivå: Du" }).getAttribute("aria-valuenow"))).toBeGreaterThan(0);
  await expect.poll(async () => Number(await page.getByRole("meter", { name: "Ljudnivå: Samtalet" }).getAttribute("aria-valuenow"))).toBeGreaterThan(0);
  await expectAccessible(page);

  await page.getByRole("button", { name: "Starta mötet" }).click();
  await expect(page.getByRole("heading", { name: "Namnrunda" })).toBeVisible({ timeout: 30_000 });
  const meetingId = page.url().split("/").at(-1)!;

  // Both tones are in what is sent to ElevenLabs, in the same blocks (one mixed stream).
  await expect
    .poll(async () => {
      const h = await page.evaluate(() => (window as unknown as { __heard: { mic: number; call: number } }).__heard);
      return Math.min(h.mic, h.call);
    }, { timeout: 30_000, message: "blocks with both the mic's and the call's tone" })
    .toBeGreaterThan(10);
  const { data } = await db.from("meetings").select("capture_source").eq("id", meetingId).single();
  expect(data?.capture_source).toBe("call");

  // "Sluta dela" / the tab closed: paused, and asked to share again.
  await page.evaluate(() => {
    const track = (window as unknown as { __display: MediaStream }).__display.getAudioTracks()[0];
    track.stop();
    track.dispatchEvent(new Event("ended"));
  });
  await expect(page.getByText("Mötesfliken delas inte längre")).toBeVisible();
  await expect(page.getByText("Inspelningen är pausad. Dela fliken igen för att fortsätta.")).toBeVisible();
  await page.getByRole("button", { name: "Dela fliken igen" }).click();
  await expect(page.getByText("Mötesfliken delas inte längre")).toHaveCount(0);
  // Recording again: new blocks carry the new tab's tone.
  const before = await page.evaluate(() => (window as unknown as { __heard: { call: number } }).__heard.call);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __heard: { call: number } }).__heard.call), { timeout: 30_000 }).toBeGreaterThan(before + 5);
});

test("video call: no tab audio ticked → a clear instruction, and a retry that works", async ({ seedOrg, signedIn, newEmail }) => {
  const { org, page } = await freshStarter(seedOrg, signedIn, newEmail);
  await page.goto(org.url);
  await page.getByRole("link", { name: "Starta möte", exact: true }).click();
  await chooseCall(page);
  await page.evaluate(() => void ((window as unknown as { __tabAudio: boolean }).__tabAudio = false));

  await page.getByRole("button", { name: "Välj mötesfliken" }).click();
  await expect(page.getByText("Vi får inget ljud från fliken")).toBeVisible();
  await expect(page.getByText(/Rutan Dela flikljud var inte ibockad/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Starta mötet" })).toBeDisabled();
  await expectAccessible(page);

  // Tried again with the box ticked.
  await page.evaluate(() => void ((window as unknown as { __tabAudio: boolean }).__tabAudio = true));
  await page.getByRole("button", { name: "Välj mötesfliken" }).click();
  await expect(page.getByText("Vi får inget ljud från fliken")).toHaveCount(0);
  await expect(page.getByText("Vi hör både dig och samtalet.")).toBeVisible();
});

test("video call in Privat: the user's own responsibility, no announcement", async ({ signedIn, newEmail }) => {
  const { page } = await signedIn(newEmail("privat"), "/privat");
  await page.addInitScript(fakeCall, { micHz: MIC_HZ, callHz: CALL_HZ });
  await page.goto("/privat");
  await page.getByRole("link", { name: "Spela in" }).click();
  await expect(page.getByRole("heading", { name: "Ny inspelning" })).toBeVisible();
  await chooseCall(page);
  await expect(page.getByRole("checkbox", { name: /^Jag spelar in samtalet jag själv deltar i/ })).toBeVisible();
  await expect(page.getByText("Ingen bot ansluter och inget syns för de andra i samtalet.", { exact: false })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Alla i (rummet|samtalet) vet/ })).toHaveCount(0);
});
