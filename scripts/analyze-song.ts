/**
 * Runs a real audio file (MP3/WAV/…) through the polyphonic engine in Node and caches the
 * analysis as JSON, so arrangements of real songs can be inspected and iterated on quickly.
 * Usage: npx tsx scripts/analyze-song.ts <audio> <startSec> <durSec> <out.json>
 */
import * as tf from "@tensorflow/tfjs";
import decode from "audio-decode";
import { readFileSync, writeFileSync } from "node:fs";
import { ANALYSIS_SR } from "../lib/dsp/analyze";
import { analyzePoly } from "../lib/dsp/poly";

const [file, startArg = "0", durArg = "30", out = "analysis.json"] = process.argv.slice(2);

/** Mono mixdown + windowed-sinc resampling to the analysis rate. */
function toMono22k(buf: { sampleRate: number; channelData: Float32Array[] }, start: number, dur: number) {
  const sr = buf.sampleRate;
  const s0 = Math.floor(start * sr);
  const len = Math.min(Math.floor(dur * sr), buf.channelData[0].length - s0);
  const mono = new Float32Array(len);
  for (const d of buf.channelData) {
    for (let i = 0; i < len; i++) mono[i] += d[s0 + i] / buf.channelData.length;
  }
  const ratio = ANALYSIS_SR / sr;
  const n = Math.floor(len * ratio);
  const y = new Float32Array(n);
  const half = 16;
  const cutoff = Math.min(1, ratio) * 0.95;
  for (let j = 0; j < n; j++) {
    const x = j / ratio;
    const i0 = Math.floor(x);
    let acc = 0;
    let norm = 0;
    for (let k = i0 - half + 1; k <= i0 + half; k++) {
      if (k < 0 || k >= len) continue;
      const t = x - k;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * cutoff * t) / (Math.PI * cutoff * t);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / half);
      acc += mono[k] * sinc * w;
      norm += sinc * w;
    }
    y[j] = norm ? acc / norm : 0;
  }
  return y;
}

async function main() {
  const audio = await decode(readFileSync(file));
  const x = toMono22k(audio, Number(startArg), Number(durArg));
  const json = JSON.parse(readFileSync("public/model/model.json", "utf8"));
  const bin = readFileSync("public/model/group1-shard1of1.bin");
  const load = () =>
    tf.loadGraphModel(
      tf.io.fromMemory({
        modelTopology: json.modelTopology,
        weightSpecs: json.weightsManifest[0].weights,
        weightData: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength),
      }),
    );
  const t0 = performance.now();
  const res = await analyzePoly(x, ANALYSIS_SR, x.length / ANALYSIS_SR, load, () => {});
  const plain = JSON.stringify(res, (_k, v) => (v instanceof Float32Array ? Array.from(v) : v));
  writeFileSync(out, plain);
  console.log(`analysed ${(x.length / ANALYSIS_SR).toFixed(1)}s in ${((performance.now() - t0) / 1000).toFixed(0)}s: ${res.notes.length} notes, tempo ${res.tempo}`);
}
void main();
