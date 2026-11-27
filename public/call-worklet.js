// AudioWorklet for a video call (lib/audio/call-capture.ts): two inputs, the user's mic (0) and
// the shared call tab (1). Collects both as mono float samples at the context's own rate into
// 100 ms blocks (sampleRate / 10 frames), in lockstep, and posts { mic, call } per block. The
// main thread meters each and mixes them (lib/audio/call.ts mixBlocks) before resampling to
// 16 kHz PCM16. An input with nothing connected (the tab was closed) counts as silence, so the
// blocks keep coming at the same pace. Plain JS: worklets are loaded by URL, not bundled.
class CallBlocks extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 10);
    this.mic = new Float32Array(this.size);
    this.call = new Float32Array(this.size);
    this.n = 0;
  }

  process(inputs) {
    const mic = inputs[0] || [];
    const call = inputs[1] || [];
    const frames = (mic[0] && mic[0].length) || (call[0] && call[0].length) || 128;
    for (let i = 0; i < frames; i++) {
      this.mic[this.n] = mono(mic, i);
      this.call[this.n] = mono(call, i);
      this.n++;
      if (this.n === this.size) {
        this.port.postMessage({ mic: this.mic, call: this.call }, [this.mic.buffer, this.call.buffer]);
        this.mic = new Float32Array(this.size);
        this.call = new Float32Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
}

function mono(channels, i) {
  const c = channels.length;
  if (c === 0) return 0;
  let v = 0;
  for (let k = 0; k < c; k++) v += channels[k][i] || 0;
  return v / c;
}

registerProcessor("call-blocks", CallBlocks);
