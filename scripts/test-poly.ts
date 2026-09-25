/**
 * Polyphonic (chords & several notes at once) accuracy check on synthesized audio.
 * Runs the Basic Pitch model on TensorFlow.js' plain-JS CPU backend, so it takes a minute or two.
 * Run: npm run test:poly
 */
import * as tf from "@tensorflow/tfjs";
import abcjs from "abcjs";
import { readFileSync } from "node:fs";
import { ANALYSIS_SR } from "../lib/dsp/analyze";
import { analyzePoly } from "../lib/dsp/poly";
import { arrange, GUITAR_TUNING } from "../lib/music/arrange";
import { midiToName } from "../lib/music/theory";

const SR = ANALYSIS_SR;
const loadModel = () => {
  const json = JSON.parse(readFileSync("public/model/model.json", "utf8"));
  const bin = readFileSync("public/model/group1-shard1of1.bin");
  return tf.loadGraphModel(
    tf.io.fromMemory({
      modelTopology: json.modelTopology,
      weightSpecs: json.weightsManifest[0].weights,
      weightData: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength),
    }),
  );
};

interface Ref {
  midi: number;
  start: number;
  dur: number;
}

function pianoTone(x: Float32Array, r: Ref, gain = 0.15) {
  const f = 440 * 2 ** ((r.midi - 69) / 12);
  const s0 = Math.floor(r.start * SR);
  const n = Math.floor(r.dur * SR);
  for (let i = 0; i < n && s0 + i < x.length; i++) {
    const t = i / SR;
    const rel = Math.min(1, (n - i) / (0.02 * SR));
    let v = 0;
    for (let h = 1; h <= 8; h++) v += (Math.sin(2 * Math.PI * f * h * Math.sqrt(1 + 0.0004 * h * h) * t) / h ** 1.4) * Math.exp(-t * (1 + h * 0.8));
    x[s0 + i] += gain * Math.min(1, t / 0.004) * rel * v;
  }
}

function pluck(x: Float32Array, r: Ref, gain = 0.2) {
  const N = Math.round(SR / (440 * 2 ** ((r.midi - 69) / 12)) - 0.5);
  const s0 = Math.floor(r.start * SR);
  const len = Math.floor(r.dur * SR);
  const y = new Float32Array(len);
  let seed = r.midi * 7919 + 1;
  for (let i = 0; i <= N && i < len; i++) {
    seed = (seed * 16807) % 2147483647;
    y[i] = (seed / 2147483647) * 2 - 1;
  }
  for (let i = N + 1; i < len; i++) y[i] = 0.996 * 0.5 * (y[i - N] + y[i - N - 1]);
  for (let i = 0; i < len && s0 + i < x.length; i++) x[s0 + i] += gain * y[i] * Math.min(1, (len - i) / (0.02 * SR));
}

const chord = (midis: number[], start: number, dur: number): Ref[] => midis.map((midi) => ({ midi, start, dur }));
const strum = (midis: number[], start: number, dur: number): Ref[] =>
  midis.map((midi, i) => ({ midi, start: start + i * 0.012, dur: dur - i * 0.012 }));
/** Open-chord shape (low E → high e) to MIDI pitches. */
const shape = (s: string) => [...s].map((c, i) => (c === "x" ? -1 : GUITAR_TUNING[i] + Number(c))).filter((m) => m > 0);

const BEAT = 0.5; // 120 BPM
const cases: { name: string; refs: Ref[]; voice: "piano" | "pluck"; chords: string[] }[] = [
  {
    name: "Piano block chords C–G–Am–F (with bass)",
    voice: "piano",
    refs: [
      ...chord([48, 60, 64, 67], 0.25, BEAT * 4),
      ...chord([43, 59, 62, 67], 0.25 + BEAT * 4, BEAT * 4),
      ...chord([45, 60, 64, 69], 0.25 + BEAT * 8, BEAT * 4),
      ...chord([41, 60, 65, 69], 0.25 + BEAT * 12, BEAT * 4),
    ],
    chords: ["Cmaj", "Gmaj", "Amin", "Fmaj"],
  },
  {
    name: "Melody over held chords (two hands)",
    voice: "piano",
    refs: [
      ...chord([48, 55, 64], 0.25, BEAT * 4),
      ...chord([41, 53, 57], 0.25 + BEAT * 4, BEAT * 4),
      ...[72, 74, 76, 79, 77, 76, 74, 72].map((m, i) => ({ midi: m, start: 0.25 + i * BEAT, dur: BEAT * 0.95 })),
    ],
    chords: ["Cmaj", "Fmaj"],
  },
  {
    name: "Seventh chords G7–Cmaj7–Am7–Dm7",
    voice: "piano",
    refs: [
      ...chord([43, 59, 62, 65], 0.25, BEAT * 4),
      ...chord([48, 59, 64, 67], 0.25 + BEAT * 4, BEAT * 4),
      ...chord([45, 60, 64, 67], 0.25 + BEAT * 8, BEAT * 4),
      ...chord([38, 60, 65, 69], 0.25 + BEAT * 12, BEAT * 4),
    ],
    chords: ["G7", "Cmaj7", "Amin7", "Dmin7"],
  },
  {
    name: "Strummed guitar G–C–D–Em (Karplus–Strong)",
    voice: "pluck",
    refs: [
      ...strum(shape("320003"), 0.25, BEAT * 4),
      ...strum(shape("x32010"), 0.25 + BEAT * 4, BEAT * 4),
      ...strum(shape("xx0232"), 0.25 + BEAT * 8, BEAT * 4),
      ...strum(shape("022000"), 0.25 + BEAT * 12, BEAT * 4),
    ],
    chords: ["Gmaj", "Cmaj", "Dmaj", "Emin"],
  },
];

function score(ref: Ref[], found: { midi: number; start: number }[]) {
  const used = new Set<number>();
  let hits = 0;
  for (const r of ref) {
    const i = found.findIndex((f, k) => !used.has(k) && f.midi === r.midi && Math.abs(f.start - r.start) < 0.08);
    if (i >= 0) {
      hits++;
      used.add(i);
    }
  }
  const p = found.length ? hits / found.length : 0;
  const rc = hits / ref.length;
  return { p, r: rc, f1: p + rc ? (2 * p * rc) / (p + rc) : 0 };
}

async function main() {
  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  };
  for (const c of cases) {
    const total = Math.max(...c.refs.map((r) => r.start + r.dur)) + 0.5;
    const x = new Float32Array(Math.ceil(total * SR));
    c.refs.forEach((r) => (c.voice === "piano" ? pianoTone(x, r) : pluck(x, r)));
    const t0 = performance.now();
    const res = await analyzePoly(x, SR, total, loadModel, () => {});
    const secs = (performance.now() - t0) / 1000;
    const s = score(c.refs, res.notes);
    console.log(`\n${c.name}  (${secs.toFixed(1)}s on CPU, tempo ${res.tempo})`);
    check(s.f1 >= 0.8, `notes F1=${s.f1.toFixed(2)} P=${s.p.toFixed(2)} R=${s.r.toFixed(2)}`);
    if (s.f1 < 1) {
      const near = (n: { midi: number; start: number }, r: Ref) => n.midi === r.midi && Math.abs(n.start - r.start) < 0.08;
      const extra = res.notes.filter((n) => !c.refs.some((r) => near(n, r)));
      const missed = c.refs.filter((r) => !res.notes.some((n) => near(n, r)));
      if (extra.length) console.log("      extra: ", extra.map((n) => `${midiToName(n.midi)}@${n.start.toFixed(2)}`).join(" "));
      if (missed.length) console.log("      missed:", missed.map((r) => `${midiToName(r.midi)}@${r.start.toFixed(2)}`).join(" "));
    }

    for (const inst of ["piano", "guitar"] as const) {
      const arr = arrange(res, inst, 120);
      if (inst === "piano") {
        const names = arr.chords.map((ch) => ch.name);
        check(JSON.stringify(names) === JSON.stringify(c.chords), `chords ${names.join(" ")} (expected ${c.chords.join(" ")})`);
        const [tune] = abcjs.parseOnly(arr.abc);
        const warnings = tune.warnings ?? [];
        check(warnings.length === 0, `sheet music parses cleanly${warnings.length ? `: ${warnings.slice(0, 2).join("; ")}` : ""}`);
      } else {
        const byStep = new Map<number, number[]>();
        arr.guitar.forEach((g) => byStep.set(g.startStep, [...(byStep.get(g.startStep) ?? []), g.pos.string]));
        const clash = [...byStep.values()].some((strs) => new Set(strs).size !== strs.length);
        const spans = [...byStep.keys()].map((st) => {
          const frets = arr.guitar.filter((g) => g.startStep === st && g.pos.fret > 0).map((g) => g.pos.fret);
          return frets.length ? Math.max(...frets) - Math.min(...frets) : 0;
        });
        check(!clash && Math.max(...spans) <= 4, `guitar grips playable (${arr.guitar.length} notes, max span ${Math.max(...spans)} frets)`);
        if (c.voice === "pluck") console.log(arr.text.split("Tablature")[1].split("\n").slice(2, 9).join("\n"));
      }
    }
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll polyphonic checks passed");
  process.exit(failures ? 1 : 0);
}
void main();
