"use client";

import { memo } from "react";
import { guitarChordShape } from "@/lib/music/theory";
import type { ChordEvent, Instrument } from "@/lib/types";

/** Small SVG chord box for a shape string like "x32010" or "8-10-10-9-8-8". */
export const ChordDiagram = memo(function ChordDiagram({ shape }: { shape: string }) {
  const frets = (shape.includes("-") ? shape.split("-") : shape.split("")).map((f) => (f === "x" ? -1 : Number(f)));
  const played = frets.filter((f) => f > 0);
  const minFret = played.length ? Math.min(...played) : 1;
  const base = Math.max(...frets) <= 4 ? 1 : minFret;
  const W = 56;
  const H = 64;
  const x0 = 8;
  const y0 = 14;
  const sx = (W - 16) / 5;
  const sy = (H - 22) / 4;
  // Barre: lowest fret shared by several strings starting from the lowest played string.
  const barreStrings = frets.map((f, i) => (f === minFret ? i : -1)).filter((i) => i >= 0);
  const hasBarre = minFret > 0 && barreStrings.length >= 3 && base > 1;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-16 w-14" aria-label={`Chord shape ${shape}`}>
      {base === 1 ? (
        <rect x={x0} y={y0 - 2} width={sx * 5} height={2.5} className="fill-slate-200" />
      ) : (
        <text x={1} y={y0 + sy * 0.7} className="fill-slate-400 text-[7px]">
          {base}
        </text>
      )}
      {Array.from({ length: 5 }, (_, i) => (
        <line key={`f${i}`} x1={x0} x2={x0 + sx * 5} y1={y0 + sy * i} y2={y0 + sy * i} className="stroke-slate-500" strokeWidth={0.7} />
      ))}
      {Array.from({ length: 6 }, (_, i) => (
        <line key={`s${i}`} x1={x0 + sx * i} x2={x0 + sx * i} y1={y0} y2={y0 + sy * 4} className="stroke-slate-400" strokeWidth={0.7} />
      ))}
      {hasBarre && (
        <rect
          x={x0 + sx * barreStrings[0] - 2.5}
          y={y0 + sy * (minFret - base + 0.5) - 2.5}
          width={sx * (barreStrings[barreStrings.length - 1] - barreStrings[0]) + 5}
          height={5}
          rx={2.5}
          className="fill-violet-400"
        />
      )}
      {frets.map((f, i) => {
        const x = x0 + sx * i;
        if (f < 0)
          return (
            <text key={i} x={x} y={y0 - 5} textAnchor="middle" className="fill-slate-400 text-[7px]">
              ×
            </text>
          );
        if (f === 0)
          return <circle key={i} cx={x} cy={y0 - 7} r={2.2} className="fill-none stroke-slate-300" strokeWidth={0.8} />;
        if (hasBarre && f === minFret) return null;
        return <circle key={i} cx={x} cy={y0 + sy * (f - base + 0.5)} r={2.8} className="fill-violet-400" />;
      })}
    </svg>
  );
});

export function ChordStrip({
  chords,
  instrument,
  time,
  onSeek,
}: {
  chords: ChordEvent[];
  instrument: Instrument;
  time: number;
  onSeek: (t: number) => void;
}) {
  if (!chords.length) {
    return <p className="text-sm text-slate-500">No clear chord progression detected.</p>;
  }
  // Unique chords in order of appearance, for the diagram legend.
  const unique = [...new Map(chords.map((c) => [c.shapeSymbol ?? c.name, c])).values()];
  const current = chords.find((c) => time >= c.start && time < c.end);

  return (
    <div className="space-y-3">
      <div className="scroll-thin flex gap-1.5 overflow-x-auto pb-1">
        {chords.map((c, i) => {
          const active = current === c;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSeek(c.start + 0.001)}
              title={`${c.name}${c.shapeSymbol && c.shapeSymbol !== c.symbol ? ` (play the ${c.shapeSymbol} shape with the capo)` : ""} · bar ${Math.floor(c.startStep / 16) + 1}`}
              className={`shrink-0 rounded-lg border px-2.5 py-1 text-sm font-semibold transition ${
                active
                  ? "border-amber-300 bg-amber-400 text-black shadow-lg shadow-amber-500/20"
                  : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"
              }`}
            >
              {c.shapeSymbol ?? c.symbol}
            </button>
          );
        })}
      </div>
      {instrument === "guitar" && (
        <div className="flex flex-wrap gap-2">
          {unique.map((c) => (
            <div
              key={c.shapeSymbol ?? c.name}
              className={`flex flex-col items-center rounded-xl border px-2 pt-1.5 pb-1 transition ${
                current && (current.shapeSymbol ?? current.name) === (c.shapeSymbol ?? c.name)
                  ? "border-amber-300/70 bg-amber-400/10"
                  : "border-white/10 bg-black/20"
              }`}
            >
              <span className="text-xs font-semibold text-slate-100">{c.shapeSymbol ?? c.symbol}</span>
              <ChordDiagram shape={c.shape ?? guitarChordShape(c.root, c.quality)} />
              <span className="font-mono text-[10px] text-slate-500">{c.shape ?? guitarChordShape(c.root, c.quality)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
