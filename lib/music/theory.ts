export const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** Spellings for chord / key names (the most common enharmonic in each case). */
export const ROOT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

export function midiToName(midi: number): string {
  return `${SHARP_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

export function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// ---------------------------------------------------------------- keys

const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface Key {
  tonic: number;
  mode: "major" | "minor";
  name: string;
}

/** Krumhansl–Schmuckler key estimate from a 12-bin pitch-class profile. */
export function detectKey(profile: number[]): Key {
  let best: Key & { score: number } = { score: -Infinity, tonic: 0, mode: "major", name: "C major" };
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, tpl] of [
      ["major", KS_MAJOR],
      ["minor", KS_MINOR],
    ] as const) {
      const rotated = tpl.map((_, i) => tpl[(i - tonic + 12) % 12]);
      const score = correlation(profile, rotated);
      if (score > best.score) best = { score, tonic, mode, name: `${ROOT_NAMES[tonic]} ${mode}` };
    }
  }
  return { tonic: best.tonic, mode: best.mode, name: best.name };
}

// ---------------------------------------------------------------- chords

export type ChordQuality = "maj" | "min" | "dim" | "sus2" | "sus4" | "7" | "maj7" | "min7";

export const QUALITIES: Record<ChordQuality, { intervals: number[]; name: string; symbol: string; penalty: number }> = {
  maj: { intervals: [0, 4, 7], name: "maj", symbol: "", penalty: 0 },
  min: { intervals: [0, 3, 7], name: "min", symbol: "m", penalty: 0 },
  dim: { intervals: [0, 3, 6], name: "dim", symbol: "dim", penalty: 0.1 },
  sus2: { intervals: [0, 2, 7], name: "sus2", symbol: "sus2", penalty: 0.13 },
  sus4: { intervals: [0, 5, 7], name: "sus4", symbol: "sus4", penalty: 0.13 },
  "7": { intervals: [0, 4, 7, 10], name: "7", symbol: "7", penalty: 0.04 },
  maj7: { intervals: [0, 4, 7, 11], name: "maj7", symbol: "maj7", penalty: 0.05 },
  min7: { intervals: [0, 3, 7, 10], name: "min7", symbol: "m7", penalty: 0.05 },
};
export const TRIADS: ChordQuality[] = ["maj", "min"];
export const ALL_QUALITIES = Object.keys(QUALITIES) as ChordQuality[];

export function chordTones(root: number, quality: ChordQuality): number[] {
  return QUALITIES[quality].intervals.map((i) => (root + i) % 12);
}

export function chordName(root: number, quality: ChordQuality) {
  const r = ROOT_NAMES[root];
  const q = QUALITIES[quality];
  return { name: `${r}${q.name}`, symbol: `${r}${q.symbol}` };
}

/**
 * Prior bonus per chord for a key: chords built only from scale tones get a bonus, and the
 * primary chords (I IV V V7 / i iv V V7) a little more — ambiguous input (e.g. a melody
 * alone, which can't tell C from Em) then resolves to the more likely chord.
 */
export function chordPrior(key: Key): Map<string, number> {
  const majTonic = key.mode === "major" ? key.tonic : (key.tonic + 3) % 12;
  const scale = new Set([0, 2, 4, 5, 7, 9, 11].map((d) => (majTonic + d) % 12));
  if (key.mode === "minor") scale.add((key.tonic + 11) % 12); // harmonic-minor leading tone
  const t = key.tonic;
  const primary =
    key.mode === "major"
      ? [`${t}maj`, `${(t + 5) % 12}maj`, `${(t + 7) % 12}maj`, `${(t + 7) % 12}7`]
      : [`${t}min`, `${(t + 5) % 12}min`, `${(t + 7) % 12}maj`, `${(t + 7) % 12}7`];
  const prior = new Map<string, number>();
  for (let root = 0; root < 12; root++) {
    for (const q of ALL_QUALITIES) {
      const id = `${root}${q}`;
      let bonus = chordTones(root, q).every((pc) => scale.has(pc)) ? 0.18 : 0;
      if (primary.includes(id)) bonus += 0.08;
      prior.set(id, bonus);
    }
  }
  return prior;
}

/**
 * Best chord for a pitch-class profile. `prev` adds stickiness, `prior` the key bias, and
 * `bassPc` (lowest sounding pitch class) favours chords rooted on the bass note.
 */
export function matchChord(
  profile: number[],
  opts: {
    prev?: { root: number; quality: ChordQuality } | null;
    prior?: Map<string, number>;
    qualities?: ChordQuality[];
    bassPc?: number | null;
  } = {},
): { root: number; quality: ChordQuality; score: number } {
  const qualities = opts.qualities ?? ALL_QUALITIES;
  let best = { root: 0, quality: "maj" as ChordQuality, score: -Infinity };
  for (let root = 0; root < 12; root++) {
    for (const quality of qualities) {
      const tpl = new Array(12).fill(0);
      chordTones(root, quality).forEach((pc) => (tpl[pc] = 1));
      let score = correlation(profile, tpl) - QUALITIES[quality].penalty;
      if (opts.prev && opts.prev.root === root && opts.prev.quality === quality) score += 0.08;
      score += opts.prior?.get(`${root}${quality}`) ?? 0;
      if (opts.bassPc != null && opts.bassPc === root) score += 0.1;
      if (score > best.score) best = { root, quality, score };
    }
  }
  return best;
}

// ---------------------------------------------------------------- guitar chord shapes

const OPEN_SHAPES: Record<string, string> = {
  "0maj": "x32010",
  "2maj": "xx0232",
  "4maj": "022100",
  "5maj": "133211",
  "7maj": "320003",
  "9maj": "x02220",
  "2min": "xx0231",
  "4min": "022000",
  "9min": "x02210",
  "0/7": "x32310",
  "2/7": "xx0212",
  "4/7": "020100",
  "7/7": "320001",
  "9/7": "x02020",
  "11/7": "x21202",
  "0/maj7": "x32000",
  "5/maj7": "xx3210",
  "2/maj7": "xx0222",
  "9/maj7": "x02120",
  "2/min7": "xx0211",
  "4/min7": "022030",
  "9/min7": "x02010",
  "2/sus4": "xx0233",
  "4/sus4": "022200",
  "9/sus4": "x02230",
  "2/sus2": "xx0230",
  "9/sus2": "x02200",
};
const TUNING = [40, 45, 50, 55, 59, 64];
const shapeCache = new Map<string, string>();

function formatShape(frets: number[]): string {
  const big = frets.some((f) => f > 9);
  return frets.map((f) => (f < 0 ? "x" : String(f))).join(big ? "-" : "");
}

/**
 * Standard-tuning fingering (low E → high e), e.g. "x32010". Common open shapes come from a
 * table; anything else is found by searching every hand position for the most playable
 * voicing (root in the bass, all essential tones, ≤ 4 fingers with barre, no interior mutes).
 */
export function guitarChordShape(root: number, quality: ChordQuality): string {
  const key = quality === "maj" || quality === "min" ? `${root}${quality}` : `${root}/${quality}`;
  if (OPEN_SHAPES[key]) return OPEN_SHAPES[key];
  const cached = shapeCache.get(key);
  if (cached) return cached;

  const tones = chordTones(root, quality);
  const fifth = (root + 7) % 12;
  const required = tones.filter((pc) => !(tones.length > 3 && pc === fifth));
  let best: { frets: number[]; cost: number } | null = null;

  for (let pos = 1; pos <= 12; pos++) {
    const options = TUNING.map((open) => {
      const opts = [-1];
      for (const f of [0, pos, pos + 1, pos + 2, pos + 3]) {
        if (tones.includes((open + f) % 12) && !opts.includes(f)) opts.push(f);
      }
      return opts;
    });
    const frets = new Array(6).fill(-1);
    const visit = (s: number) => {
      if (s === 6) {
        const played = frets.map((f, i) => (f >= 0 ? i : -1)).filter((i) => i >= 0);
        if (played.length < (tones.length === 3 && quality === "dim" ? 3 : 4)) return;
        const lo = played[0];
        const hi = played[played.length - 1];
        if (played.length !== hi - lo + 1) return; // no muted strings in the middle
        if ((TUNING[lo] + frets[lo]) % 12 !== root) return; // root in the bass
        const pcs = new Set(played.map((i) => (TUNING[i] + frets[i]) % 12));
        if (!required.every((pc) => pcs.has(pc))) return;
        const fretted = played.map((i) => frets[i]).filter((f) => f > 0);
        const minF = fretted.length ? Math.min(...fretted) : 0;
        const maxF = fretted.length ? Math.max(...fretted) : 0;
        if (maxF - minF > 3) return;
        // Fingers: notes on the lowest fret can share one barre finger.
        const atMin = fretted.filter((f) => f === minF).length;
        const fingers = fretted.length - (atMin > 1 ? atMin - 1 : 0);
        if (fingers > 4) return;
        const opens = played.filter((i) => frets[i] === 0).length;
        const cost = minF * 0.6 + (6 - played.length) * 0.5 + (maxF - minF) * 0.3 - opens * 0.3 + fingers * 0.2;
        if (!best || cost < best.cost) best = { frets: [...frets], cost };
        return;
      }
      for (const f of options[s]) {
        frets[s] = f;
        visit(s + 1);
      }
      frets[s] = -1;
    };
    visit(0);
  }
  const shape = best ? formatShape((best as { frets: number[] }).frets) : "xxxxxx";
  shapeCache.set(key, shape);
  return shape;
}
