/**
 * "Easy" (Simply Piano / Simply Guitar style) arrangements of a whole song — whatever
 * instruments it had. Drums can't become notes, so their *rhythm* is kept instead:
 *  - the groove (where the kick / snare / hats hit within a bar) drives the accompaniment;
 *  - piano: right hand plays the melody (one note at a time), left hand plays bass + chord
 *    on the groove — kick hits become bass notes, other hits chord stabs;
 *  - guitar: the chord shapes are strummed on the groove (down on beats, up in between).
 */
import type { AnalysisResult, ChordEvent, GuitarNote, QNote } from "../types";
import { chordName, chordTones, guitarChordShape, midiToName, type ChordQuality } from "./theory";

const BAR = 16;
const TUNING = [40, 45, 50, 55, 59, 64];

export interface Groove {
  /** Positions in the bar (16th steps, on the 8th-note grid) where the accompaniment plays. */
  hits: number[];
  /** Subset of hits carried by the kick drum / bass. */
  bassHits: Set<number>;
}

/**
 * Average rhythm profile over all bars: for each 8th-note position, how strong the attacks
 * are there. The strongest positions (at most four per bar, always including the downbeat)
 * become the accompaniment pattern; positions dominated by low-frequency attacks are bass hits.
 */
export function detectGroove(analysis: AnalysisResult, origin: number, stepSec: number, totalSteps: number): Groove {
  const { full, low, hop } = analysis.groove;
  const prof = new Float64Array(BAR);
  const lowProf = new Float64Array(BAR);
  const peak = (env: Float32Array, t: number) => {
    const f = Math.round(t / hop);
    let m = 0;
    for (let k = f - 2; k <= f + 2; k++) if (k >= 0 && k < env.length) m = Math.max(m, env[k]);
    return m;
  };
  for (let s = 0; s < totalSteps; s++) {
    const t = s * stepSec + origin;
    prof[s % BAR] += peak(full, t);
    lowProf[s % BAR] += peak(low, t);
  }
  const eighths = [0, 2, 4, 6, 8, 10, 12, 14];
  const maxP = Math.max(...eighths.map((p) => prof[p]));
  if (maxP <= 0) return { hits: [0, 4, 8, 12], bassHits: new Set([0, 8]) };

  const ranked = eighths.filter((p) => p !== 0 && prof[p] >= 0.55 * maxP).sort((a, b) => prof[b] - prof[a]);
  let hits = [0, ...ranked.slice(0, 3)].sort((a, b) => a - b);
  // A lone downbeat is too sparse to feel like the song: fall back to a steady pulse.
  if (hits.length < 2) hits = prof[8] >= 0.3 * maxP ? [0, 8] : [0, 4, 8, 12];

  const maxLow = Math.max(...hits.map((p) => lowProf[p]));
  const bassHits = new Set([0, ...hits.filter((p) => maxLow > 0 && lowProf[p] >= 0.7 * maxLow)]);
  return { hits, bassHits };
}

/**
 * The song's main melody as a single line: at every 16th step the highest note sounding
 * ("skyline"). A note only enters the melody where it is actually struck — a held chord tone
 * that is merely uncovered when the tune pauses is accompaniment, so the melody rests there.
 * Stray drum/cymbal pitches are removed and the line is folded into the right-hand range.
 */
export function extractMelody(notes: QNote[], stepSec: number): QNote[] {
  const cands = notes.filter((n) => n.midi >= 55 && n.midi <= 96 && n.confidence >= 0.2);
  if (!cands.length) return [];
  const total = Math.max(...cands.map((n) => n.endStep));
  const top: (QNote | null)[] = new Array(total).fill(null);
  for (const n of cands) {
    for (let s = n.startStep; s < n.endStep; s++) {
      const cur = top[s];
      if (!cur || n.midi > cur.midi) top[s] = n;
    }
  }

  const line: QNote[] = [];
  for (let s = 0; s < total; ) {
    const n = top[s];
    let e = s + 1;
    while (e < total && top[e] === n) e++;
    if (n && s - n.startStep <= 1) line.push({ ...n, startStep: s, endStep: e });
    s = e;
  }

  // Drop isolated leaps (cymbals, noise, octave blips): short notes an octave or more from both neighbours.
  const unblipped = line.filter((n, i) => {
    const prev = line[i - 1];
    const next = line[i + 1];
    const far = (m?: QNote) => !m || Math.abs(m.midi - n.midi) >= 12;
    return !(n.endStep - n.startStep <= 2 && far(prev) && far(next) && (prev || next));
  });

  // Drums re-trigger held notes (a hi-hat splits one sung note in two): join same-pitch pieces
  // at most an 8th apart (a removed blip can leave a hole), up to a beat long in total.
  const cleaned: QNote[] = [];
  for (const n of unblipped) {
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.midi === n.midi && n.startStep - prev.endStep <= 2 && n.endStep - prev.startStep <= 4) {
      prev.endStep = n.endStep;
    } else cleaned.push(n);
  }

  // Right-hand range C4–E6; fill tiny gaps so the line reads legato.
  return cleaned.map((n, i) => {
    let midi = n.midi;
    while (midi < 60) midi += 12;
    while (midi > 88) midi -= 12;
    const next = cleaned[i + 1];
    const endStep = next && next.startStep - n.endStep <= 1 ? Math.max(n.endStep, next.startStep) : n.endStep;
    return {
      ...n,
      midi,
      name: midiToName(midi),
      start: n.startStep * stepSec,
      endStep,
      end: endStep * stepSec,
      velocity: Math.max(70, n.velocity),
    };
  });
}

/** Beginner-friendly chords: 7ths and suspensions become plain major/minor triads. */
export function simplifyChords(chords: ChordEvent[], stepSec: number): ChordEvent[] {
  const simple: Record<ChordQuality, ChordQuality> = {
    maj: "maj",
    min: "min",
    dim: "dim",
    sus2: "maj",
    sus4: "maj",
    "7": "maj",
    maj7: "maj",
    min7: "min",
  };
  const out: ChordEvent[] = [];
  for (const c of chords) {
    const quality = simple[c.quality];
    const last = out[out.length - 1];
    if (last && last.root === c.root && last.quality === quality && last.endStep === c.startStep) {
      last.endStep = c.endStep;
      last.end = c.endStep * stepSec;
    } else out.push({ ...c, quality, ...chordName(c.root, quality) });
  }
  return out;
}

/** Accompaniment slots: groove hits in every bar, plus every chord change (so none is missed). */
function slots(chords: ChordEvent[], groove: Groove, totalSteps: number) {
  const out: { start: number; end: number; chord: ChordEvent; pos: number }[] = [];
  for (let b0 = 0; b0 < totalSteps; b0 += BAR) {
    const positions = new Set(groove.hits.map((p) => b0 + p));
    chords.forEach((c) => c.startStep >= b0 && c.startStep < b0 + BAR && positions.add(c.startStep));
    const sorted = [...positions].sort((a, b) => a - b);
    sorted.forEach((s, i) => {
      const chord = chords.find((c) => s >= c.startStep && s < c.endStep);
      if (!chord) return;
      const end = Math.min(sorted[i + 1] ?? b0 + BAR, chord.endStep, totalSteps);
      if (end > s) out.push({ start: s, end, chord, pos: s - b0 });
    });
  }
  return out;
}

const note = (midi: number, start: number, end: number, stepSec: number, velocity: number): QNote => ({
  midi,
  name: midiToName(midi),
  startStep: start,
  endStep: end,
  start: start * stepSec,
  end: end * stepSec,
  velocity,
  confidence: 1,
});

/** Left hand: bass root (C2–B2) on kick hits and the downbeat, close chord (C3–B3) on the others. */
export function pianoLeftHand(chords: ChordEvent[], groove: Groove, totalSteps: number, stepSec: number): QNote[] {
  const out: QNote[] = [];
  for (const { start, end, chord, pos } of slots(chords, groove, totalSteps)) {
    const downbeat = pos === 0 || chord.startStep === start;
    const bassHit = groove.bassHits.has(pos);
    if (downbeat || bassHit) out.push(note(36 + chord.root, start, end, stepSec, 78));
    if (downbeat || !bassHit) {
      for (const pc of chordTones(chord.root, chord.quality)) out.push(note(48 + pc, start, end, stepSec, 64));
    }
  }
  return out.sort((a, b) => a.startStep - b.startStep || a.midi - b.midi);
}

/** Guitar: the chord's shape strummed on the groove — down on the beat, up on the "and". */
export function guitarStrums(chords: ChordEvent[], groove: Groove, totalSteps: number, stepSec: number): GuitarNote[] {
  const out: GuitarNote[] = [];
  for (const { start, end, chord, pos } of slots(chords, groove, totalSteps)) {
    const shape = guitarChordShape(chord.root, chord.quality);
    const frets = (shape.includes("-") ? shape.split("-") : shape.split("")).map((f) => (f === "x" ? -1 : Number(f)));
    const strum = pos % 4 === 2 ? "up" : "down";
    frets.forEach((fret, string) => {
      if (fret < 0) return;
      out.push({
        ...note(TUNING[string] + fret, start, end, stepSec, strum === "down" ? 80 : 62),
        pos: { string, fret, transposed: 0 },
        strum,
      });
    });
  }
  return out;
}
