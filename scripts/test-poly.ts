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
import type { QNote } from "../lib/types";

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

// ---------------------------------------------------------------- full band → easy arrangement

function drums(x: Float32Array, beatSec: number, bars: number, t0: number) {
  let seed = 99;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const hit = (start: number, len: number, fn: (t: number) => number) => {
    const s0 = Math.floor(start * SR);
    for (let i = 0; i < len * SR && s0 + i < x.length; i++) x[s0 + i] += fn(i / SR);
  };
  for (let b = 0; b < bars; b++) {
    const bar = t0 + b * 4 * beatSec;
    // Kick on 1, 3 and the "and" of 3: pitch-dropping sine thump.
    for (const beat of [0, 2, 2.5]) {
      hit(bar + beat * beatSec, 0.25, (t) => 0.9 * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 14));
    }
    // Snare on 2 and 4: noise burst + body.
    for (const beat of [1, 3]) {
      hit(bar + beat * beatSec, 0.2, (t) => (0.45 * rnd() + 0.2 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t * 22));
    }
    // Closed hi-hat on every 8th: short bright noise.
    for (let e = 0; e < 8; e++) {
      let prev = 0;
      hit(bar + e * 0.5 * beatSec, 0.05, (t) => {
        const n = rnd();
        const hp = n - prev; // crude high-pass
        prev = n;
        return 0.12 * hp * Math.exp(-t * 80);
      });
    }
  }
}

async function bandCase(check: (ok: boolean, msg: string) => void): Promise<number> {
  const bpm = 100;
  const beat = 60 / bpm;
  const t0 = 0.3;
  const progression = [
    { name: "Cmaj", tones: [60, 64, 67], root: 36 },
    { name: "Gmaj", tones: [59, 62, 67], root: 43 },
    { name: "Amin", tones: [60, 64, 69], root: 45 },
    { name: "Fmaj", tones: [60, 65, 69], root: 41 },
  ];
  const melody = [76, 74, 72, 74, 74, 71, 74, 79, 76, 72, 69, 72, 72, 77, 76, 72];
  const x = new Float32Array(Math.ceil((t0 + 16 * beat + 1) * SR));
  drums(x, beat, 4, t0);
  progression.forEach((c, b) => {
    // Piano pad chords (held bar) and a bass guitar on the kick pattern.
    chord(c.tones, t0 + b * 4 * beat, 4 * beat * 0.97).forEach((r) => pianoTone(x, r, 0.08));
    for (const bt of [0, 2, 2.5]) pluck(x, { midi: c.root, start: t0 + (b * 4 + bt) * beat, dur: 0.45 * beat }, 0.25);
  });
  // Lead line (voice-like: harmonic-rich with gentle vibrato), one note per beat, mixed up front.
  melody.forEach((m, i) => {
    const f = 440 * 2 ** ((m - 69) / 12);
    const s0 = Math.floor((t0 + i * beat) * SR);
    const n = Math.floor(beat * 0.9 * SR);
    let phase = 0;
    for (let k = 0; k < n; k++) {
      const t = k / SR;
      phase += (2 * Math.PI * f * (1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t))) / SR;
      const env = Math.min(1, t / 0.02) * Math.min(1, (n - k) / (0.03 * SR));
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(h * phase) / h;
      x[s0 + k] += 0.2 * env * v;
    }
  });

  const started = performance.now();
  const res = await analyzePoly(x, SR, x.length / SR, loadModel, () => {});
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`\nFull band (drums + bass + piano + lead) → easy arrangement  (${secs}s on CPU, tempo ${res.tempo})`);
  let fails = 0;
  const ok = (cond: boolean, msg: string) => {
    if (!cond) fails++;
    check(cond, msg);
  };
  const arr = arrange(res, "piano", bpm, "easy", 2); // level 2 = plain triads
  const names = arr.chords.map((c) => c.name);
  ok(JSON.stringify(names) === JSON.stringify(progression.map((c) => c.name)), `chords ${names.join(" ")}`);

  // Right hand should be the lead line: one note per beat, exact pitch.
  const rh = arr.treble;
  const found = melody.filter((m, i) => rh.some((n) => n.midi === m && Math.abs(n.startStep - i * 4) <= 1)).length;
  const extra = rh.length - found;
  ok(found >= 14 && extra <= 3, `right-hand melody ${found}/${melody.length} notes, ${extra} extra (drums add no junk)`);
  console.log("      RH:", rh.map((n) => `${n.name}@${n.startStep}`).join(" "));

  // Left hand: bass notes on the kick positions, chords on the snare positions.
  const positions = (f: (n: QNote) => boolean) =>
    [...new Set(arr.bass.filter(f).map((n) => n.startStep % 16))].sort((a, b) => a - b);
  const bassPos = positions((n) => n.midi < 48);
  const chordPos = positions((n) => n.midi >= 48);
  ok(
    bassPos.includes(0) && bassPos.includes(8) && !bassPos.includes(4) && !bassPos.includes(12),
    `left-hand bass follows the kick (positions ${bassPos.join(",")})`,
  );
  ok(chordPos.includes(4) && chordPos.includes(12), `left-hand chords follow the snare (positions ${chordPos.join(",")})`);
  const roots = arr.bass.filter((n) => n.midi < 48 && n.startStep % 16 === 0).map((n) => n.midi % 12);
  ok(JSON.stringify(roots) === JSON.stringify(progression.map((c) => c.root % 12)), "bass plays each chord's root on beat 1");

  const [tune] = abcjs.parseOnly(arr.abc);
  ok(!(tune.warnings ?? []).length, "easy sheet music parses cleanly");

  const g = arrange(res, "guitar", bpm, "easy");
  const l1 = arrange(res, "guitar", bpm, "easy", 1);
  const l2 = arrange(res, "guitar", bpm, "easy", 2);
  for (const a of [l1, l2, g]) {
    ok(a.guitar.length > 0 && a.guitar.every(n => !n.strum), "guitar level " + a.level + " plays picked notes");
    ok(new Set(a.guitar.map(n => n.startStep)).size === a.guitar.length, "one note per attack");
    ok(a.guitar.every((n, i) => !i || a.guitar[i - 1].endStep <= n.startStep), "melody notes do not overlap");
    const tuning = [40, 45, 50, 55, 59, 64];
    ok(a.guitar.every(n => tuning[n.pos.string] + n.pos.fret === n.midi + 12 * n.pos.transposed), "tab matches sounding pitches");
    ok(a.capo === 0 && !a.text.includes("D/U = strum"), "no strum instructions or capo in melody export");
  }
  ok(l1.guitar.every(n => n.pos.fret <= 5) && l2.guitar.every(n => n.pos.fret <= 9), "easy and medium keep low frets");
  ok(l1.guitar.length <= l2.guitar.length && l2.guitar.length <= g.guitar.length, "difficulty adds melody detail");
  const recovered = melody.filter((m, i) => g.guitar.some(n => n.midi % 12 === m % 12 && Math.abs(n.startStep - i * 4) <= 1)).length;
  ok(recovered >= 14, "hard guitar preserves the lead melody: " + recovered + "/16");
  return fails;
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
      const arr = arrange(res, inst, 120, "full");
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
  failures += await bandCase(check);
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll polyphonic checks passed");
  process.exit(failures ? 1 : 0);
}
void main();
