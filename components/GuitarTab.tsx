"use client";

import { Copy, LayoutGrid, ListMusic, Text } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { buildTabLines, GUITAR_STRING_NAMES } from "@/lib/music/arrange";
import type { Arrangement, ChordEvent, GuitarNote } from "@/lib/types";
import { ChordSheet } from "./ChordSheet";

const CELL_W = 22;
const ROW_H = 20;

interface MeasureData {
  index: number;
  notes: GuitarNote[];
  chords: ChordEvent[];
}

const Measure = memo(function Measure({
  m,
  steps,
  progress,
  onSeekStep,
}: {
  m: MeasureData;
  steps: number;
  /** Fractional step position of the playhead inside this bar, or null if elsewhere. */
  progress: number | null;
  onSeekStep: (step: number) => void;
}) {
  const start = m.index * steps;
  return (
    <div className="relative shrink-0" style={{ width: steps * CELL_W + 2 }}>
      {/* chord names */}
      <div className="relative h-5">
        <span className="absolute -top-3.5 left-0 text-[10px] text-slate-500">{m.index + 1}</span>
        {m.chords.map((c) => (
          <span
            key={c.startStep}
            className="absolute top-0 text-xs font-bold text-amber-300"
            style={{ left: (Math.max(c.startStep, start) - start) * CELL_W + 4 }}
          >
            {c.symbol}
          </span>
        ))}
      </div>
      <div
        className="relative cursor-pointer border-x border-slate-500/70"
        style={{ height: ROW_H * 6 }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onSeekStep(start + Math.floor((e.clientX - rect.left) / CELL_W));
        }}
      >
        {/* strings: high e on top */}
        {Array.from({ length: 6 }, (_, r) => (
          <div
            key={r}
            className="absolute left-0 right-0 border-t border-slate-500/50"
            style={{ top: r * ROW_H + ROW_H / 2 }}
          />
        ))}
        {/* beat guides */}
        {[4, 8, 12].map((s) => (
          <div key={s} className="absolute top-0 bottom-0 w-px bg-white/[0.04]" style={{ left: s * CELL_W }} />
        ))}
        {progress !== null && (
          <>
            <div
              className="pointer-events-none absolute top-0 bottom-0 rounded bg-amber-300/15"
              style={{ left: Math.floor(progress) * CELL_W, width: CELL_W }}
            />
            <div
              className="pointer-events-none absolute -top-1 -bottom-1 z-10 w-0.5 bg-amber-300 shadow-[0_0_10px_2px_rgba(252,211,77,0.5)]"
              style={{ transform: `translateX(${progress * CELL_W}px)` }}
            />
          </>
        )}
        {m.notes.map((n, i) => {
          const row = 5 - n.pos.string;
          const active = progress !== null && progress >= n.startStep - start && progress < n.endStep - start;
          return (
            <span
              key={i}
              title={`${n.name} — ${GUITAR_STRING_NAMES[n.pos.string]} string, fret ${n.pos.fret}${n.pos.transposed ? ` (octave-shifted)` : ""}`}
              className={`absolute z-[5] flex items-center justify-center rounded-md font-mono text-[12px] font-bold leading-none transition-colors ${
                active ? "bg-amber-300 text-black" : n.pos.transposed ? "bg-[#1b1530] text-fuchsia-300" : "bg-[#141726] text-slate-100"
              }`}
              style={{
                left: (n.startStep - start) * CELL_W + 1,
                top: row * ROW_H + 1,
                width: CELL_W - 2,
                height: ROW_H - 2,
                opacity: 0.55 + 0.45 * Math.min(1, n.confidence),
              }}
            >
              {n.pos.fret}
            </span>
          );
        })}
      </div>
      {m.notes.some((n) => n.strum) && (
        <div className="relative h-5" aria-label="Strum directions">
          {[...new Map(m.notes.filter((n) => n.strum).map((n) => [n.startStep, n.strum])).entries()].map(([step, dir]) => (
            <span
              key={step}
              className={`absolute top-0.5 text-center text-sm font-bold ${dir === "down" ? "text-cyan-300" : "text-violet-300"}`}
              style={{ left: (step - start) * CELL_W, width: CELL_W }}
              title={dir === "down" ? "Strum down" : "Strum up"}
            >
              {dir === "down" ? "↓" : "↑"}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

export function GuitarTab({
  arr,
  time,
  onSeek,
}: {
  arr: Arrangement;
  time: number;
  onSeek: (t: number) => void;
}) {
  // Easy levels open on the songbook-style chord sheet; exact notes open on the tab.
  const [mode, setMode] = useState<"chords" | "interactive" | "text">(arr.style === "easy" ? "chords" : "interactive");
  const [copied, setCopied] = useState(false);
  const steps = arr.stepsPerBar;

  const measures = useMemo<MeasureData[]>(() => {
    const count = Math.ceil(arr.totalSteps / steps);
    const list: MeasureData[] = Array.from({ length: count }, (_, index) => ({ index, notes: [], chords: [] }));
    arr.guitar.forEach((n) => list[Math.floor(n.startStep / steps)]?.notes.push(n));
    arr.chords.forEach((c) => list[Math.floor(c.startStep / steps)]?.chords.push(c));
    return list;
  }, [arr, steps]);

  const tabText = useMemo(() => buildTabLines(arr.guitar, arr.chords, arr.totalSteps).join("\n"), [arr]);

  const playStep = time / arr.stepSec;
  const activeBar = time > 0 ? Math.floor(playStep / steps) : -1;

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-2 text-xs text-slate-400">
        <span>
          {mode === "chords" ? (
            "Chord sheet · one box per bar · 4 beats"
          ) : (
            <>
              Standard tuning (E A D G B e) · numbers are frets{arr.capo ? ` (counted from the capo)` : ""} · each cell = 1/16 note
              {arr.guitar.some((g) => g.pos.transposed) && <span className="text-fuchsia-300"> · pink = octave-shifted</span>}
            </>
          )}
        </span>
        <div className="flex items-center gap-1 rounded-lg border border-white/10 p-0.5">
          <button
            type="button"
            onClick={() => setMode("chords")}
            className={`flex items-center gap-1 rounded-md px-2 py-1 ${mode === "chords" ? "bg-white/10 text-white" : "hover:text-slate-200"}`}
          >
            <ListMusic className="h-3.5 w-3.5" /> Chords
          </button>
          <button
            type="button"
            onClick={() => setMode("interactive")}
            className={`flex items-center gap-1 rounded-md px-2 py-1 ${mode === "interactive" ? "bg-white/10 text-white" : "hover:text-slate-200"}`}
          >
            <LayoutGrid className="h-3.5 w-3.5" /> Tab
          </button>
          <button
            type="button"
            onClick={() => setMode("text")}
            className={`flex items-center gap-1 rounded-md px-2 py-1 ${mode === "text" ? "bg-white/10 text-white" : "hover:text-slate-200"}`}
          >
            <Text className="h-3.5 w-3.5" /> Text
          </button>
        </div>
      </div>

      {mode === "chords" ? (
        <ChordSheet arr={arr} time={time} onSeek={onSeek} />
      ) : mode === "interactive" ? (
        <div className="scroll-thin max-h-[560px] overflow-auto p-4">
          <div className="flex">
            {/* string labels */}
            <div className="mr-1 shrink-0 pt-5 font-mono text-xs text-slate-400">
              {[...GUITAR_STRING_NAMES].reverse().map((s) => (
                <div key={s} className="flex items-center" style={{ height: ROW_H }}>
                  {s}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-y-6">
              {measures.map((m) => (
                <Measure
                  key={m.index}
                  m={m}
                  steps={steps}
                  progress={m.index === activeBar ? playStep - m.index * steps : null}
                  onSeekStep={(s) => onSeek(s * arr.stepSec + 0.001)}
                />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="relative">
          <button
            type="button"
            className="btn-ghost absolute right-3 top-3 z-10 py-1 text-xs"
            onClick={async () => {
              await navigator.clipboard.writeText(tabText);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy className="h-3.5 w-3.5" /> {copied ? "Copied!" : "Copy"}
          </button>
          <pre className="scroll-thin max-h-[560px] overflow-auto bg-black/30 p-4 font-mono text-[13px] leading-5 text-slate-200">
            {tabText}
          </pre>
        </div>
      )}
    </div>
  );
}
