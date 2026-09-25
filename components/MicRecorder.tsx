"use client";

import { Check, Mic, RotateCcw, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_SECONDS } from "@/lib/audio";

type State = "idle" | "requesting" | "recording" | "review";

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function pickMime(): string | undefined {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return types.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
}

export function MicRecorder({ onRecording, disabled }: { onRecording: (b: Blob) => void; disabled?: boolean }) {
  const [state, setState] = useState<State>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number>(0);
  const startRef = useRef(0);
  const historyRef = useRef<number[]>([]);

  const cleanupStream = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
  }, []);

  useEffect(() => () => cleanupStream(), [cleanupStream]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const draw = useCallback((analyser: AnalyserNode) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext("2d")!;
    const data = new Float32Array(analyser.fftSize);
    const dpr = window.devicePixelRatio || 1;

    const frame = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      analyser.getFloatTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v));
      const hist = historyRef.current;
      hist.push(peak);
      const bars = Math.floor(w / 4);
      if (hist.length > bars) hist.splice(0, hist.length - bars);

      g.clearRect(0, 0, w, h);
      // Scrolling level history (bars)
      const grad = g.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, "rgba(124,58,237,0.25)");
      grad.addColorStop(1, "rgba(167,139,250,0.9)");
      g.fillStyle = grad;
      hist.forEach((p, i) => {
        const bh = Math.max(2, Math.min(1, p * 1.4) * (h - 8));
        g.fillRect(w - (hist.length - i) * 4, (h - bh) / 2, 2.5, bh);
      });
      // Live oscilloscope on top
      g.strokeStyle = "rgba(34,211,238,0.9)";
      g.lineWidth = 1.5;
      g.beginPath();
      for (let i = 0; i < data.length; i++) {
        const x = (i / (data.length - 1)) * w;
        const y = h / 2 + data[i] * (h / 2 - 4);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.stroke();

      const secs = (performance.now() - startRef.current) / 1000;
      setElapsed(secs);
      if (secs >= MAX_SECONDS) {
        recRef.current?.stop();
        return;
      }
      rafRef.current = requestAnimationFrame(frame);
    };
    frame();
  }, []);

  const start = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Recording isn't supported in this browser.");
      return;
    }
    setState("requesting");
    try {
      // Disable voice processing: it distorts musical pitch and dynamics.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);

      const mimeType = pickMime();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        cleanupStream();
        const b = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        setBlob(b);
        setUrl(URL.createObjectURL(b));
        setState("review");
      };
      recRef.current = rec;
      historyRef.current = [];
      startRef.current = performance.now();
      rec.start(250);
      setState("recording");
      requestAnimationFrame(() => draw(analyser));
    } catch (e) {
      cleanupStream();
      setState("idle");
      const name = e instanceof DOMException ? e.name : "";
      setError(
        name === "NotAllowedError"
          ? "Microphone access was blocked. Allow it in your browser's site settings and try again."
          : name === "NotFoundError"
            ? "No microphone was found."
            : "Couldn't start recording.",
      );
    }
  };

  const stop = () => recRef.current?.state === "recording" && recRef.current.stop();

  const reset = () => {
    setBlob(null);
    setUrl(null);
    setElapsed(0);
    setState("idle");
  };

  return (
    <div className="flex h-full min-h-56 flex-col rounded-2xl border border-white/10 bg-black/20 p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-semibold text-slate-100">Record from microphone</p>
          <p className="text-sm text-slate-400">Play, strum or sing — solo instruments work best.</p>
        </div>
        <span
          className={`font-mono text-sm tabular-nums ${state === "recording" ? "text-red-400" : "text-slate-500"}`}
          aria-live="polite"
        >
          {fmt(elapsed)} / {fmt(MAX_SECONDS)}
        </span>
      </div>

      <div className="relative my-4 flex-1 overflow-hidden rounded-xl border border-white/5 bg-black/40">
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-label="Live audio waveform" />
        {state !== "recording" && state !== "review" && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
            {state === "requesting" ? "Waiting for microphone permission…" : "Waveform appears here while recording"}
          </div>
        )}
        {state === "review" && url && (
          <div className="absolute inset-0 flex items-center justify-center p-3">
            <audio controls src={url} className="w-full max-w-sm" />
          </div>
        )}
      </div>

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {state === "recording" ? (
          <button type="button" onClick={stop} className="btn bg-red-600 text-white hover:bg-red-500">
            <span className="relative flex h-2.5 w-2.5">
              <span className="pulse-ring absolute inset-0 rounded-full" />
              <span className="relative h-2.5 w-2.5 rounded-full bg-white" />
            </span>
            <Square className="h-4 w-4" /> Stop
          </button>
        ) : state === "review" ? (
          <>
            <button type="button" onClick={() => blob && onRecording(blob)} className="btn-primary" disabled={disabled}>
              <Check className="h-4 w-4" /> Transcribe recording
            </button>
            <button type="button" onClick={reset} className="btn-ghost">
              <RotateCcw className="h-4 w-4" /> Re-record
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={start}
            className="btn bg-red-600/90 text-white hover:bg-red-500"
            disabled={disabled || state === "requesting"}
          >
            <Mic className="h-4 w-4" /> Start recording
          </button>
        )}
      </div>
    </div>
  );
}
