import type { ChordQuality } from "./music/theory";

export type Instrument = "piano" | "guitar";
/** "poly": chords & several notes at once (neural model). "melody": one note at a time (YIN). */
export type DetectMode = "poly" | "melody";

/** A note detected by the analysis engine, in raw (unquantized) seconds. */
export interface RawNote {
  midi: number;
  start: number;
  end: number;
  velocity: number; // 1..127
  confidence: number; // 0..1, mean pitch clarity over the note
}

/** Output of the DSP worker. Instrument-independent; arranged later on the main thread. */
export interface AnalysisResult {
  mode: DetectMode;
  sampleRate: number;
  duration: number; // seconds actually analysed
  originalDuration: number; // seconds in the source file
  tempo: number; // estimated BPM
  tuningCents: number; // detected deviation from A440
  notes: RawNote[];
  /** 12-bin chroma frames (row-major, 12 values per frame). */
  chroma: Float32Array;
  chromaHop: number; // seconds between chroma frames
  chromaEnergy: Float32Array; // per-frame loudness, for no-chord detection
  voicedRatio: number;
  warnings: string[];
}

export interface QNote {
  midi: number;
  name: string; // e.g. "C#4"
  startStep: number; // 16th-note grid index
  endStep: number; // exclusive
  start: number; // seconds, quantized
  end: number;
  velocity: number;
  confidence: number;
}

export interface ChordEvent {
  root: number; // pitch class 0..11
  quality: ChordQuality;
  name: string; // "Amin", "Gmaj", "G7", "Cmaj7"
  symbol: string; // "Am", "G", "G7", "Cmaj7"
  startStep: number;
  endStep: number;
  start: number;
  end: number;
}

export interface GuitarPosition {
  string: number; // 0 = low E ... 5 = high e
  fret: number;
  transposed: number; // octaves shifted to fit the fretboard (0 = none)
}

export interface GuitarNote extends QNote {
  pos: GuitarPosition;
}

export interface Arrangement {
  instrument: Instrument;
  tempo: number;
  stepSec: number;
  stepsPerBar: number;
  totalSteps: number;
  duration: number;
  key: string;
  notes: QNote[];
  chords: ChordEvent[];
  treble: QNote[];
  bass: QNote[];
  guitar: GuitarNote[];
  abc: string;
  text: string; // plain-text export (tab or note list)
  midi: Uint8Array;
  warnings: string[];
}

export type WorkerRequest = {
  type: "analyze";
  mode: DetectMode;
  modelUrl: string;
  samples: Float32Array;
  sampleRate: number;
  originalDuration: number;
};

export type WorkerResponse =
  | { type: "progress"; stage: string; progress: number }
  | { type: "done"; result: AnalysisResult }
  | { type: "error"; message: string };
