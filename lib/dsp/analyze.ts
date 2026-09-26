/**
 * Monophonic transcription engine.
 *
 *  1. YIN fundamental-frequency tracking (FFT-accelerated difference function,
 *     cumulative-mean normalisation, parabolic refinement) over A0..C8.
 *  2. Adaptive noise gate from the frame-energy distribution.
 *  3. Log-magnitude spectral-flux onset detection (used to split repeated notes).
 *  4. Tuning-offset estimation so slightly detuned recordings still land on the grid.
 *  5. Note segmentation with pitch hysteresis (tolerates vibrato / pitch glides).
 *  6. Tempo estimation from the onset-envelope autocorrelation.
 *  7. Chroma extraction for chord and key detection.
 */
import { fft, hann } from "./fft";
import type { AnalysisResult, RawNote } from "../types";

export const ANALYSIS_SR = 22050; // Basic Pitch's native rate; also used by the YIN path
export const HOP = 256; // 11.6 ms
const FRAME = 2048; // YIN frame; integration window W = 1024 -> lowest period 1024 samples (21.5 Hz)
const YIN_W = FRAME / 2;
const YIN_FFT = FRAME * 2;
const FMIN = 27.5; // A0
const FMAX = 4186.01; // C8
const YIN_THRESHOLD = 0.2;
const MIN_NOTE_FRAMES = Math.round((0.064 * ANALYSIS_SR) / HOP); // 64 ms
const MIDI_MIN = 21;
const MIDI_MAX = 108;
const ONSET_LATENCY = 2;

export type Progress = (stage: string, progress: number) => void;

interface PitchTrack {
  midi: Float32Array; // fractional MIDI, 0 = unvoiced
  clarity: Float32Array; // 1 - CMND at the chosen lag
  rmsDb: Float32Array;
  nFrames: number;
}

function frameAt(x: Float32Array, center: number, len: number, out: Float64Array) {
  const start = center - (len >> 1);
  for (let i = 0; i < len; i++) {
    const j = start + i;
    out[i] = j >= 0 && j < x.length ? x[j] : 0;
  }
}

function yinTrack(x: Float32Array, sr: number, onProgress: Progress): PitchTrack {
  const nFrames = Math.max(1, Math.floor(x.length / HOP) + 1);
  const midi = new Float32Array(nFrames);
  const clarity = new Float32Array(nFrames);
  const rmsDb = new Float32Array(nFrames);

  // One lag of headroom below the shortest period so C8 still gets parabolic refinement.
  const minP = Math.max(2, Math.floor(sr / FMAX) - 1);
  const maxP = Math.min(Math.ceil(sr / FMIN), FRAME - YIN_W);

  const frame = new Float64Array(FRAME);
  const re = new Float64Array(YIN_FFT);
  const im = new Float64Array(YIN_FFT);
  const cs = new Float64Array(FRAME + 1);
  const d = new Float64Array(maxP + 2);
  const cmnd = new Float64Array(maxP + 2);
  const pr = new Float64Array(YIN_FFT);
  const pi = new Float64Array(YIN_FFT);

  for (let t = 0; t < nFrames; t++) {
    // Centre the integration window (first W samples) on the frame time.
    frameAt(x, t * HOP + (FRAME >> 1) - (YIN_W >> 1), FRAME, frame);

    // Energy prefix sums (also give RMS for the gate).
    cs[0] = 0;
    for (let i = 0; i < FRAME; i++) cs[i + 1] = cs[i] + frame[i] * frame[i];
    const e0 = cs[YIN_W];
    rmsDb[t] = 10 * Math.log10(e0 / YIN_W + 1e-12);
    if (e0 < 1e-8) {
      if (t % 512 === 0) onProgress("Tracking pitch", t / nFrames);
      continue;
    }

    // Pack x (real) and its first W samples (imag) into one complex FFT, then
    // cross-correlate: acf[tau] = sum_j y[j] x[j + tau] = IFFT(X * conj(Y)).
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < FRAME; i++) re[i] = frame[i];
    for (let i = 0; i < YIN_W; i++) im[i] = frame[i];
    fft(re, im);
    const N = YIN_FFT;
    // Separate the two spectra and form the cross-spectrum.
    for (let k = 0; k < N; k++) {
      const k2 = (N - k) % N;
      const xr = 0.5 * (re[k] + re[k2]);
      const xi = 0.5 * (im[k] - im[k2]);
      const yr = 0.5 * (im[k] + im[k2]);
      const yi = -0.5 * (re[k] - re[k2]);
      // X * conj(Y)
      pr[k] = xr * yr + xi * yi;
      pi[k] = xi * yr - xr * yi;
    }
    fft(pr, pi, true);

    // Difference function and cumulative mean normalised difference.
    let running = 0;
    cmnd[0] = 1;
    for (let tau = 1; tau <= maxP; tau++) {
      const acf = pr[tau] / N;
      const et = cs[tau + YIN_W] - cs[tau];
      d[tau] = Math.max(0, e0 + et - 2 * acf);
      running += d[tau];
      cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }

    // Absolute threshold: first dip below threshold, then walk to its local minimum.
    let tau = -1;
    for (let k = minP; k <= maxP; k++) {
      if (cmnd[k] < YIN_THRESHOLD) {
        while (k + 1 <= maxP && cmnd[k + 1] < cmnd[k]) k++;
        tau = k;
        break;
      }
    }
    if (tau > 0) {
      let refined = tau;
      if (tau > 1 && tau < maxP) {
        const a = cmnd[tau - 1];
        const b = cmnd[tau];
        const c = cmnd[tau + 1];
        const denom = a - 2 * b + c;
        if (Math.abs(denom) > 1e-12) refined = tau + (0.5 * (a - c)) / denom;
      }
      const f0 = sr / refined;
      midi[t] = 69 + 12 * Math.log2(f0 / 440);
      clarity[t] = 1 - cmnd[tau];
    }
    if (t % 512 === 0) onProgress("Tracking pitch", t / nFrames);
  }
  return { midi, clarity, rmsDb, nFrames };
}

/** STFT magnitude helper that calls back with each frame's magnitude spectrum. */
function stft(
  x: Float32Array,
  n: number,
  hop: number,
  cb: (frameIndex: number, mag: Float64Array) => void,
): number {
  const nFrames = Math.max(1, Math.floor(x.length / hop) + 1);
  const w = hann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const mag = new Float64Array(n / 2 + 1);
  const frame = new Float64Array(n);
  for (let t = 0; t < nFrames; t++) {
    frameAt(x, t * hop, n, frame);
    for (let i = 0; i < n; i++) {
      re[i] = frame[i] * w[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= n / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    cb(t, mag);
  }
  return nFrames;
}

function normalise95(env: Float32Array) {
  const sorted = Float32Array.from(env).sort();
  const scale = sorted[Math.floor(sorted.length * 0.95)] || 1;
  for (let i = 0; i < env.length; i++) env[i] /= scale;
}

/**
 * Log spectral flux on the same hop grid as the pitch track, normalised. `full` sees every
 * attack (snare, hats, notes); `low` only the band below 150 Hz (kick drum, bass).
 */
export function rhythmEnvelopes(x: Float32Array, nFrames: number): { full: Float32Array; low: Float32Array } {
  const n = 1024;
  const lowBins = Math.floor((150 * n) / ANALYSIS_SR);
  const full = new Float32Array(nFrames);
  const low = new Float32Array(nFrames);
  let prev: Float64Array | null = null;
  stft(x, n, HOP, (t, mag) => {
    const cur = new Float64Array(mag.length);
    for (let k = 0; k < mag.length; k++) cur[k] = Math.log1p(100 * mag[k]);
    if (prev && t < nFrames) {
      let s = 0;
      let sLow = 0;
      for (let k = 1; k < cur.length; k++) {
        const diff = cur[k] - prev[k];
        if (diff > 0) {
          s += diff;
          if (k <= lowBins) sLow += diff;
        }
      }
      full[t] = s;
      low[t] = sLow;
    }
    prev = cur;
  });
  normalise95(full);
  normalise95(low);
  return { full, low };
}

export function onsetEnvelope(x: Float32Array, nFrames: number): Float32Array {
  return rhythmEnvelopes(x, nFrames).full;
}

function pickOnsets(env: Float32Array): Uint8Array {
  const isOnset = new Uint8Array(env.length);
  const wPre = 3;
  const wMean = 10;
  const delta = 0.12;
  let last = -100;
  for (let t = 1; t < env.length - 1; t++) {
    let isMax = true;
    for (let k = Math.max(0, t - wPre); k <= Math.min(env.length - 1, t + wPre); k++) {
      if (env[k] > env[t]) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    let sum = 0;
    let cnt = 0;
    for (let k = Math.max(0, t - wMean); k <= Math.min(env.length - 1, t + wMean); k++) {
      sum += env[k];
      cnt++;
    }
    if (env[t] > sum / cnt + delta && t - last >= 3) {
      // The flux peaks as the attack enters the leading half of the 1024-sample window,
      // ~2 hops before it reaches the frame centre; compensate.
      isOnset[Math.min(env.length - 1, t + ONSET_LATENCY)] = 1;
      last = t;
    }
  }
  return isOnset;
}

export function estimateTempo(env: Float32Array, frameRate: number): number {
  const n = env.length;
  if (n < frameRate * 4) return 120;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  const minLag = Math.floor((60 / 200) * frameRate);
  const maxLag = Math.min(n - 1, Math.ceil((60 / 50) * frameRate));
  let bestLag = 0;
  let best = -Infinity;
  const scores = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += (env[i] - mean) * (env[i + lag] - mean);
    s /= n - lag;
    const bpm = (60 * frameRate) / lag;
    // Log-normal prior centred on 110 BPM (one-octave std), as in common beat trackers.
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110), 2));
    scores[lag] = s * prior;
    if (scores[lag] > best) {
      best = scores[lag];
      bestLag = lag;
    }
  }
  if (!bestLag || best <= 0) return 120;
  let lag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const a = scores[bestLag - 1];
    const b = scores[bestLag];
    const c = scores[bestLag + 1];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > 1e-12) lag = bestLag + (0.5 * (a - c)) / denom;
  }
  let bpm = (60 * frameRate) / lag;
  while (bpm < 70) bpm *= 2;
  while (bpm > 170) bpm /= 2;
  return Math.round(bpm);
}

/**
 * Short RMS level (dB) around frame t — sharp enough to see the dip before a re-attack.
 * The window spans at least 1.5 periods of the note so low notes don't ripple.
 */
function shortLevelDb(x: Float32Array, t: number, win: number): number {
  const c = t * HOP;
  const h = win >> 1;
  let e = 0;
  for (let i = c - h; i < c + h; i++) if (i >= 0 && i < x.length) e += x[i] * x[i];
  return 10 * Math.log10(e / win + 1e-12);
}

function medianFilterVoiced(midi: Float32Array, size: number): Float32Array {
  const out = new Float32Array(midi.length);
  const half = size >> 1;
  const buf: number[] = [];
  for (let t = 0; t < midi.length; t++) {
    if (midi[t] <= 0) continue;
    buf.length = 0;
    for (let k = t - half; k <= t + half; k++) {
      if (k >= 0 && k < midi.length && midi[k] > 0) buf.push(midi[k]);
    }
    buf.sort((a, b) => a - b);
    out[t] = buf[buf.length >> 1];
  }
  return out;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

function segmentNotes(
  midi: Float32Array,
  clarity: Float32Array,
  rmsDb: Float32Array,
  onsets: Uint8Array,
  env: Float32Array,
  x: Float32Array,
  sr: number,
  frameSec: number,
): RawNote[] {
  const n = midi.length;
  const notes: RawNote[] = [];
  let maxDb = -Infinity;
  for (let t = 0; t < n; t++) if (midi[t] > 0 && rmsDb[t] > maxDb) maxDb = rmsDb[t];

  let startF = -1;
  let curNote = 0;

  const close = (endF: number) => {
    if (startF < 0) return;
    const len = endF - startF;
    if (len >= MIN_NOTE_FRAMES) {
      const pitches: number[] = [];
      let clar = 0;
      let peak = -Infinity;
      for (let k = startF; k < endF; k++) {
        if (midi[k] > 0) pitches.push(midi[k]);
        clar += clarity[k];
        if (rmsDb[k] > peak) peak = rmsDb[k];
      }
      const m = Math.round(median(pitches));
      if (m >= MIDI_MIN && m <= MIDI_MAX) {
        const rel = Math.min(1, Math.max(0, (peak - (maxDb - 40)) / 40));
        notes.push({
          midi: m,
          start: startF * frameSec,
          end: endF * frameSec,
          velocity: Math.round(40 + rel * 80),
          confidence: clar / len,
        });
      }
    }
    startF = -1;
  };

  for (let t = 0; t < n; t++) {
    const voiced = midi[t] > 0;
    if (!voiced) {
      close(t);
      continue;
    }
    const r = Math.round(midi[t]);
    if (startF < 0) {
      startF = t;
      curNote = r;
      continue;
    }
    // Pitch change must persist for 3 frames and exceed a hysteresis band (vibrato-tolerant).
    if (Math.abs(midi[t] - curNote) > 0.65) {
      let stable = true;
      for (let k = t; k < Math.min(n, t + 3); k++) {
        if (midi[k] <= 0 || Math.round(midi[k]) !== r) {
          stable = false;
          break;
        }
      }
      if (stable) {
        close(t);
        startF = t;
        curNote = r;
        continue;
      }
    }
    // Re-articulation of the same pitch: a strong onset or an onset with a loudness jump.
    if (onsets[t] && t - startF >= MIN_NOTE_FRAMES) {
      const period = sr / (440 * 2 ** ((curNote - 69) / 12));
      const win = Math.max(256, Math.round(period * 1.5));
      let before = Infinity;
      let after = -Infinity;
      // Rise from the dip just before the attack to the peak just after it.
      for (let k = Math.max(0, t - 3); k <= Math.min(n - 1, t + 1); k++) before = Math.min(before, shortLevelDb(x, k, win));
      for (let k = t; k < Math.min(n, t + 6); k++) after = Math.max(after, shortLevelDb(x, k, win));
      const jump = after - before;
      if ((env[t] > 0.3 && jump > 2.5) || jump > 6) {
        close(t);
        startF = t;
        curNote = r;
      }
    }
  }
  close(n);

  // Merge fragments of the same pitch separated by tiny gaps (breaths, pick noise),
  // unless the second fragment begins with a detected attack.
  const attackAt = (sec: number) => {
    const f = Math.round(sec / frameSec);
    for (let k = Math.max(0, f - 2); k <= Math.min(n - 1, f + 2); k++) if (onsets[k]) return true;
    return false;
  };
  const merged: RawNote[] = [];
  for (const note of notes) {
    const prev = merged[merged.length - 1];
    if (prev && prev.midi === note.midi && note.start - prev.end < 0.035 && !attackAt(note.start)) {
      prev.end = note.end;
      prev.confidence = (prev.confidence + note.confidence) / 2;
      prev.velocity = Math.max(prev.velocity, note.velocity);
    } else merged.push({ ...note });
  }
  return merged;
}

export function chromagram(x: Float32Array, sr: number, tuningCents: number) {
  const n = 4096;
  const hop = 1024;
  const bins: { k: number; pc: number; w: number }[] = [];
  for (let k = 1; k <= n / 2; k++) {
    const f = (k * sr) / n;
    if (f < 60 || f > 2100) continue;
    const p = 69 + 12 * Math.log2(f / 440) - tuningCents / 100;
    const pc = ((Math.round(p) % 12) + 12) % 12;
    // Down-weight bins that sit between semitones.
    const w = Math.cos(Math.PI * (p - Math.round(p))) ** 2;
    bins.push({ k, pc, w });
  }
  const frames: number[][] = [];
  const energy: number[] = [];
  stft(x, n, hop, (_t, mag) => {
    const c = new Array(12).fill(0);
    let e = 0;
    for (const b of bins) {
      const v = mag[b.k] * mag[b.k] * b.w;
      c[b.pc] += v;
      e += v;
    }
    for (let i = 0; i < 12; i++) c[i] = Math.log1p(c[i]);
    frames.push(c);
    energy.push(e);
  });
  const chroma = new Float32Array(frames.length * 12);
  frames.forEach((c, i) => chroma.set(c, i * 12));
  const maxE = Math.max(1e-12, ...energy);
  const chromaEnergy = Float32Array.from(energy, (e) => e / maxE);
  return { chroma, chromaEnergy, chromaHop: hop / sr };
}

/** Remove DC and peak-normalise in place so thresholds are level-independent. */
export function prepareSignal(x: Float32Array, sr: number) {
  if (x.length / sr < 0.5) throw new Error("The audio is too short to analyse (under half a second).");
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= x.length;
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    x[i] -= mean;
    peak = Math.max(peak, Math.abs(x[i]));
  }
  if (peak < 1e-4) throw new Error("The audio appears to be silent. Check your microphone or file.");
  for (let i = 0; i < x.length; i++) x[i] /= peak;
}

/** Monophonic (single melody line) analysis using YIN. Best for voice, whistling, solo lines. */
export function analyze(
  x: Float32Array,
  sr: number,
  originalDuration: number,
  onProgress: Progress,
): AnalysisResult {
  const warnings: string[] = [];
  const duration = x.length / sr;
  prepareSignal(x, sr);

  onProgress("Tracking pitch", 0);
  const track = yinTrack(x, sr, (s, p) => onProgress(s, p * 0.7));

  // Adaptive gate: 45 dB below the loudest frame, raised toward the noise floor when there is
  // one — but never above loud - 20 dB (continuous music has no quiet frames to learn from).
  onProgress("Filtering noise", 0.7);
  const sortedDb = Float32Array.from(track.rmsDb).sort();
  const noiseFloor = sortedDb[Math.floor(sortedDb.length * 0.1)];
  const loud = sortedDb[Math.floor(sortedDb.length * 0.99)];
  const gate = Math.max(loud - 45, Math.min(noiseFloor + 6, loud - 20));
  const raw = new Float32Array(track.nFrames);
  let voicedCount = 0;
  let activeCount = 0;
  for (let t = 0; t < track.nFrames; t++) {
    if (track.rmsDb[t] < gate) continue;
    activeCount++;
    const m = track.midi[t];
    if (m > 0 && m >= MIDI_MIN - 0.5 && m <= MIDI_MAX + 0.5) {
      raw[t] = m;
      voicedCount++;
    }
  }
  // SNR estimate from frames where no pitch was found (background between notes).
  const unvoicedDb: number[] = [];
  for (let t = 0; t < track.nFrames; t++) if (track.midi[t] <= 0) unvoicedDb.push(track.rmsDb[t]);
  if (unvoicedDb.length > track.nFrames * 0.1 && loud - median(unvoicedDb) < 18) {
    warnings.push("Low signal-to-noise ratio detected — results may be unreliable. Try a cleaner recording.");
  }

  // Global tuning offset (circular mean of fractional parts).
  let sx = 0;
  let sy = 0;
  for (let t = 0; t < raw.length; t++) {
    if (raw[t] <= 0) continue;
    const a = 2 * Math.PI * (raw[t] - Math.round(raw[t]));
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  const tuning = voicedCount ? Math.atan2(sy, sx) / (2 * Math.PI) : 0;
  for (let t = 0; t < raw.length; t++) if (raw[t] > 0) raw[t] -= tuning;
  const tuningCents = Math.round(tuning * 100);
  if (Math.abs(tuningCents) > 20) {
    warnings.push(`Recording is tuned ${tuningCents > 0 ? "+" : ""}${tuningCents} cents from A440; notes were corrected to the nearest semitone.`);
  }

  onProgress("Detecting onsets", 0.75);
  const rhythm = rhythmEnvelopes(x, track.nFrames);
  const env = rhythm.full;
  const onsets = pickOnsets(env);

  // Fill 1–2 frame dropouts inside sustained notes (not across new attacks), then median-smooth.
  for (let t = 1; t < raw.length - 2; t++) {
    if (raw[t] > 0 || raw[t - 1] <= 0) continue;
    if (onsets[t] || onsets[t + 1] || onsets[t + 2]) continue;
    const next = raw[t + 1] > 0 ? t + 1 : raw[t + 2] > 0 ? t + 2 : -1;
    if (next > 0 && Math.abs(raw[next] - raw[t - 1]) < 0.5) {
      for (let k = t; k < next; k++) raw[k] = raw[t - 1];
    }
  }
  const smooth = medianFilterVoiced(raw, 5);

  onProgress("Segmenting notes", 0.82);
  const frameSec = HOP / sr;
  const notes = segmentNotes(smooth, track.clarity, track.rmsDb, onsets, env, x, sr, frameSec);

  const voicedRatio = activeCount ? voicedCount / activeCount : 0;
  if (!notes.length) {
    throw new Error(
      "No clear pitched notes were found. The audio may be too noisy, percussive, or quiet. Try a solo instrument or voice.",
    );
  }
  if (voicedRatio < 0.35) {
    warnings.push(
      "Much of the audio has no single clear pitch (chords, drums or noise). Only the dominant melody line is transcribed.",
    );
  }
  const meanConf = notes.reduce((s, n) => s + n.confidence, 0) / notes.length;
  if (meanConf < 0.7) warnings.push("Pitch confidence is low; some notes may be wrong. Faded notes are least certain.");

  onProgress("Estimating tempo", 0.88);
  const tempo = estimateTempo(env, sr / HOP);

  onProgress("Extracting harmony", 0.92);
  const { chroma, chromaEnergy, chromaHop } = chromagram(x, sr, tuningCents);

  onProgress("Finishing", 1);
  return {
    mode: "melody",
    sampleRate: sr,
    groove: { full: rhythm.full, low: rhythm.low, hop: HOP / sr },
    duration,
    originalDuration,
    tempo,
    tuningCents,
    notes,
    chroma,
    chromaHop,
    chromaEnergy,
    voicedRatio,
    warnings,
  };
}
