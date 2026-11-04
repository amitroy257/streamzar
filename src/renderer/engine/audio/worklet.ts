// AudioWorklet processors. Bundled by Vite as a standalone module (see audioEngine.ts).

declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

const CHUNK = 1024; // frames per message (multiple of the 128-frame render quantum)

/**
 * Captures the program mix. Every message carries the absolute sample-frame index of its first
 * sample, which is the master clock for audio *and* video timestamps.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  private active = false;
  private pendingStart = false;
  private buf = new Float32Array(CHUNK * 2);
  private fill = 0;
  private chunkStart = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ cmd: string }>) => {
      if (e.data.cmd === 'start') this.pendingStart = true;
      else if (e.data.cmd === 'stop') {
        this.active = false;
        this.pendingStart = false;
        this.fill = 0;
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.pendingStart) {
      this.pendingStart = false;
      this.active = true;
      this.fill = 0;
      this.chunkStart = currentFrame;
      this.port.postMessage({ type: 'started', frame: currentFrame, sampleRate });
    }
    if (!this.active) return true;
    const input = inputs[0] ?? [];
    const l = input[0];
    const r = input[1] ?? input[0];
    const n = l ? l.length : 128;
    for (let i = 0; i < n; i++) {
      const o = (this.fill + i) * 2;
      this.buf[o] = l ? l[i] : 0;
      this.buf[o + 1] = r ? r[i] : 0;
    }
    this.fill += n;
    if (this.fill >= CHUNK) {
      const out = this.buf;
      this.port.postMessage({ type: 'audio', frame: this.chunkStart, data: out }, [out.buffer]);
      this.buf = new Float32Array(CHUNK * 2);
      this.chunkStart += CHUNK;
      this.fill = 0;
    }
    return true;
  }
}

interface GateParams {
  openThreshold: number;
  closeThreshold: number;
  attackMs: number;
  holdMs: number;
  releaseMs: number;
}

/** Noise gate in the style of broadcast mixers (open/close hysteresis, attack, hold, release). */
class GateProcessor extends AudioWorkletProcessor {
  private p: GateParams = { openThreshold: -26, closeThreshold: -32, attackMs: 25, holdMs: 200, releaseMs: 150 };
  private open = false;
  private level = 0;
  private gain = 0;
  private held = 0;

  constructor(options: { processorOptions?: Partial<GateParams> }) {
    super();
    Object.assign(this.p, options?.processorOptions ?? {});
    this.port.onmessage = (e: MessageEvent<Partial<GateParams>>) => Object.assign(this.p, e.data);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0] ?? [];
    const output = outputs[0];
    const n = output[0]?.length ?? 128;
    const openT = Math.pow(10, this.p.openThreshold / 20);
    const closeT = Math.pow(10, this.p.closeThreshold / 20);
    const attack = 1 / Math.max(1, (this.p.attackMs / 1000) * sampleRate);
    const release = 1 / Math.max(1, (this.p.releaseMs / 1000) * sampleRate);
    const hold = (this.p.holdMs / 1000) * sampleRate;
    const decay = Math.exp(-1 / (0.01 * sampleRate)); // 10 ms level follower
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < input.length; c++) peak = Math.max(peak, Math.abs(input[c][i]));
      this.level = Math.max(peak, this.level * decay);
      if (this.level >= openT && !this.open) {
        this.open = true;
      } else if (this.level < closeT && this.open) {
        this.held = 0;
        this.open = false;
      }
      if (this.open) {
        this.held = 0;
        this.gain = Math.min(1, this.gain + attack);
      } else {
        this.held++;
        if (this.held > hold) this.gain = Math.max(0, this.gain - release);
      }
      for (let c = 0; c < output.length; c++) {
        const src = input[c] ?? input[0];
        output[c][i] = src ? src[i] * this.gain : 0;
      }
    }
    return true;
  }
}

registerProcessor('streamzar-capture', CaptureProcessor);
registerProcessor('streamzar-gate', GateProcessor);
