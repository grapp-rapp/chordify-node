/**
 * Turns an instrument-independent analysis into a quantized, instrument-specific
 * arrangement: 16th-note grid, chords, piano clefs + ABC sheet music, guitar
 * string/fret positions + ASCII tab, and a Standard MIDI File. Handles both
 * single-line melodies and polyphonic input (chords / several notes at once).
 * Cheap enough to re-run instantly when the user changes instrument or tempo.
 */
import { Midi } from "@tonejs/midi";
import type {
  AnalysisResult,
  ArrangeStyle,
  Arrangement,
  ChordEvent,
  GuitarNote,
  GuitarPosition,
  Instrument,
  QNote,
} from "../types";
import {
  ALL_QUALITIES,
  chordName,
  chordPrior,
  detectKey,
  guitarChordShape,
  matchChord,
  midiToName,
  TRIADS,
  type ChordQuality,
  type Key,
} from "./theory";
import { MAX_SECONDS } from "../audio";
import { buildTimeMap, type TimeMap } from "./beats";
import { detectGroove, extractMelody, guitarStrums, pianoLeftHand, simplifyChords } from "./easy";

export const STEPS_PER_BAR = 16; // 4/4 in 16th notes
const CHORD_WINDOW = 8; // detect chords every half bar
export const GUITAR_TUNING = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4
export const GUITAR_STRING_NAMES = ["E", "A", "D", "G", "B", "e"];
export const MAX_FRET = 19;
const MAX_HAND_SPAN = 4; // frets between lowest and highest fretted note in one grip
const SPLIT_POINT = 60; // middle C: >= goes to treble clef

function toQNote(midi: number, startStep: number, endStep: number, stepSec: number, velocity: number, confidence: number): QNote {
  return {
    midi,
    name: midiToName(midi),
    startStep,
    endStep,
    start: startStep * stepSec,
    end: endStep * stepSec,
    velocity,
    confidence,
  };
}

function quantize(analysis: AnalysisResult, stepSec: number, map: TimeMap): QNote[] {
  const sorted = [...analysis.notes].sort((a, b) => a.start - b.start || a.midi - b.midi);
  // Snap to the tracked beat grid (follows tempo drift), then lay out at the steady tempo.
  const snap = (n: { start: number; end: number }) => {
    const startStep = Math.max(0, Math.round(map.toStep(n.start)));
    return [startStep, Math.max(startStep + 1, Math.round(map.toStep(n.end)))] as const;
  };

  if (analysis.mode === "melody") {
    // One line: each note ends where the next begins; notes sharing a slot keep the longer.
    const out: (QNote & { rawLen: number })[] = [];
    for (const n of sorted) {
      const [s, e] = snap(n);
      const q = { ...toQNote(n.midi, s, e, stepSec, n.velocity, n.confidence), rawLen: n.end - n.start };
      const prev = out[out.length - 1];
      if (prev && s <= prev.startStep) {
        if (q.rawLen > prev.rawLen) out[out.length - 1] = q;
        continue;
      }
      if (prev && prev.endStep > s) {
        prev.endStep = s;
        prev.end = s * stepSec;
      }
      out.push(q);
    }
    return out.map(({ rawLen, ...rest }) => (void rawLen, rest));
  }

  // Polyphonic: notes overlap freely; only the same pitch can't sound twice at once.
  const out: QNote[] = [];
  const lastByPitch = new Map<number, QNote>();
  for (const n of sorted) {
    const [s, e] = snap(n);
    const prev = lastByPitch.get(n.midi);
    if (prev && prev.endStep > s) {
      if (prev.startStep >= s) {
        prev.endStep = Math.max(prev.endStep, e);
        prev.end = prev.endStep * stepSec;
        prev.velocity = Math.max(prev.velocity, n.velocity);
        continue;
      }
      prev.endStep = s;
      prev.end = s * stepSec;
    }
    const q = toQNote(n.midi, s, e, stepSec, n.velocity, n.confidence);
    out.push(q);
    lastByPitch.set(n.midi, q);
  }
  return out.sort((a, b) => a.startStep - b.startStep || a.midi - b.midi);
}

/**
 * Notation view of polyphonic notes. Notes struck together in one hand are read as a chord
 * held until that hand plays again (bridging gaps up to a beat) — decaying inner voices
 * otherwise fade early and turn one held chord into a cascade of ties, and chord naming
 * would miss tones that are still held (e.g. under the sustain pedal). MIDI keeps raw lengths.
 */
function sustainChords(notes: QNote[], stepSec: number): QNote[] {
  const out = notes.map((n) => ({ ...n }));
  for (const inHand of [(n: QNote) => n.midi >= SPLIT_POINT, (n: QNote) => n.midi < SPLIT_POINT]) {
    const hand = out.filter(inHand);
    const starts = [...new Set(hand.map((n) => n.startStep))].sort((x, y) => x - y);
    starts.forEach((s, k) => {
      const group = hand.filter((n) => n.startStep === s);
      if (group.length < 2) return;
      const maxEnd = Math.max(...group.map((n) => n.endStep));
      const nextOnset = starts[k + 1] ?? Infinity;
      const end = nextOnset - maxEnd <= 4 ? nextOnset : Math.min(maxEnd, nextOnset);
      for (const n of group) {
        const next = nextStartOfPitch(out, n);
        n.endStep = Math.max(n.startStep + 1, Math.min(end, next ?? Infinity));
        n.end = n.endStep * stepSec;
      }
    });
  }
  return out;
}

/** Start step of the next note with the same pitch (a note can't be extended over it). */
function nextStartOfPitch(notes: QNote[], n: QNote): number | null {
  let best: number | null = null;
  for (const m of notes) {
    if (m !== n && m.midi === n.midi && m.startStep > n.startStep && (best === null || m.startStep < best)) best = m.startStep;
  }
  return best;
}

// ---------------------------------------------------------------- chords

function detectChords(
  analysis: AnalysisResult,
  notes: QNote[],
  stepSec: number,
  totalSteps: number,
  key: Key,
  map: TimeMap,
): ChordEvent[] {
  const poly = analysis.mode === "poly";
  const prior = chordPrior(key);
  // A lone melody can't reveal 7ths or suspensions, so melody mode sticks to triads.
  const qualities = poly ? ALL_QUALITIES : TRIADS;
  const windows = Math.ceil(totalSteps / CHORD_WINDOW);
  const raw: ({ root: number; quality: ChordQuality } | null)[] = [];
  let prev: { root: number; quality: ChordQuality } | null = null;
  const nFrames = analysis.chromaEnergy.length;

  for (let w = 0; w < windows; w++) {
    const s0 = w * CHORD_WINDOW;
    const s1 = s0 + CHORD_WINDOW;
    // Chroma frames live on the original audio timeline.
    const t0 = map.toTime(s0);
    const t1 = map.toTime(s1);
    const profile = new Array(12).fill(0);
    let energy = 0;
    let frames = 0;
    const f0 = Math.max(0, Math.floor(t0 / analysis.chromaHop));
    const f1 = Math.min(nFrames, Math.ceil(t1 / analysis.chromaHop));
    for (let f = f0; f < f1; f++) {
      for (let i = 0; i < 12; i++) profile[i] += analysis.chroma[f * 12 + i];
      energy += analysis.chromaEnergy[f];
      frames++;
    }
    const maxP = Math.max(1e-9, ...profile);
    for (let i = 0; i < 12; i++) profile[i] = (profile[i] / maxP) * (poly ? 0.5 : 1);

    // Transcribed notes, weighted by how long they sound in the window.
    const noteProfile = new Array(12).fill(0);
    const bassVotes = new Array(12).fill(0);
    for (let s = s0; s < s1; s++) {
      let lowest = Infinity;
      for (const n of notes) {
        if (n.startStep > s) break;
        if (n.endStep <= s) continue;
        noteProfile[n.midi % 12] += 1;
        if (n.midi < SPLIT_POINT) lowest = Math.min(lowest, n.midi); // bass = below middle C only

      }
      if (lowest < Infinity) bassVotes[lowest % 12]++;
    }
    const maxN = Math.max(...noteProfile);
    if (maxN > 0) for (let i = 0; i < 12; i++) profile[i] += ((poly ? 1 : 0.6) * noteProfile[i]) / maxN;
    const maxBass = Math.max(...bassVotes);
    const bassPc = poly && maxBass > 0 ? bassVotes.indexOf(maxBass) : null;

    const meanEnergy = frames ? energy / frames : 0;
    if ((meanEnergy < 0.003 && maxN === 0) || profile.every((v) => v === 0)) {
      raw.push(null);
      prev = null;
      continue;
    }
    const m = matchChord(profile, { prev, prior, qualities, bassPc });
    if (m.score < 0.25) {
      raw.push(prev);
      continue;
    }
    prev = { root: m.root, quality: m.quality };
    raw.push(prev);
  }

  const chords: ChordEvent[] = [];
  raw.forEach((c, w) => {
    if (!c) return;
    const last = chords[chords.length - 1];
    const startStep = w * CHORD_WINDOW;
    if (last && last.root === c.root && last.quality === c.quality && last.endStep === startStep) {
      last.endStep = startStep + CHORD_WINDOW;
      last.end = last.endStep * stepSec;
      return;
    }
    chords.push({
      root: c.root,
      quality: c.quality,
      ...chordName(c.root, c.quality),
      startStep,
      endStep: startStep + CHORD_WINDOW,
      start: startStep * stepSec,
      end: (startStep + CHORD_WINDOW) * stepSec,
    });
  });
  return chords;
}

// ---------------------------------------------------------------- guitar

interface Grip {
  notes: QNote[];
  pos: GuitarPosition[];
  cost: number;
  hand: number | null; // centre of the fretting hand, null when only open strings
}

/** All playable string assignments for notes struck together (distinct strings, ≤ 4-fret span). */
function gripsFor(notes: QNote[], shifted: { m: number; transposed: number }[]): Grip[] {
  const grips: Grip[] = [];
  const used = new Array(6).fill(false);
  const cur: GuitarPosition[] = [];
  const visit = (i: number, minF: number, maxF: number) => {
    if (i === notes.length) {
      const fretted = cur.filter((p) => p.fret > 0);
      const span = fretted.length ? maxF - minF : 0;
      let cost = span * 0.4;
      for (const p of cur) cost += p.fret * 0.06 + (p.fret === 0 ? -0.15 : 0) + (p.fret > 12 ? 0.5 : 0);
      grips.push({ notes, pos: [...cur], cost, hand: fretted.length ? (minF + maxF) / 2 : null });
      return;
    }
    const { m, transposed } = shifted[i];
    for (let s = 0; s < 6; s++) {
      if (used[s]) continue;
      const fret = m - GUITAR_TUNING[s];
      if (fret < 0 || fret > MAX_FRET) continue;
      const nMin = fret > 0 ? Math.min(minF, fret) : minF;
      const nMax = fret > 0 ? Math.max(maxF, fret) : maxF;
      if (fret > 0 && nMax - nMin > MAX_HAND_SPAN) continue;
      used[s] = true;
      cur.push({ string: s, fret, transposed });
      visit(i + 1, nMin, nMax);
      cur.pop();
      used[s] = false;
    }
  };
  visit(0, Infinity, -Infinity);
  return grips.sort((a, b) => a.cost - b.cost).slice(0, 12);
}

function shiftIntoRange(midi: number) {
  let m = midi;
  let transposed = 0;
  while (m < GUITAR_TUNING[0]) {
    m += 12;
    transposed++;
  }
  while (m > GUITAR_TUNING[5] + MAX_FRET) {
    m -= 12;
    transposed--;
  }
  return { m, transposed };
}

/**
 * Chooses strings/frets for every note. Notes struck together form a grip; a Viterbi search
 * over grips minimises hand movement. If a grip is unplayable (more than six notes, or too
 * wide a stretch), the least important notes are dropped — melody (top) and bass are kept first.
 */
function assignGuitar(notes: QNote[]): { guitar: GuitarNote[]; dropped: number } {
  const groups: QNote[][] = [];
  for (const n of notes) {
    const g = groups[groups.length - 1];
    if (g && g[0].startStep === n.startStep) g.push(n);
    else groups.push([n]);
  }
  let dropped = 0;
  const options: Grip[][] = groups.map((group) => {
    // Importance order: top note, bass note, then loudest.
    const byPitch = [...group].sort((a, b) => b.midi - a.midi);
    const ranked = [byPitch[0], ...(byPitch.length > 1 ? [byPitch[byPitch.length - 1]] : [])];
    byPitch
      .slice(1, -1)
      .sort((a, b) => b.velocity - a.velocity)
      .forEach((n) => ranked.push(n));
    // Octave-shifting can make two notes identical; keep the more important one.
    const seen = new Set<number>();
    let chosen = ranked.filter((n) => {
      const { m } = shiftIntoRange(n.midi);
      if (seen.has(m)) return false;
      seen.add(m);
      return true;
    });
    dropped += ranked.length - chosen.length;
    if (chosen.length > 6) {
      dropped += chosen.length - 6;
      chosen = chosen.slice(0, 6);
    }
    while (chosen.length) {
      const ordered = [...chosen].sort((a, b) => b.midi - a.midi);
      const grips = gripsFor(ordered, ordered.map((n) => shiftIntoRange(n.midi)));
      if (grips.length) return grips;
      chosen = chosen.slice(0, -1);
      dropped++;
    }
    return [];
  });

  const valid = options.map((o, i) => ({ o, i })).filter((x) => x.o.length);
  if (!valid.length) return { guitar: [], dropped };

  const move = (a: Grip, b: Grip, gap: number) => {
    let c: number;
    if (a.hand === null || b.hand === null) c = 0.5;
    else {
      const d = Math.abs(a.hand - b.hand);
      c = d + (d > 4 ? (d - 4) * 1.5 : 0);
    }
    if (a.pos.length === 1 && b.pos.length === 1) c += Math.abs(a.pos[0].string - b.pos[0].string) * 0.25;
    return c * (gap > 1 ? 0.4 : 1); // long gaps give the hand time to relocate
  };

  let cost = valid[0].o.map((g) => g.cost);
  const back: number[][] = [valid[0].o.map(() => -1)];
  for (let k = 1; k < valid.length; k++) {
    const prevGroup = groups[valid[k - 1].i];
    const gap = groups[valid[k].i][0].start - Math.max(...prevGroup.map((n) => n.end));
    const next: number[] = [];
    const ptr: number[] = [];
    for (const b of valid[k].o) {
      let best = Infinity;
      let bi = 0;
      valid[k - 1].o.forEach((a, ai) => {
        const c = cost[ai] + move(a, b, gap);
        if (c < best) {
          best = c;
          bi = ai;
        }
      });
      next.push(best + b.cost);
      ptr.push(bi);
    }
    cost = next;
    back.push(ptr);
  }
  let idx = cost.indexOf(Math.min(...cost));
  const guitar: GuitarNote[] = [];
  for (let k = valid.length - 1; k >= 0; k--) {
    const grip = valid[k].o[idx];
    grip.notes.forEach((n, j) => guitar.push({ ...n, pos: grip.pos[j] }));
    idx = back[k][idx];
  }
  guitar.sort((a, b) => a.startStep - b.startStep || a.pos.string - b.pos.string);
  return { guitar, dropped };
}

// ---------------------------------------------------------------- ABC (sheet music)

const ABC_LETTERS = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
const ABC_SHARP = [false, true, false, true, false, false, true, false, true, false, true, false];
const ABC_DURATIONS = [16, 12, 8, 6, 4, 3, 2, 1];

function abcPitch(midi: number, barAccidentals: Map<string, string>): string {
  const pc = midi % 12;
  const octave = Math.floor(midi / 12) - 1;
  const letter = ABC_LETTERS[pc];
  let body: string;
  if (octave >= 5) body = letter.toLowerCase() + "'".repeat(octave - 5);
  else body = letter + ",".repeat(4 - octave);
  const want = ABC_SHARP[pc] ? "^" : "=";
  const have = barAccidentals.get(body) ?? "=";
  barAccidentals.set(body, want);
  return (want === have ? "" : want) + body;
}

function splitDuration(len: number): number[] {
  const parts: number[] = [];
  while (len > 0) {
    const d = ABC_DURATIONS.find((x) => x <= len)!;
    parts.push(d);
    len -= d;
  }
  return parts;
}

/**
 * One staff's music as ABC bars. Each step holds the set of sounding pitches; the music is
 * cut wherever that set changes, a note is re-struck, a chord symbol starts, or a bar ends.
 * Simultaneous pitches become ABC chords like [CEG]4, with per-note ties where notes continue.
 */
function abcVoice(notes: QNote[], totalSteps: number, chords: ChordEvent[] | null): string[] {
  const chordAt = new Map<number, string>();
  chords?.forEach((c) => chordAt.set(c.startStep, c.symbol));
  const sounding: number[][] = Array.from({ length: totalSteps }, () => []);
  const struck: Set<number>[] = Array.from({ length: totalSteps }, () => new Set());
  for (const n of notes) {
    for (let s = n.startStep; s < Math.min(n.endStep, totalSteps); s++) {
      if (!sounding[s].includes(n.midi)) sounding[s].push(n.midi);
    }
    if (n.startStep < totalSteps) struck[n.startStep].add(n.midi);
  }
  sounding.forEach((set) => set.sort((a, b) => a - b));
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

  const bars: string[] = [];
  for (let b = 0; b * STEPS_PER_BAR < totalSteps; b++) {
    const acc = new Map<string, string>();
    const b0 = b * STEPS_PER_BAR;
    const b1 = b0 + STEPS_PER_BAR;
    let out = "";
    let s = b0;
    while (s < b1) {
      const pitches = sounding[s];
      let e = s + 1;
      while (e < b1 && same(sounding[e], pitches) && !struck[e].size && !chordAt.has(e)) e++;
      const parts = splitDuration(e - s);
      const continues = (p: number) => e < totalSteps && sounding[e].includes(p) && !struck[e].has(p);
      parts.forEach((d, i) => {
        if (i === 0 && chordAt.has(s)) out += `"${chordAt.get(s)}"`;
        const dur = d === 1 ? "" : String(d);
        if (!pitches.length) {
          out += `z${dur}`;
          return;
        }
        const lastPart = i === parts.length - 1;
        const tokens = pitches.map((p) => abcPitch(p, acc) + (!lastPart || continues(p) ? "-" : ""));
        if (tokens.length === 1) {
          const tied = tokens[0].endsWith("-");
          out += tokens[0].replace(/-$/, "") + dur + (tied ? "-" : "");
        } else out += `[${tokens.join("")}]${dur}`;
      });
      out += " ";
      s = e;
    }
    bars.push(out.trim());
  }
  return bars;
}

function buildAbc(treble: QNote[], bass: QNote[], chords: ChordEvent[], totalSteps: number, tempo: number): string {
  const v1 = abcVoice(treble, totalSteps, chords);
  const v2 = abcVoice(bass, totalSteps, null);
  const lines = [
    "X:1",
    "T:ChordifyNode Transcription",
    "M:4/4",
    "L:1/16",
    `Q:1/4=${tempo}`,
    "%%score {V1 | V2}",
    'V:V1 clef=treble name="RH"',
    'V:V2 clef=bass name="LH"',
    "K:C",
  ];
  const barsPerLine = 4;
  for (let i = 0; i < v1.length; i += barsPerLine) {
    const end = i + barsPerLine >= v1.length ? " |]" : " |";
    lines.push(`[V:V1] ${v1.slice(i, i + barsPerLine).join(" | ")}${end}`);
    lines.push(`[V:V2] ${v2.slice(i, i + barsPerLine).join(" | ")}${end}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- text exports

const CELL = 3;

export function buildTabLines(guitar: GuitarNote[], chords: ChordEvent[], totalSteps: number, barsPerLine = 2): string[] {
  const bars = Math.ceil(totalSteps / STEPS_PER_BAR);
  const cellAt = new Map<string, string>(); // "step:string" -> fret
  guitar.forEach((g) => cellAt.set(`${g.startStep}:${g.pos.string}`, String(g.pos.fret)));
  const strumAt = new Map<number, string>();
  guitar.forEach((g) => g.strum && strumAt.set(g.startStep, g.strum === "down" ? "D" : "U"));
  const chordAt = new Map<number, string>();
  chords.forEach((c) => chordAt.set(c.startStep, c.symbol));
  const out: string[] = [];
  for (let b0 = 0; b0 < bars; b0 += barsPerLine) {
    const bEnd = Math.min(bars, b0 + barsPerLine);
    let chordLine = "  ";
    let strumLine = "  ";
    const rows = GUITAR_STRING_NAMES.map((n) => `${n}|`);
    for (let b = b0; b < bEnd; b++) {
      for (let s = b * STEPS_PER_BAR; s < (b + 1) * STEPS_PER_BAR; s++) {
        const c = chordAt.get(s);
        if (c) chordLine = chordLine.padEnd(rows[0].length) + c + " ";
        for (let str = 0; str < 6; str++) rows[str] += (cellAt.get(`${s}:${str}`) ?? "").padEnd(CELL, "-");
        strumLine += (strumAt.get(s) ?? "").padEnd(CELL, " ");
      }
      for (let str = 0; str < 6; str++) rows[str] += "|";
      strumLine += " ";
    }
    out.push(chordLine.trimEnd(), ...rows.reverse());
    if (strumAt.size) out.push(strumLine.trimEnd());
    out.push("");
  }
  return out;
}

const DURATION_LABELS: Record<number, string> = {
  1: "1/16",
  2: "1/8",
  3: "dotted 1/8",
  4: "1/4",
  6: "dotted 1/4",
  8: "1/2",
  12: "dotted 1/2",
  16: "whole",
};

function describeNotes(notes: QNote[]): string[] {
  const lines: string[] = [];
  let bar = -1;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) lines.push(`  Bar ${bar + 1}: ${buf.join("  ")}`);
    buf = [];
  };
  for (let i = 0; i < notes.length; ) {
    const group = [notes[i]];
    while (i + group.length < notes.length && notes[i + group.length].startStep === notes[i].startStep) {
      group.push(notes[i + group.length]);
    }
    i += group.length;
    const n = group[0];
    const b = Math.floor(n.startStep / STEPS_PER_BAR);
    if (b !== bar) {
      flush();
      bar = b;
    }
    const beat = ((n.startStep % STEPS_PER_BAR) / 4 + 1).toFixed(2).replace(/\.?0+$/, "");
    const len = Math.max(...group.map((g) => g.endStep - g.startStep));
    const names = group.length > 1 ? `[${group.map((g) => g.name).join(" ")}]` : n.name;
    buf.push(`${names} (beat ${beat}, ${DURATION_LABELS[len] ?? `${len}/16`})`);
  }
  flush();
  return lines.length ? lines : ["  (none)"];
}

function buildText(a: Omit<Arrangement, "text" | "midi">): string {
  const header = [
    "ChordifyNode Transcription",
    "==========================",
    `Instrument: ${a.instrument === "piano" ? "Piano" : "Guitar (standard tuning EADGBE)"}   Style: ${
      a.style === "full"
        ? "full transcription"
        : a.instrument === "piano"
          ? "easy arrangement (melody + chords on the song's rhythm)"
          : "easy arrangement (strummed chords on the song's rhythm)"
    }`,
    `Tempo: ${a.tempo} BPM   Time: 4/4   Key (estimated): ${a.key}`,
    `Notes: ${a.notes.length}   Length: ${a.duration.toFixed(1)}s`,
    "",
    "Chord progression:",
    a.chords.length
      ? "  " +
        a.chords
          .map(
            (c) =>
              `${c.name}${a.instrument === "guitar" ? ` [${guitarChordShape(c.root, c.quality)}]` : ""} @ bar ${Math.floor(c.startStep / STEPS_PER_BAR) + 1}`,
          )
          .join(" | ")
      : "  (none detected)",
    "",
  ];
  if (a.instrument === "guitar") {
    const legend = a.guitar.some((g) => g.strum) ? " D = strum down, U = strum up" : "";
    return [...header, `Tablature (each dash = 1/16 note):${legend}`, "", ...buildTabLines(a.guitar, a.chords, a.totalSteps)].join("\n");
  }
  return [
    ...header,
    "Treble clef (right hand):",
    ...describeNotes(a.treble),
    "",
    "Bass clef (left hand):",
    ...describeNotes(a.bass),
    "",
    "ABC notation:",
    a.abc,
  ].join("\n");
}

function buildMidi(a: Omit<Arrangement, "text" | "midi">): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(a.tempo);
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [4, 4] });
  midi.header.name = "ChordifyNode Transcription";
  const tracks: [string, QNote[]][] =
    a.instrument === "piano"
      ? [
          ["Piano RH", a.treble],
          ["Piano LH", a.bass],
        ]
      : [["Guitar", a.guitar.map((g) => ({ ...g, midi: g.midi + 12 * g.pos.transposed }))]];
  tracks.forEach(([name, notes], i) => {
    const t = midi.addTrack();
    t.name = name;
    t.channel = i;
    t.instrument.number = a.instrument === "piano" ? 0 : 25; // Acoustic Grand / Acoustic Guitar (steel)
    for (const n of notes) {
      // Strummed strings sound a few ms apart: low→high on a downstroke, high→low on an upstroke.
      const g = n as GuitarNote;
      const spread = g.strum ? 0.012 * (g.strum === "down" ? g.pos.string : 5 - g.pos.string) : 0;
      t.addNote({ midi: n.midi, time: n.start + spread, duration: Math.max(0.05, n.end - n.start - spread), velocity: n.velocity / 127 });
    }
  });
  return midi.toArray();
}

export function arrange(
  analysis: AnalysisResult,
  instrument: Instrument,
  tempoOverride?: number,
  style: ArrangeStyle = "easy",
): Arrangement {
  const tempo = Math.min(240, Math.max(40, Math.round(tempoOverride ?? analysis.tempo)));
  const stepSec = 60 / tempo / 4;
  const map = buildTimeMap(analysis, tempo);
  const notes = quantize(analysis, stepSec, map);
  const lastStep = notes.reduce((m, n) => Math.max(m, n.endStep), 0);
  const totalSteps = Math.max(STEPS_PER_BAR, Math.ceil(lastStep / STEPS_PER_BAR) * STEPS_PER_BAR);

  // Key from note durations blended with the overall chroma.
  const profile = new Array(12).fill(0);
  notes.forEach((n) => (profile[n.midi % 12] += n.endStep - n.startStep));
  const maxNote = Math.max(1e-9, ...profile);
  const chromaSum = new Array(12).fill(0);
  for (let i = 0; i < analysis.chroma.length; i++) chromaSum[i % 12] += analysis.chroma[i];
  const maxChroma = Math.max(1e-9, ...chromaSum);
  for (let i = 0; i < 12; i++) profile[i] = profile[i] / maxNote + (0.5 * chromaSum[i]) / maxChroma;
  const key = detectKey(profile);
  const notation = analysis.mode === "poly" ? sustainChords(notes, stepSec) : notes;
  const detected = detectChords(analysis, notation, stepSec, totalSteps, key, map);
  const chords = style === "easy" ? simplifyChords(detected, stepSec, key) : detected;

  let treble = notes.filter((n) => n.midi >= SPLIT_POINT);
  let bass = notes.filter((n) => n.midi < SPLIT_POINT);
  let notationTreble = notation.filter((n) => n.midi >= SPLIT_POINT);
  let notationBass = notation.filter((n) => n.midi < SPLIT_POINT);
  let outNotes = notes;
  let guitar: GuitarNote[] = [];
  let dropped = 0;

  if (style === "full") {
    if (instrument === "guitar") ({ guitar, dropped } = assignGuitar(notes));
  } else {
    // Whole song (any instruments, drums included) → one playable part:
    // the melody plus chords played on the song's own groove.
    const groove = detectGroove(analysis, map, totalSteps);
    if (instrument === "piano") {
      treble = notationTreble = extractMelody(notes, stepSec);
      bass = notationBass = pianoLeftHand(chords, groove, totalSteps, stepSec);
      outNotes = [...treble, ...bass].sort((a, b) => a.startStep - b.startStep || a.midi - b.midi);
    } else {
      guitar = guitarStrums(chords, groove, totalSteps, stepSec);
      outNotes = guitar;
    }
  }

  const warnings = [...analysis.warnings];
  if (analysis.originalDuration > MAX_SECONDS + 0.5) {
    warnings.unshift(`Only the first ${MAX_SECONDS / 60} minutes of the ${Math.round(analysis.originalDuration)}s file were transcribed.`);
  }
  if (instrument === "guitar" && style === "full") {
    const moved = guitar.filter((g) => g.pos.transposed !== 0).length;
    if (moved) warnings.push(`${moved} note(s) were outside the guitar's range and were shifted by an octave.`);
    if (dropped) warnings.push(`${dropped} note(s) couldn't be fingered on guitar (too many or too wide a stretch) and were left out of the tab.`);
  }

  const base = {
    instrument,
    style,
    tempo,
    stepSec,
    stepsPerBar: STEPS_PER_BAR,
    totalSteps,
    duration: totalSteps * stepSec,
    key: key.name,
    notes: outNotes,
    chords,
    treble,
    bass,
    guitar,
    abc: buildAbc(notationTreble, notationBass, chords, totalSteps, tempo),
    warnings,
  };
  const text = buildText({ ...base, treble: notationTreble, bass: notationBass });
  return { ...base, text, midi: buildMidi(base) };
}
