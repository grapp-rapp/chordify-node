"use client";

import { memo, useMemo } from "react";
import type { Arrangement, ChordEvent } from "@/lib/types";

const BAR = 16;

interface BarData {
  index: number;
  /** Chord shown in each of the 4 beat columns (only where a chord starts, or beat 1). */
  chords: (ChordEvent | null)[];
  /** Strum on each 8th note: "down" | "up" | null. */
  strums: ("down" | "up" | null)[];
}

const Bar = memo(function Bar({
  bar,
  progress,
  onSeekStep,
}: {
  bar: BarData;
  /** Fractional 8th-note position of the playhead inside this bar, or null. */
  progress: number | null;
  onSeekStep: (step: number) => void;
}) {
  const active = progress !== null;
  return (
    <button
      type="button"
      onClick={() => onSeekStep(bar.index * BAR)}
      className={`relative rounded-xl border p-2 text-left transition ${
        active ? "border-amber-300/70 bg-amber-400/10" : "border-white/10 bg-black/20 hover:border-white/20"
      }`}
      aria-label={`Bar ${bar.index + 1}`}
    >
      <span className="absolute right-2 top-1 text-[10px] text-slate-500">{bar.index + 1}</span>
      <div className="grid h-8 grid-cols-4 items-end">
        {bar.chords.map((c, i) => (
          <span key={i} className={`truncate text-lg font-bold leading-none ${active ? "text-amber-200" : "text-slate-100"}`}>
            {c ? (c.shapeSymbol ?? c.symbol) : ""}
          </span>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-8">
        {bar.strums.map((s, i) => {
          const now = progress !== null && Math.floor(progress) === i;
          return (
            <span
              key={i}
              className={`text-center text-base font-bold leading-6 ${
                s === "down" ? "text-cyan-300" : s === "up" ? "text-violet-300" : "text-slate-700"
              } ${now ? "rounded bg-amber-300/30" : ""}`}
            >
              {s === "down" ? "↓" : s === "up" ? "↑" : "·"}
            </span>
          );
        })}
      </div>
    </button>
  );
});

/** Songbook-style view: one box per bar with the chord to play and when to strum. */
export function ChordSheet({ arr, time, onSeek }: { arr: Arrangement; time: number; onSeek: (t: number) => void }) {
  const bars = useMemo<BarData[]>(() => {
    const count = Math.ceil(arr.totalSteps / BAR);
    const strumAt = new Map<number, "down" | "up">();
    arr.guitar.forEach((g) => g.strum && strumAt.set(g.startStep, g.strum));
    return Array.from({ length: count }, (_, index) => {
      const b0 = index * BAR;
      const chords = [0, 1, 2, 3].map((beat) => {
        const s = b0 + beat * 4;
        const starting = arr.chords.find((c) => c.startStep >= s && c.startStep < s + 4);
        if (starting) return starting;
        return beat === 0 ? (arr.chords.find((c) => c.startStep < s && c.endStep > s) ?? null) : null;
      });
      const strums = Array.from({ length: 8 }, (_, e) => {
        // A strum anywhere within this 8th counts (chord changes can land on 16ths).
        return strumAt.get(b0 + e * 2) ?? strumAt.get(b0 + e * 2 + 1) ?? null;
      });
      return { index, chords, strums };
    });
  }, [arr]);

  const step = time / arr.stepSec;
  const activeBar = time > 0 ? Math.floor(step / BAR) : -1;

  return (
    <div className="p-3 sm:p-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {bars.map((b) => (
          <Bar
            key={b.index}
            bar={b}
            progress={b.index === activeBar ? (step - b.index * BAR) / 2 : null}
            onSeekStep={(s) => onSeek(s * arr.stepSec + 0.001)}
          />
        ))}
      </div>
      <p className="mt-3 text-center text-xs text-slate-500">
        <span className="text-cyan-300">↓</span> strum down · <span className="text-violet-300">↑</span> strum up ·{" "}
        <span className="text-slate-600">·</span> let it ring — click a bar to play from there
      </p>
    </div>
  );
}
