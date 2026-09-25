import { ANALYSIS_SR } from "./dsp/analyze";
import type { AnalysisResult, DetectMode, WorkerResponse } from "./types";

export const MAX_FILE_BYTES = 60 * 1024 * 1024;
export const MAX_SECONDS = 300;
export const ACCEPTED_EXT = [".mp3", ".wav", ".m4a", ".ogg", ".webm", ".flac", ".aac"];

export class UserFacingError extends Error {}

export function validateFile(file: File) {
  const name = file.name.toLowerCase();
  const okExt = ACCEPTED_EXT.some((ext) => name.endsWith(ext));
  if (!okExt && !file.type.startsWith("audio/")) {
    throw new UserFacingError("Unsupported file type. Please use MP3, WAV or M4A.");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new UserFacingError(`File is too large (${(file.size / 1e6).toFixed(0)} MB). Maximum is 60 MB.`);
  }
  if (file.size === 0) throw new UserFacingError("The file is empty.");
}

/**
 * Decode any browser-supported audio into mono Float32 at the analysis rate.
 * Long files are truncated to MAX_SECONDS.
 */
export async function decodeToMono(blob: Blob): Promise<{ samples: Float32Array; originalDuration: number }> {
  const bytes = await blob.arrayBuffer();
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(bytes);
  } catch {
    throw new UserFacingError("Could not decode this audio file. It may be corrupted or use an unsupported codec.");
  } finally {
    void ctx.close();
  }
  const originalDuration = decoded.duration;
  const seconds = Math.min(originalDuration, MAX_SECONDS);
  const length = Math.max(1, Math.ceil(seconds * ANALYSIS_SR));
  // OfflineAudioContext mixes channels down to mono and resamples in one pass.
  const offline = new OfflineAudioContext(1, length, ANALYSIS_SR);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return { samples: rendered.getChannelData(0).slice(), originalDuration };
}

export function runAnalysis(
  mode: DetectMode,
  samples: Float32Array,
  originalDuration: number,
  onProgress: (stage: string, progress: number) => void,
  signal?: AbortSignal,
): Promise<AnalysisResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./dsp/worker.ts", import.meta.url), { type: "module" });
    const cleanup = () => worker.terminate();
    signal?.addEventListener("abort", () => {
      cleanup();
      reject(new DOMException("Cancelled", "AbortError"));
    });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === "progress") onProgress(msg.stage, msg.progress);
      else if (msg.type === "done") {
        cleanup();
        resolve(msg.result);
      } else {
        cleanup();
        reject(new UserFacingError(msg.message));
      }
    };
    worker.onerror = (e) => {
      cleanup();
      reject(new Error(e.message || "Analysis worker crashed"));
    };
    const modelUrl = new URL("/model/model.json", window.location.href).href;
    worker.postMessage({ type: "analyze", mode, modelUrl, samples, sampleRate: ANALYSIS_SR, originalDuration }, [
      samples.buffer,
    ]);
  });
}
