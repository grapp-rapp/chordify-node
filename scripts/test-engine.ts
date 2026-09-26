/**
 * Accuracy check for the transcription engine using synthesized test audio.
 * Run: npm run test:engine
 */
import { analyze, ANALYSIS_SR } from "../lib/dsp/analyze";
import { arrange } from "../lib/music/arrange";
import { midiToName } from "../lib/music/theory";

interface Ref {
  midi: number;
  start: number;
  dur: number;
}

function synth(ref: Ref[], opts: { noise?: number; detuneCents?: number; vibrato?: number; tail?: number } = {}) {
  const total = Math.max(...ref.map((r) => r.start + r.dur)) + (opts.tail ?? 0.5);
  const x = new Float32Array(Math.ceil(total * ANALYSIS_SR));
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (const r of ref) {
    const f = 440 * 2 ** ((r.midi - 69 + (opts.detuneCents ?? 0) / 100) / 12);
    const s0 = Math.floor(r.start * ANALYSIS_SR);
    const n = Math.floor(r.dur * ANALYSIS_SR);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / ANALYSIS_SR;
      const vib = opts.vibrato ? 1 + opts.vibrato * Math.sin(2 * Math.PI * 5.5 * t) : 1;
      phase += (2 * Math.PI * f * vib) / ANALYSIS_SR;
      const env = Math.min(1, t / 0.01) * Math.exp(-t * 1.5) * Math.min(1, (n - i) / (0.01 * ANALYSIS_SR));
      // Piano/guitar-like spectrum: decaying harmonics.
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(h * phase) / (h * h * 0.7 + 0.3);
      x[s0 + i] += 0.4 * env * v;
    }
  }
  if (opts.noise) for (let i = 0; i < x.length; i++) x[i] += opts.noise * rand();
  return x;
}

function melody(midis: number[], beat: number, startAt = 0.25): Ref[] {
  return midis.map((m, i) => ({ midi: m, start: startAt + i * beat, dur: beat * 0.95 }));
}

function score(ref: Ref[], found: { midi: number; start: number }[]) {
  let hits = 0;
  const used = new Set<number>();
  for (const r of ref) {
    const idx = found.findIndex((f, i) => !used.has(i) && f.midi === r.midi && Math.abs(f.start - r.start) < 0.08);
    if (idx >= 0) {
      hits++;
      used.add(idx);
    }
  }
  const precision = found.length ? hits / found.length : 0;
  const recall = hits / ref.length;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { hits, precision, recall, f1 };
}

const twinkle = [60, 60, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60];
const scale = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72];
const cases: { name: string; ref: Ref[]; opts?: Parameters<typeof synth>[1]; tempo: number }[] = [
  { name: "Twinkle @120bpm (clean)", ref: melody(twinkle, 0.5), tempo: 120 },
  { name: "C major scale, 2 octaves, 8ths @100", ref: melody(scale, 0.3), tempo: 100 },
  { name: "Twinkle + noise (SNR ~20 dB)", ref: melody(twinkle, 0.5), opts: { noise: 0.04 }, tempo: 120 },
  { name: "Twinkle detuned +35 cents", ref: melody(twinkle, 0.5), opts: { detuneCents: 35 }, tempo: 120 },
  { name: "Twinkle with vibrato (voice-like)", ref: melody(twinkle, 0.5), opts: { vibrato: 0.012 }, tempo: 120 },
  { name: "Low bass line (A0..E2)", ref: melody([21, 24, 28, 33, 36, 40], 0.6), tempo: 100 },
  { name: "High register (C6..C8)", ref: melody([84, 88, 91, 96, 100, 103, 108], 0.4), tempo: 150 },
  { name: "Repeated notes (re-articulation)", ref: melody([64, 64, 64, 64, 67, 67, 67, 67], 0.25), tempo: 120 },
];

let failures = 0;
for (const c of cases) {
  const x = synth(c.ref, c.opts);
  const t0 = performance.now();
  const res = analyze(x, ANALYSIS_SR, x.length / ANALYSIS_SR, () => {});
  const ms = performance.now() - t0;
  const s = score(c.ref, res.notes);
  const ok = s.f1 >= 0.9;
  if (s.f1 < 1) console.log("   got:", res.notes.map((n) => `${midiToName(n.midi)}@${n.start.toFixed(2)}-${n.end.toFixed(2)}`).join(" "));
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(40)} F1=${s.f1.toFixed(2)} P=${s.precision.toFixed(2)} R=${s.recall.toFixed(2)} ` +
      `tempo=${res.tempo} (true ${c.tempo}) ${ms.toFixed(0)}ms`,
  );
  if (!ok) {
    console.log("   expected:", c.ref.map((r) => midiToName(r.midi)).join(" "));
    console.log("   got:     ", res.notes.map((n) => `${midiToName(n.midi)}@${n.start.toFixed(2)}`).join(" "));
  }
  if (res.warnings.length) console.log("   warnings:", res.warnings.join(" / "));
}

// Arrangement smoke test on the first case.
const x = synth(cases[0].ref);
const res = analyze(x, ANALYSIS_SR, x.length / ANALYSIS_SR, () => {});
const piano = arrange(res, "piano", 120, "full");
const guitar = arrange(res, "guitar", 120, "full");
console.log("\nKey:", piano.key, "| chords:", piano.chords.map((c) => c.name).join(" "));
console.log("MIDI bytes:", piano.midi.length, guitar.midi.length);
console.log("\n" + piano.abc);
console.log("\n" + guitar.text.split("Tablature")[1]);

// Grid alignment: leading silence of an odd length must not shift notes off the beat.
{
  const beat = 60 / 108;
  const ode = [64, 64, 65, 67, 67, 65, 64, 62];
  const xs = synth(melody(ode, beat, 0.3));
  const r = arrange(analyze(xs, ANALYSIS_SR, xs.length / ANALYSIS_SR, () => {}), "piano", undefined, "full");
  const onBeat = r.notes.every((n) => n.startStep % 4 === 0);
  if (!onBeat) failures++;
  console.log(`${onBeat ? "PASS" : "FAIL"}  grid aligned to first beat (starts: ${r.notes.map((n) => n.startStep).join(",")}, tempo ${r.tempo})`);
}

// Speed: 3 minutes of audio.
const long = synth(melody(Array.from({ length: 360 }, (_, i) => twinkle[i % twinkle.length]), 0.5));
const t0 = performance.now();
analyze(long, ANALYSIS_SR, long.length / ANALYSIS_SR, () => {});
console.log(`\n3-minute file analysed in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// Silence must produce a helpful error.
try {
  analyze(new Float32Array(ANALYSIS_SR * 2), ANALYSIS_SR, 2, () => {});
  console.log("FAIL  silence did not raise");
  failures++;
} catch (e) {
  console.log("PASS  silence ->", (e as Error).message);
}
// Pure noise should not yield confident melody.
const noise = synth([{ midi: 60, start: 0, dur: 0.001 }], { noise: 0.3, tail: 3 });
try {
  const r = analyze(noise, ANALYSIS_SR, 3, () => {});
  console.log(`INFO  white noise -> ${r.notes.length} notes, warnings: ${r.warnings.join(" / ")}`);
} catch (e) {
  console.log("PASS  white noise ->", (e as Error).message);
}
process.exit(failures ? 1 : 0);
