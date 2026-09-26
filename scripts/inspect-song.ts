/**
 * Prints the easy arrangement of a cached analysis (from analyze-song.ts) bar by bar.
 * Usage: npx tsx scripts/inspect-song.ts <analysis.json> [piano|guitar] [bars]
 */
import { readFileSync } from "node:fs";
import { arrange } from "../lib/music/arrange";
import type { AnalysisResult } from "../lib/types";

const [file, inst = "piano", barsArg = "12"] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(file, "utf8"));
const f32 = (a: number[]) => Float32Array.from(a);
const analysis: AnalysisResult = {
  ...raw,
  chroma: f32(raw.chroma),
  chromaEnergy: f32(raw.chromaEnergy),
  groove: { ...raw.groove, full: f32(raw.groove.full), low: f32(raw.groove.low) },
};

const arr = arrange(analysis, inst as "piano" | "guitar");
console.log(`tempo ${arr.tempo}  key ${arr.key}  bars ${arr.totalSteps / 16}`);
for (let b = 0; b < Math.min(Number(barsArg), arr.totalSteps / 16); b++) {
  const inBar = <T extends { startStep: number }>(xs: T[]) => xs.filter((n) => Math.floor(n.startStep / 16) === b);
  const chords = inBar(arr.chords).map((c) => `${c.symbol}@${c.startStep % 16}`).join(" ");
  const rh = inBar(arr.treble).map((n) => `${n.name}@${n.startStep % 16}`).join(" ");
  const lh = [...new Set(inBar(arr.bass).filter((n) => n.midi < 48).map((n) => n.startStep % 16))].join(",");
  console.log(`bar ${String(b + 1).padStart(2)} | ${chords.padEnd(18)} | RH ${rh.padEnd(60)} | bass@${lh}`);
}
