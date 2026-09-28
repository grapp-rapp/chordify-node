/**
 * "Easy" (Simply Piano / Simply Guitar style) arrangements of a whole song — whatever
 * instruments it had. Drums can't become notes, so their *rhythm* is kept instead:
 *  - the groove (where the kick / snare / hats hit within a bar) drives the accompaniment;
 *  - piano: right hand plays the melody (one note at a time), left hand plays bass + chord
 *    on the groove — kick hits become bass notes, other hits chord stabs;
 *  - guitar: a single picked melody, with note density and fret range set by difficulty.
 */
import type { AnalysisResult, ChordEvent, GuitarNote, QNote } from "../types";
import type { TimeMap } from "./beats";
import { chordName, chordTones, guitarChordShape, midiToName, type ChordQuality, type Key } from "./theory";

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
export function detectGroove(analysis: AnalysisResult, map: TimeMap, totalSteps: number): Groove {
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
    const t = map.toTime(s);
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

/** Quality of the triad built on `root` within the key's scale (null if root isn't in the scale). */
function diatonicTriad(root: number, key: Key): ChordQuality | null {
  const deg = (root - key.tonic + 12) % 12;
  const table: Record<number, ChordQuality> =
    key.mode === "major"
      ? { 0: "maj", 2: "min", 4: "min", 5: "maj", 7: "maj", 9: "min", 11: "dim" }
      : { 0: "min", 2: "dim", 3: "maj", 5: "min", 7: "min", 8: "maj", 10: "maj" };
  return table[deg] ?? null;
}

/**
 * Beginner-friendly chords: 7ths become plain triads, and suspended chords (which have no
 * 3rd, e.g. a melody's D+E read as Dsus2) take the 3rd the key implies — Dm in D minor.
 */
export function simplifyChords(chords: ChordEvent[], stepSec: number, key: Key): ChordEvent[] {
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
    const quality =
      c.quality === "sus2" || c.quality === "sus4"
        ? (diatonicTriad(c.root, key) === "min" ? "min" : "maj")
        : simple[c.quality];
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

// ---------------------------------------------------------------- guitar levels

/**
 * 1 = Easy: sparse melody, frets 0–5.
 * 2 = Medium: eighth-note detail, frets 0–9.
 * 3 = Hard: full extracted melody, frets 0–19.
 * Chord helpers below remain available for the optional accompaniment reference.
 */
export type Level = 1 | 2 | 3;

/** Beginner "mini" chords: top three strings only (low E → high e). */
const MINI_SHAPES: Record<string, string> = {
  "0maj": "xxx010",
  "2maj": "xxx232",
  "4maj": "xxx100",
  "5maj": "xxx211",
  "7maj": "xxx003",
  "9maj": "xxx220",
  "2min": "xxx231",
  "4min": "xxx000",
  "9min": "xxx210",
};

/** Intermediate: the classic open chords, with small four-string shapes instead of barres. */
const OPEN_SHAPES: Record<string, string> = {
  "0maj": "x32010",
  "2maj": "xx0232",
  "4maj": "022100",
  "5maj": "xx3211",
  "7maj": "320003",
  "9maj": "x02220",
  "2min": "xx0231",
  "4min": "022000",
  "9min": "x02210",
};

export function parseShape(shape: string): number[] {
  return (shape.includes("-") ? shape.split("-") : shape.split("")).map((f) => (f === "x" ? -1 : Number(f)));
}

/**
 * Finds the easiest grip that plays every note of the chord on the given (adjacent) strings:
 * low frets, at most 3 fingers (notes on the lowest fret can share a finger), ≤ 3-fret stretch.
 */
function searchShape(root: number, quality: ChordQuality, strings: number[], maxFret = 7): string | null {
  const tones = chordTones(root, quality);
  let best: { frets: number[]; cost: number } | null = null;
  const frets = new Array(6).fill(-1);
  const visit = (k: number) => {
    if (k === strings.length) {
      const pcs = new Set(strings.map((s) => (TUNING[s] + frets[s]) % 12));
      if (!tones.every((t) => pcs.has(t))) return;
      const fretted = strings.map((s) => frets[s]).filter((f) => f > 0);
      const minF = fretted.length ? Math.min(...fretted) : 0;
      const maxF = fretted.length ? Math.max(...fretted) : 0;
      if (maxF - minF > 3) return;
      const atMin = fretted.filter((f) => f === minF).length;
      const fingers = fretted.length - (atMin > 1 ? atMin - 1 : 0);
      if (fingers > 3) return;
      const rootInBass = (TUNING[strings[0]] + frets[strings[0]]) % 12 === root;
      const cost = fingers + maxF * 0.3 + (rootInBass ? 0 : 0.5);
      if (!best || cost < best.cost) best = { frets: [...frets], cost };
      return;
    }
    const s = strings[k];
    for (let f = 0; f <= maxFret; f++) {
      if (!tones.includes((TUNING[s] + f) % 12)) continue;
      frets[s] = f;
      visit(k + 1);
    }
    frets[s] = -1;
  };
  visit(0);
  const found = best as { frets: number[] } | null;
  return found ? found.frets.map((f) => (f < 0 ? "x" : String(f))).join("") : null;
}

/** The chord shape to show and play at a given level. */
export function levelShape(root: number, quality: ChordQuality, level: Level): string {
  const key = `${root}${quality}`;
  if (level === 1) return MINI_SHAPES[key] ?? searchShape(root, quality, [3, 4, 5], 5) ?? levelShape(root, quality, 2);
  if (level === 2) return OPEN_SHAPES[key] ?? searchShape(root, quality, [2, 3, 4, 5]) ?? guitarChordShape(root, quality);
  return guitarChordShape(root, quality);
}

/** How hard a shape is to play: fingers used, how far up the neck, and whether it's a well-known shape. */
function shapeDifficulty(root: number, quality: ChordQuality, level: Level): number {
  const key = `${root}${quality}`;
  const known = level === 1 ? key in MINI_SHAPES : key in OPEN_SHAPES;
  const fretted = parseShape(levelShape(root, quality, level)).filter((f) => f > 0);
  const maxF = fretted.length ? Math.max(...fretted) : 0;
  const minF = fretted.length ? Math.min(...fretted) : 0;
  return fretted.length + Math.max(0, maxF - 3) + (maxF - minF) * 0.5 + (known ? 0 : 2);
}

/**
 * Picks the capo fret (0–7) that turns the song's chords into the easiest shapes, weighted by how
 * long each chord is played — e.g. Bb F Gm Eb becomes G D Em C with capo 3.
 */
export function chooseCapo(chords: ChordEvent[], level: Level): number {
  if (level === 3 || !chords.length) return 0;
  let best = 0;
  let bestCost = Infinity;
  for (let capo = 0; capo <= 7; capo++) {
    let cost = 0;
    for (const c of chords) cost += shapeDifficulty((c.root - capo + 12) % 12, c.quality, level) * (c.endStep - c.startStep);
    cost *= 1 + capo * 0.03; // prefer no capo / a low capo when it's nearly as easy
    if (cost < bestCost - 1e-9) {
      bestCost = cost;
      best = capo;
    }
  }
  return best;
}

/**
 * Songbook clean-up: a chord heard for less than two bars in the whole song is usually a passing
 * note or a detection blip. It is folded into the chord before it (or after, at the very start).
 */
export function dropRareChords(chords: ChordEvent[], stepSec: number): ChordEvent[] {
  const total = new Map<string, number>();
  for (const c of chords) total.set(c.name, (total.get(c.name) ?? 0) + (c.endStep - c.startStep));
  const common = chords.filter((c) => (total.get(c.name) ?? 0) >= 2 * BAR);
  if (!common.length) return chords;
  const out: ChordEvent[] = [];
  for (const c of chords) {
    const last = out[out.length - 1];
    if ((total.get(c.name) ?? 0) >= 2 * BAR) {
      if (last && last.name === c.name && last.endStep === c.startStep) {
        last.endStep = c.endStep;
        last.end = c.endStep * stepSec;
      } else out.push({ ...c });
    } else if (last && last.endStep === c.startStep) {
      last.endStep = c.endStep;
      last.end = c.endStep * stepSec;
    }
  }
  // A rare chord at the very start: let the first common chord begin there instead.
  if (out.length && chords.length && out[0].startStep > chords[0].startStep) {
    out[0] = { ...out[0], startStep: chords[0].startStep, start: chords[0].startStep * stepSec };
  }
  return out;
}

/** Beginner: keep only the chord that sounds longest in each bar. */
export function onePerBar(chords: ChordEvent[], totalSteps: number, stepSec: number): ChordEvent[] {
  const out: ChordEvent[] = [];
  for (let b0 = 0; b0 < totalSteps; b0 += BAR) {
    let best: ChordEvent | null = null;
    let bestLen = 0;
    for (const c of chords) {
      const len = Math.min(c.endStep, b0 + BAR) - Math.max(c.startStep, b0);
      if (len > bestLen) {
        best = c;
        bestLen = len;
      }
    }
    if (!best) continue;
    const last = out[out.length - 1];
    if (last && last.root === best.root && last.quality === best.quality && last.endStep === b0) {
      last.endStep = b0 + BAR;
      last.end = last.endStep * stepSec;
    } else out.push({ ...best, startStep: b0, endStep: b0 + BAR, start: b0 * stepSec, end: (b0 + BAR) * stepSec });
  }
  return out;
}

/**
 * Guitar strumming for a level: Beginner strums on beats 1 and 3, Intermediate on every beat,
 * Advanced copies the song's groove (down on the beat, up on the "and").
 */
export function guitarStrums(
  chords: ChordEvent[],
  groove: Groove,
  totalSteps: number,
  stepSec: number,
  level: Level = 3,
  capo = 0,
): GuitarNote[] {
  const pattern: Groove =
    level === 1 ? { hits: [0, 8], bassHits: new Set() } : level === 2 ? { hits: [0, 4, 8, 12], bassHits: new Set() } : groove;
  const out: GuitarNote[] = [];
  for (const { start, end, chord, pos } of slots(chords, pattern, totalSteps)) {
    const frets = parseShape(chord.shape ?? levelShape(chord.root, chord.quality, level));
    const strum = level === 3 && pos % 4 === 2 ? "up" : "down";
    frets.forEach((fret, string) => {
      if (fret < 0) return;
      out.push({
        ...note(TUNING[string] + capo + fret, start, end, stepSec, strum === "down" ? 80 : 62),
        pos: { string, fret, transposed: 0 },
        strum,
      });
    });
  }
  return out;
}

/**
 * The song's tune for guitar, simplified by level while keeping what makes it recognisable —
 * its pitch changes:
 *  1 = Easy: repeated notes merged into one, 8th-note grid, frets 0–5.
 *  2 = Medium: the full tune (quick same-note repeats merged), frets 0–9.
 *  3 = Hard: the full tune plus the song's own chord notes sounding under it (up to two),
 *     so real chords appear where the song has them.
 */
export function guitarMelody(notes: QNote[], stepSec: number, level: Level): QNote[] {
  // Lift low-register recordings for the shared melody extractor, preserving pitch classes.
  const source = notes.some((n) => n.midi >= 55 && n.midi <= 96 && n.confidence >= 0.2)
    ? notes
    : notes.map((n) => ({ ...n, midi: n.midi < 55 ? n.midi + 24 : n.midi }));
  let line = extractMelody(source, stepSec).map((n) => ({ ...n }));

  if (level === 1) {
    // 8th-note grid: snap starts; when two notes land on the same 8th, keep the one that was
    // played closest to it (a passing 16th loses to the note on the beat).
    const snapped: (QNote & { off: number })[] = [];
    for (const n of line) {
      const s = Math.round(n.startStep / 2) * 2;
      const e = Math.max(s + 2, Math.round(n.endStep / 2) * 2);
      const off = Math.abs(n.startStep - s);
      const prev = snapped[snapped.length - 1];
      if (prev && prev.startStep === s) {
        if (off < prev.off || (off === prev.off && e - s > prev.endStep - prev.startStep)) {
          snapped[snapped.length - 1] = { ...n, startStep: s, endStep: e, off };
        }
        continue;
      }
      if (prev && prev.endStep > s) prev.endStep = s;
      snapped.push({ ...n, startStep: s, endStep: e, off });
    }
    line = snapped.map(({ off, ...n }) => (void off, n));
  }

  // Merge repeated notes of the same pitch: Easy merges every repeat (up to a beat's gap),
  // Medium only quick ones, Hard keeps every attack.
  if (level < 3) {
    const maxGap = level === 1 ? 4 : 1;
    const maxLen = level === 1 ? 16 : 4;
    const merged: QNote[] = [];
    for (const n of line) {
      const prev = merged[merged.length - 1];
      if (prev && prev.midi === n.midi && n.startStep - prev.endStep <= maxGap && n.endStep - prev.startStep <= maxLen) {
        prev.endStep = n.endStep;
      } else merged.push(n);
    }
    line = merged;
  }

  // One octave shift for the whole line (so the contour stays intact), chosen from the tune's
  // typical range rather than a single stray high note.
  const ceiling = level === 1 ? 69 : level === 2 ? 76 : 83;
  const sorted = line.map((n) => n.midi).sort((x, y) => x - y);
  const typicalTop = sorted[Math.floor(sorted.length * 0.9)] ?? 60;
  const shift = Math.max(0, Math.ceil((typicalTop - ceiling) / 12)) * 12;
  const fit = (m: number) => {
    let midi = m - shift;
    while (midi < 40) midi += 12;
    while (midi > ceiling) midi -= 12;
    return midi;
  };

  const out: QNote[] = line.map((n, i) => {
    const midi = fit(n.midi);
    const endStep = Math.max(n.startStep + 1, Math.min(n.endStep, line[i + 1]?.startStep ?? n.endStep));
    return { ...n, midi, name: midiToName(midi), endStep, start: n.startStep * stepSec, end: endStep * stepSec };
  });

  if (level === 3) {
    // The song's own chord notes under the tune: notes struck with a melody note, 3–12
    // semitones below it (not the bass), at most two.
    const harmony: QNote[] = [];
    // Pitches the tune itself plays nearby aren't harmony (they're the tune's own neighbours).
    const tuneNear = (step: number, midi: number) =>
      line.some((t) => Math.abs(t.startStep - step) <= 3 && t.midi === midi);
    for (const m of line) {
      const under = notes
        .filter(
          (h) =>
            Math.abs(h.startStep - m.startStep) <= 1 &&
            h.midi >= 48 &&
            m.midi - h.midi >= 3 &&
            m.midi - h.midi <= 12 &&
            h.midi % 12 !== m.midi % 12 &&
            !tuneNear(m.startStep, h.midi),
        )
        .sort((x, y) => y.velocity - x.velocity)
        .filter((h, i, arr) => arr.findIndex((o) => o.midi % 12 === h.midi % 12) === i)
        .slice(0, 2);
      for (const h of under) {
        const midi = fit(h.midi) >= fit(m.midi) ? fit(h.midi) - 12 : fit(h.midi);
        if (midi < 40) continue;
        const endStep = Math.max(m.startStep + 1, Math.min(h.endStep, m.endStep + 4));
        harmony.push({
          ...h,
          midi,
          name: midiToName(midi),
          startStep: m.startStep,
          endStep,
          start: m.startStep * stepSec,
          end: endStep * stepSec,
        });
      }
    }
    out.push(...harmony);
    out.sort((a, b) => a.startStep - b.startStep || b.midi - a.midi);
  }
  return out;
}
