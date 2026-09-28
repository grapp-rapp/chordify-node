/**
 * Beat and downbeat tracking, so arrangements follow the real song rather than a rigid grid.
 *
 * Beats: dynamic-programming beat tracker (Ellis 2007, as in librosa) over the onset envelope —
 * it picks the sequence of beats that best matches the attacks while keeping near-constant
 * spacing, so it follows natural tempo drift instead of sliding off after a few bars.
 * Downbeats: of the four possible bar phases, the one where the bass note tends to change,
 * the kick lands, and the snare doesn't (backbeat on 2 and 4).
 */
import type { AnalysisResult, RawNote } from "../types";

export interface TimeMap {
  /** Seconds (original audio) → fractional 16th-note step, 0 = first downbeat. */
  toStep(t: number): number;
  /** Fractional step → seconds on the original audio timeline. */
  toTime(step: number): number;
  /** Average tracked beat length in seconds (the song's real tempo, not rounded). */
  beatPeriod: number;
}

function trackBeats(env: Float32Array, hop: number, bpm: number): number[] {
  const n = env.length;
  const period = 60 / bpm / hop; // frames per beat
  if (n < period * 4) return [];
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  let sd = 0;
  for (const v of env) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / n) || 1;

  // Local score: onset strength smoothed with a narrow Gaussian around each frame.
  const half = Math.round(period);
  const win: number[] = [];
  for (let k = -half; k <= half; k++) win.push(Math.exp(-0.5 * ((k * 32) / period) ** 2));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < n) s += (env[j] / sd) * win[k + half];
    }
    local[i] = s;
  }

  const tightness = 100;
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let arg = -1;
    for (let d = lo; d <= hi; d++) {
      const j = i - d;
      if (j < 0) break;
      const score = cum[j] - tightness * Math.log(d / period) ** 2;
      if (score > best) {
        best = score;
        arg = j;
      }
    }
    cum[i] = local[i] + (arg >= 0 && best > 0 ? best : 0);
    back[i] = arg >= 0 && best > 0 ? arg : -1;
  }

  // Last beat: the best-scoring frame within the final beat period.
  let last = n - 1;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) if (cum[i] > cum[last]) last = i;
  const frames: number[] = [];
  for (let i = last; i >= 0; i = back[i]) frames.push(i);
  frames.reverse();
  // The flux peaks ~2 hops before an attack reaches the frame centre (see analyze.ts).
  return frames.map((f) => (f + 2) * hop);
}

/** Beat index (fractional) of time t, extrapolating beyond the tracked beats. */
function beatIndexOf(beats: number[], t: number, spacing: number): number {
  if (t <= beats[0]) return (t - beats[0]) / spacing;
  const lastI = beats.length - 1;
  if (t >= beats[lastI]) return lastI + (t - beats[lastI]) / spacing;
  let lo = 0;
  let hi = lastI;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - beats[lo]) / (beats[hi] - beats[lo]);
}

function timeOfBeat(beats: number[], b: number, spacing: number): number {
  const lastI = beats.length - 1;
  if (b <= 0) return beats[0] + b * spacing;
  if (b >= lastI) return beats[lastI] + (b - lastI) * spacing;
  const i = Math.floor(b);
  return beats[i] + (b - i) * (beats[i + 1] - beats[i]);
}

/** Which of the 4 beat phases starts the bar. */
function downbeatPhase(analysis: AnalysisResult, beats: number[], notes: RawNote[]): number {
  const { full, low, hop } = analysis.groove;
  const at = (env: Float32Array, t: number) => {
    const f = Math.round(t / hop);
    let m = 0;
    for (let k = f - 2; k <= f + 2; k++) if (k >= 0 && k < env.length) m = Math.max(m, env[k]);
    return m;
  };
  // Bass pitch class sounding on each beat (lowest note below middle C).
  const bassAt = beats.map((t) => {
    let lowest = Infinity;
    for (const n of notes) if (n.start <= t + 0.05 && n.end > t + 0.05 && n.midi < 60) lowest = Math.min(lowest, n.midi);
    return lowest === Infinity ? -1 : lowest % 12;
  });
  // Drum cues scaled to 0..1 per song, so sparse songs (huge normalised peaks) don't let
  // them outweigh the bass cue.
  const kicks = beats.map((t) => at(low, t));
  const snares = beats.map((t, i) => Math.max(0, at(full, t) - kicks[i]));
  const maxKick = Math.max(1e-9, ...kicks);
  const maxSnare = Math.max(1e-9, ...snares);
  const score = [0, 0, 0, 0];
  const count = [0, 0, 0, 0];
  let lastBass = -1; // last bass heard — a short bass note re-struck after a gap isn't a change
  beats.forEach((_t, i) => {
    const p = i % 4;
    const bassChange = bassAt[i] >= 0 && lastBass >= 0 && bassAt[i] !== lastBass ? 1 : 0;
    if (bassAt[i] >= 0) lastBass = bassAt[i];
    score[p] += 1.5 * bassChange + 0.5 * (kicks[i] / maxKick) - 0.3 * (snares[i] / maxSnare);
    count[p]++;
  });
  const avg = score.map((s, p) => (count[p] ? s / count[p] : -Infinity));
  const best = avg.indexOf(Math.max(...avg));
  // Weak evidence (e.g. a lone melody): start the bar where the music starts.
  const sorted = [...avg].sort((a, b) => b - a);
  if (sorted[0] - sorted[1] < 0.05 && notes.length) {
    const first = Math.min(...notes.map((n) => n.start));
    const spacing = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 0.5;
    return ((Math.round(beatIndexOf(beats, first, spacing)) % 4) + 4) % 4;
  }
  return best;
}

/**
 * Builds the time map for a tempo. Falls back to a constant grid when the song is too short
 * or too sparse to track.
 */
export function buildTimeMap(analysis: AnalysisResult, bpm: number): TimeMap {
  const notes = analysis.notes;
  const spacing = 60 / bpm;
  const firstNote = notes.length ? Math.min(...notes.map((n) => n.start)) : 0;
  // Weight the low band (kick, bass) above the full band: off-beat hi-hats are often the loudest
  // attacks in a mix and would otherwise pull the tracker half a beat off.
  const { full, low, hop } = analysis.groove;
  const env = Float32Array.from(full, (v, i) => v + 1.5 * low[i]);
  let beats = trackBeats(env, hop, bpm);
  if (beats.length < 8) {
    beats = [];
    for (let t = firstNote; t < analysis.duration + spacing; t += spacing) beats.push(t);
  }
  const phase = downbeatPhase(analysis, beats, notes);
  // First bar: the latest downbeat at or before the first note (allowing a small anticipation).
  const firstBeat = beatIndexOf(beats, firstNote, spacing);
  let bar0 = Math.floor((firstBeat + 0.25 - phase) / 4) * 4 + phase;
  if (bar0 > firstBeat + 0.25) bar0 -= 4;
  const beatPeriod = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : spacing;
  return {
    toStep: (t) => (beatIndexOf(beats, t, spacing) - bar0) * 4,
    toTime: (step) => timeOfBeat(beats, step / 4 + bar0, spacing),
    beatPeriod,
  };
}
