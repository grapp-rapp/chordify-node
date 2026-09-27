/**
 * Polyphonic transcription (chords and several notes at once) using Spotify's Basic Pitch
 * model (Apache-2.0) via TensorFlow.js. Tempo and onsets reuse the shared DSP helpers;
 * harmony features come straight from the model's per-key activations.
 */
import type * as tfType from "@tensorflow/tfjs";
import { addPitchBendsToNoteEvents, BasicPitch, noteFramesToTime, outputToNotesPoly } from "@spotify/basic-pitch";
import type { AnalysisResult, RawNote } from "../types";
import { estimateTempo, HOP, prepareSignal, rhythmEnvelopes, type Progress } from "./analyze";

// Basic Pitch timing constants (mirrors its toMidi.ts) — its frames drift slightly per 2 s window.
const BP_SR = 22050;
const BP_HOP = 256;
const ANNOT_N_FRAMES = Math.floor(BP_SR / BP_HOP) * 2;
const AUDIO_N_SAMPLES = BP_SR * 2 - BP_HOP;
const WINDOW_OFFSET = (BP_HOP / BP_SR) * (ANNOT_N_FRAMES - AUDIO_N_SAMPLES / BP_HOP) + 0.0018;
const frameToTime = (f: number) => (f * BP_HOP) / BP_SR - WINDOW_OFFSET * Math.floor(f / ANNOT_N_FRAMES);

const ONSET_THRESHOLD = 0.5;
const FRAME_THRESHOLD = 0.3;
const MIN_NOTE_FRAMES = 5; // ~58 ms, short enough for 16th notes at 120 BPM
const MAX_POLYPHONY = 8;

/**
 * Drops the model's typical false positives:
 *  - octave ghosts: a quieter note 12 semitones below a louder one it sits inside that appears
 *    well after it started (a sub-harmonic under a strong bass note). Octaves that
 *    start together are kept — a quiet upper octave may be a harmonic, but on guitar it is
 *    usually a real, softer string, and it never changes the chord name. Sub-harmonics
 *    (an octave or octave+fifth below) that are quieter and die first are dropped too;
 *  - blips: very short notes nested inside longer sustained notes that are quieter than
 *    them, or that start just as those notes are released (release transients).
 */
function removeArtifacts(input: RawNote[]): RawNote[] {
  // A held note is often split when a related note (e.g. its octave) is struck: the model
  // re-detects it. Re-join same-pitch pieces that touch when the later piece is no louder.
  const notes: RawNote[] = [];
  const open = new Map<number, RawNote>();
  for (const n of [...input].sort((a, b) => a.start - b.start)) {
    const prev = open.get(n.midi);
    if (prev && n.start - prev.end < 0.03 && n.velocity <= prev.velocity * 0.9) {
      prev.end = Math.max(prev.end, n.end);
      continue;
    }
    const copy = { ...n };
    notes.push(copy);
    open.set(n.midi, copy);
  }

  const sustained = (n: RawNote, m: RawNote) => m !== n && m.start <= n.start + 0.03 && m.end >= n.end - 0.08;
  return notes.filter((n) => {
    const around = notes.filter((m) => sustained(n, m));
    const ghost = around.some(
      (m) =>
        n.velocity < m.velocity * 0.85 &&
        // sub-octave appearing under an already-sounding note (a melody note an octave
        // *above* a held chord tone is real, so only notes below count)
        ((m.midi - n.midi === 12 && n.start >= m.start + 0.1) ||
          // sub-harmonics (octave or octave+fifth below) that die before the note above
          ((m.midi - n.midi === 12 || m.midi - n.midi === 19) && n.end < m.end - 0.1)),
    );
    if (ghost) return false;
    if (n.end - n.start < 0.15) {
      const longer = around.filter((m) => m.end - m.start >= 0.3);
      if (longer.length && n.velocity < 0.9 * Math.max(...longer.map((m) => m.velocity))) return false;
      if (longer.some((m) => m.end - n.start < 0.1)) return false;
    }
    return true;
  });
}

export async function analyzePoly(
  x: Float32Array,
  sr: number,
  originalDuration: number,
  loadModel: () => Promise<tfType.GraphModel>,
  onProgress: Progress,
): Promise<AnalysisResult> {
  if (sr !== BP_SR) throw new Error(`Polyphonic analysis needs ${BP_SR} Hz audio`);
  const warnings: string[] = [];
  const duration = x.length / sr;
  prepareSignal(x, sr);

  onProgress("Loading model", 0);
  const model = loadModel();
  await model;
  const bp = new BasicPitch(model);
  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];
  onProgress("Detecting notes", 0.05);
  await bp.evaluateModel(
    x,
    (f, o, c) => {
      for (const row of f) frames.push(row);
      for (const row of o) onsets.push(row);
      for (const row of c) contours.push(row);
    },
    (p) => onProgress("Detecting notes", 0.05 + p * 0.75),
  );

  onProgress("Segmenting notes", 0.82);
  const events = noteFramesToTime(
    addPitchBendsToNoteEvents(
      contours,
      outputToNotesPoly(frames, onsets, ONSET_THRESHOLD, FRAME_THRESHOLD, MIN_NOTE_FRAMES, true, null, null, true, 11),
    ),
  );
  let notes: RawNote[] = events
    .filter((e) => e.durationSeconds > 0 && !(e.durationSeconds < 0.09 && e.amplitude < 0.35))
    .map((e) => ({
      midi: e.pitchMidi,
      start: Math.max(0, e.startTimeSeconds),
      end: Math.max(0, e.startTimeSeconds) + e.durationSeconds,
      velocity: Math.round(Math.min(127, 35 + 92 * Math.min(1, e.amplitude))),
      confidence: Math.min(1, e.amplitude * 1.4),
    }))
    .sort((a, b) => a.start - b.start || a.midi - b.midi);

  notes = removeArtifacts(notes);

  if (!notes.length) {
    throw new Error("No clear notes were found. The audio may be too noisy, percussive, or quiet.");
  }

  // Cap how many notes may start together (keeps the loudest) — dense mixes otherwise become unreadable.
  const kept: RawNote[] = [];
  let dropped = 0;
  for (let i = 0; i < notes.length; ) {
    let j = i;
    while (j < notes.length && notes[j].start - notes[i].start < 0.03) j++;
    const group = notes.slice(i, j);
    if (group.length > MAX_POLYPHONY) {
      group.sort((a, b) => b.velocity - a.velocity);
      dropped += group.length - MAX_POLYPHONY;
      kept.push(...group.slice(0, MAX_POLYPHONY));
    } else kept.push(...group);
    i = j;
  }
  notes = kept.sort((a, b) => a.start - b.start || a.midi - b.midi);

  const notesPerSecond = notes.length / Math.max(1, duration);
  if (notesPerSecond > 14 || dropped > notes.length * 0.1) {
    warnings.push(
      "Very dense audio (full band, drums or heavy effects). Many notes were found; results are clearest on solo piano or guitar.",
    );
  }
  const meanConf = notes.reduce((s, n) => s + n.confidence, 0) / notes.length;
  if (meanConf < 0.45) warnings.push("Note confidence is low; faded notes are the least certain.");

  // Harmony features: per-frame pitch-class energy from the model's key activations,
  // placed on a uniform grid using Basic Pitch's exact frame timing.
  onProgress("Extracting harmony", 0.88);
  const chromaHop = BP_HOP / BP_SR;
  const nBins = Math.ceil(duration / chromaHop) + 1;
  const chroma = new Float32Array(nBins * 12);
  const chromaEnergy = new Float32Array(nBins);
  let active = 0;
  frames.forEach((row, f) => {
    const bin = Math.round(frameToTime(f) / chromaHop);
    if (bin < 0 || bin >= nBins) return;
    let any = false;
    for (let k = 0; k < row.length; k++) {
      const v = row[k];
      if (v < 0.1) continue;
      chroma[bin * 12 + ((21 + k) % 12)] += v;
      chromaEnergy[bin] += v;
      if (v > FRAME_THRESHOLD) any = true;
    }
    if (any) active++;
  });
  let maxE = 1e-9;
  for (const e of chromaEnergy) maxE = Math.max(maxE, e);
  for (let i = 0; i < nBins; i++) chromaEnergy[i] /= maxE;

  onProgress("Estimating tempo", 0.94);
  const nFrames = Math.floor(x.length / HOP) + 1;
  const rhythm = rhythmEnvelopes(x, nFrames);
  const tempo = estimateTempo(rhythm.full, sr / HOP, rhythm.low);

  onProgress("Finishing", 1);
  return {
    mode: "poly",
    sampleRate: sr,
    groove: { full: rhythm.full, low: rhythm.low, hop: HOP / sr },
    duration,
    originalDuration,
    tempo,
    tuningCents: 0,
    notes,
    chroma,
    chromaHop,
    chromaEnergy,
    voicedRatio: frames.length ? active / frames.length : 0,
    warnings,
  };
}
