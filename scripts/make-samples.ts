/**
 * Generates the demo clip served from /samples: Beethoven's "Ode to Joy" (public domain)
 * with a two-hand arrangement — melody in the right hand, chords in the left.
 * Run: npx tsx scripts/make-samples.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SR = 22050;
const BPM = 108;
const beat = 60 / BPM;

// [midi, beats]
const ODE: [number, number][] = [
  [64, 1], [64, 1], [65, 1], [67, 1], [67, 1], [65, 1], [64, 1], [62, 1],
  [60, 1], [60, 1], [62, 1], [64, 1], [64, 1.5], [62, 0.5], [62, 2],
  [64, 1], [64, 1], [65, 1], [67, 1], [67, 1], [65, 1], [64, 1], [62, 1],
  [60, 1], [60, 1], [62, 1], [64, 1], [62, 1.5], [60, 0.5], [60, 2],
];

// Left hand: one chord per half bar (beats), matching the melody's harmony.
const C = [36, 48, 52, 55];
const G = [31, 47, 50, 55];
const LH: [number[], number][] = [
  [C, 4], [G, 4], [C, 4], [G, 4],
  [C, 4], [G, 4], [C, 4], [G, 2], [C, 2],
];

function render(notes: [number, number][], chords: [number[], number][]): Float32Array {
  const total = notes.reduce((s, [, b]) => s + b, 0) * beat + 1.5;
  const x = new Float32Array(Math.ceil(total * SR));
  const events: [number, number, number, number][] = []; // midi, start, beats, gain
  let t = 0.3;
  for (const [midi, beats] of notes) {
    events.push([midi, t, beats, 0.35]);
    t += beats * beat;
  }
  t = 0.3;
  for (const [pitches, beats] of chords) {
    pitches.forEach((m) => events.push([m, t, beats, 0.16]));
    t += beats * beat;
  }
  for (const [midi, start, beats, gain] of events) {
    const f = 440 * 2 ** ((midi - 69) / 12);
    const dur = beats * beat;
    const s0 = Math.floor(start * SR);
    const n = Math.floor((dur + 0.25) * SR);
    for (let i = 0; i < n && s0 + i < x.length; i++) {
      const tt = i / SR;
      const release = tt > dur * 0.92 ? Math.exp(-(tt - dur * 0.92) * 30) : 1;
      let v = 0;
      for (let h = 1; h <= 8; h++) v += (Math.sin(2 * Math.PI * f * h * Math.sqrt(1 + 0.0004 * h * h) * tt) / h ** 1.4) * Math.exp(-tt * (1 + h * 0.8));
      x[s0 + i] += gain * Math.min(1, tt / 0.004) * release * v;
    }
  }
  // light room noise so the demo isn't unrealistically clean
  let seed = 1;
  for (let i = 0; i < x.length; i++) {
    seed = (seed * 16807) % 2147483647;
    x[i] += 0.002 * ((seed / 2147483647) * 2 - 1);
  }
  return x;
}

function wav(x: Float32Array): Buffer {
  const buf = Buffer.alloc(44 + x.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + x.length * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(x.length * 2, 40);
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  x.forEach((v, i) => buf.writeInt16LE(Math.round((v / peak) * 0.89 * 32767), 44 + i * 2));
  return buf;
}

const dir = join(__dirname, "..", "public", "samples");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "ode-to-joy.wav"), wav(render(ODE, LH)));
console.log("wrote public/samples/ode-to-joy.wav");
