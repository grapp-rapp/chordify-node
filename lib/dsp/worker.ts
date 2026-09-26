/// <reference lib="webworker" />
import { analyze } from "./analyze";
import type { WorkerRequest, WorkerResponse } from "../types";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// TensorFlow.js 3.x's WebGL backend tests `if (!window)` (not `typeof window`), which throws a
// ReferenceError inside workers. Declaring it as undefined makes tfjs fall back to setTimeout.
if (!("window" in globalThis)) {
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true, writable: true });
}

// Errors thrown inside library promises we don't await must still reach the UI rather than hang it.
ctx.addEventListener("unhandledrejection", (e) => {
  const err = e.reason;
  console.error(err);
  ctx.postMessage({
    type: "error",
    message: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
  } satisfies WorkerResponse);
});

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type !== "analyze") return;
  let lastSent = -1;
  const onProgress = (stage: string, progress: number) => {
    // Throttle progress messages to ~1% steps.
    const p = Math.round(progress * 100);
    if (p === lastSent) return;
    lastSent = p;
    ctx.postMessage({ type: "progress", stage, progress } satisfies WorkerResponse);
  };
  try {
    let result;
    if (msg.mode === "poly") {
      // Loaded lazily so melody mode never downloads TensorFlow.js.
      const tf = await import("@tensorflow/tfjs");
      const { analyzePoly } = await import("./poly");
      // GPU (WebGL via OffscreenCanvas) when available, otherwise plain JS.
      if (!(await tf.setBackend("webgl").catch(() => false))) await tf.setBackend("cpu");
      await tf.ready();
      result = await analyzePoly(msg.samples, msg.sampleRate, msg.originalDuration, () => tf.loadGraphModel(msg.modelUrl), onProgress);
    } else {
      result = analyze(msg.samples, msg.sampleRate, msg.originalDuration, onProgress);
    }
    ctx.postMessage({ type: "done", result } satisfies WorkerResponse, [
      result.chroma.buffer,
      result.chromaEnergy.buffer,
      result.groove.full.buffer,
      result.groove.low.buffer,
    ]);
  } catch (err) {
    ctx.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
};
