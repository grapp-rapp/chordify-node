"use client";

import { AudioWaveform, X } from "lucide-react";

const STAGES = {
  poly: ["Decoding audio", "Loading model", "Detecting notes", "Segmenting notes", "Extracting harmony", "Estimating tempo"],
  melody: ["Decoding audio", "Tracking pitch", "Filtering noise", "Detecting onsets", "Segmenting notes", "Estimating tempo", "Extracting harmony"],
};

export function ProgressPanel({
  stage,
  progress,
  source,
  mode,
  onCancel,
}: {
  stage: string;
  progress: number;
  source: string;
  mode: "poly" | "melody";
  onCancel: () => void;
}) {
  const stages = STAGES[mode];
  const current = Math.max(0, stages.indexOf(stage));
  const pct = Math.round(progress * 100);
  return (
    <div className="card mx-auto w-full max-w-xl p-6 sm:p-8" role="status" aria-live="polite">
      <div className="flex items-center gap-4">
        <div className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-violet-500/15 text-violet-300">
          <AudioWaveform className="h-7 w-7 animate-pulse" />
          <svg className="absolute inset-0 -rotate-90" viewBox="0 0 56 56">
            <circle cx="28" cy="28" r="26" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3" />
            <circle
              cx="28"
              cy="28"
              r="26"
              fill="none"
              stroke="url(#pg)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 26}
              strokeDashoffset={2 * Math.PI * 26 * (1 - progress)}
              className="transition-[stroke-dashoffset] duration-300"
            />
            <defs>
              <linearGradient id="pg" x1="0" x2="1">
                <stop offset="0" stopColor="#8b5cf6" />
                <stop offset="1" stopColor="#22d3ee" />
              </linearGradient>
            </defs>
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-lg font-semibold text-slate-100">Transcribing…</p>
          <p className="truncate text-sm text-slate-400">{source}</p>
        </div>
        <span className="font-mono text-2xl font-semibold tabular-nums text-slate-200">{pct}%</span>
      </div>

      <div className="mt-6 h-2 overflow-hidden rounded-full bg-white/5">
        <div
          className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-[width] duration-300"
          style={{ width: `${Math.max(3, pct)}%` }}
        />
      </div>

      <ol className="mt-5 grid grid-cols-1 gap-1.5 text-sm sm:grid-cols-2">
        {stages.map((s, i) => (
          <li
            key={s}
            className={`flex items-center gap-2 ${i < current ? "text-slate-400" : i === current ? "text-violet-200" : "text-slate-600"}`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${i < current ? "bg-emerald-400" : i === current ? "animate-ping bg-violet-400" : "bg-slate-700"}`}
            />
            {s}
          </li>
        ))}
      </ol>

      <div className="mt-6 flex justify-end">
        <button type="button" onClick={onCancel} className="btn-ghost">
          <X className="h-4 w-4" /> Cancel
        </button>
      </div>
    </div>
  );
}
