// AudioWorklet: collects mono float samples at the context's own rate into 100 ms blocks
// (sampleRate / 10 frames) and posts each block to the main thread, which resamples it to
// 16 kHz PCM16 (lib/audio/resample.ts). Plain JS: worklets are loaded by URL, not bundled.
class PcmBlocks extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 10);
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channels = input.length;
      const frames = input[0].length;
      for (let i = 0; i < frames; i++) {
        let v = 0;
        for (let c = 0; c < channels; c++) v += input[c][i];
        this.buf[this.n++] = v / channels;
        if (this.n === this.size) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-blocks", PcmBlocks);
