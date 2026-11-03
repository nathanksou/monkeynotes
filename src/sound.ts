/**
 * Key sounds, synthesized with Web Audio (no sound files to ship or license).
 */
import type { SoundKind } from "./model";

export type KeyType = "char" | "space" | "enter" | "back";

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

function audio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    noise = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

const jitter = (v: number, amount = 0.08) => v * (1 + (Math.random() * 2 - 1) * amount);

function envelope(c: AudioContext, peak: number, decay: number): GainNode {
  const g = c.createGain();
  const t = c.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  g.connect(c.destination);
  return g;
}

function noiseBurst(c: AudioContext, type: BiquadFilterType, freq: number, q: number, peak: number, decay: number): void {
  const src = c.createBufferSource();
  src.buffer = noise;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = jitter(freq);
  f.Q.value = q;
  src.connect(f).connect(envelope(c, peak, decay));
  src.start();
  src.stop(c.currentTime + decay + 0.02);
}

function tone(c: AudioContext, wave: OscillatorType, from: number, to: number, peak: number, decay: number): void {
  const o = c.createOscillator();
  o.type = wave;
  const t = c.currentTime;
  o.frequency.setValueAtTime(jitter(from, 0.04), t);
  o.frequency.exponentialRampToValueAtTime(to, t + decay);
  o.connect(envelope(c, peak, decay));
  o.start();
  o.stop(t + decay + 0.02);
}

export function playKey(kind: SoundKind, volume: number, key: KeyType): void {
  if (kind === "off" || volume <= 0) return;
  let c: AudioContext;
  try {
    c = audio();
  } catch {
    return; // no audio device
  }
  const v = volume * (key === "space" || key === "enter" ? 1.15 : 1);
  switch (kind) {
    case "click":
      noiseBurst(c, "highpass", key === "space" ? 2200 : 3200, 0.7, 0.5 * v, 0.03);
      break;
    case "pop":
      tone(c, "sine", key === "back" ? 500 : key === "space" ? 650 : 900, 220, 0.45 * v, 0.07);
      break;
    case "thock":
      noiseBurst(c, "lowpass", key === "space" ? 700 : 1100, 1, 0.6 * v, 0.05);
      tone(c, "sine", key === "space" ? 120 : 170, 70, 0.4 * v, 0.06);
      break;
    case "typewriter":
      noiseBurst(c, "bandpass", 2500, 1.2, 0.8 * v, 0.04);
      noiseBurst(c, "lowpass", 400, 1, 0.3 * v, 0.06);
      if (key === "enter") {
        tone(c, "sine", 1760, 1750, 0.25 * v, 0.9);
        tone(c, "sine", 2640, 2630, 0.1 * v, 0.7);
      }
      break;
  }
}
