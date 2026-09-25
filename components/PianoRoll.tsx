"use client";

import { ZoomIn, ZoomOut } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { isBlackKey, midiToName } from "@/lib/music/theory";
import type { Arrangement, QNote } from "@/lib/types";

const ROW_H = 12;
const KEY_W = 52;
const CHORD_LANE = 24;

const NoteLayer = memo(function NoteLayer({
  notes,
  hi,
  pxPerStep,
}: {
  notes: QNote[];
  hi: number;
  pxPerStep: number;
}) {
  return (
    <>
      {notes.map((n, i) => {
        const treble = n.midi >= 60;
        return (
          <div
            key={i}
            title={`${n.name} · ${n.start.toFixed(2)}s · ${(n.end - n.start).toFixed(2)}s · ${Math.round(n.confidence * 100)}% confidence`}
            className={`absolute rounded-[3px] border text-[9px] leading-none font-semibold text-white/90 ${
              treble ? "border-violet-300/60 bg-violet-500" : "border-cyan-200/60 bg-cyan-600"
            }`}
            style={{
              left: n.startStep * pxPerStep,
              top: (hi - n.midi) * ROW_H + CHORD_LANE + 1,
              width: Math.max(3, (n.endStep - n.startStep) * pxPerStep - 1),
              height: ROW_H - 2,
              opacity: 0.45 + 0.55 * Math.min(1, n.confidence),
            }}
          >
            {pxPerStep * (n.endStep - n.startStep) > 26 && <span className="pl-1 align-top">{n.name}</span>}
          </div>
        );
      })}
    </>
  );
});

export function PianoRoll({
  arr,
  time,
  playing,
  onSeek,
}: {
  arr: Arrangement;
  time: number;
  playing: boolean;
  onSeek: (t: number) => void;
}) {
  const [pxPerStep, setPxPerStep] = useState(12);
  const scroller = useRef<HTMLDivElement>(null);

  const [lo, hi] = useMemo(() => {
    if (!arr.notes.length) return [48, 72];
    let min = Math.min(...arr.notes.map((n) => n.midi)) - 3;
    let max = Math.max(...arr.notes.map((n) => n.midi)) + 3;
    if (max - min < 24) {
      const pad = Math.ceil((24 - (max - min)) / 2);
      min -= pad;
      max += pad;
    }
    return [Math.max(21, min), Math.min(108, max)];
  }, [arr.notes]);

  const rows = hi - lo + 1;
  const width = arr.totalSteps * pxPerStep;
  const height = rows * ROW_H + CHORD_LANE;
  const playX = (time / arr.stepSec) * pxPerStep;

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !playing) return;
    const viewW = el.clientWidth - KEY_W;
    const x = playX - el.scrollLeft;
    if (x < 0 || x > viewW * 0.75) el.scrollLeft = Math.max(0, playX - viewW * 0.2);
  }, [playX, playing]);

  // Centre the note range vertically on load.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = Math.max(0, (height - el.clientHeight) / 2);
  }, [height]);

  const bars = Math.ceil(arr.totalSteps / arr.stepsPerBar);
  const barW = arr.stepsPerBar * pxPerStep;
  const beatW = barW / 4;

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs text-slate-400">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-violet-500" /> Treble (≥ C4)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-cyan-600" /> Bass (&lt; C4)
          </span>
          <span className="hidden sm:inline">Click anywhere to seek</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded-lg p-1.5 hover:bg-white/10"
            aria-label="Zoom out"
            onClick={() => setPxPerStep((p) => Math.max(4, p - 3))}
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="rounded-lg p-1.5 hover:bg-white/10"
            aria-label="Zoom in"
            onClick={() => setPxPerStep((p) => Math.min(40, p + 3))}
          >
            <ZoomIn className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div ref={scroller} className="scroll-thin relative max-h-[460px] overflow-auto">
        <div className="relative flex" style={{ width: width + KEY_W, height }}>
          {/* Keyboard */}
          <div className="sticky left-0 z-20 shrink-0 border-r border-white/10 bg-[#0f1220]" style={{ width: KEY_W }}>
            <div style={{ height: CHORD_LANE }} className="border-b border-white/10 bg-[#0f1220]" />
            {Array.from({ length: rows }, (_, i) => {
              const m = hi - i;
              const black = isBlackKey(m);
              const isC = m % 12 === 0;
              return (
                <div
                  key={m}
                  className={`flex items-center justify-end pr-1.5 text-[9px] ${
                    black ? "bg-slate-800 text-slate-500" : "bg-slate-200 text-slate-600"
                  } ${isC ? "border-b border-slate-400 font-bold text-slate-900" : "border-b border-black/10"}`}
                  style={{ height: ROW_H }}
                >
                  {isC ? midiToName(m) : ""}
                </div>
              );
            })}
          </div>

          {/* Grid + notes */}
          <div
            className="relative cursor-crosshair"
            style={{ width, height }}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onSeek(((e.clientX - rect.left) / pxPerStep) * arr.stepSec);
            }}
          >
            {/* Row shading for black keys */}
            {Array.from({ length: rows }, (_, i) => {
              const m = hi - i;
              return (
                <div
                  key={m}
                  className={`absolute left-0 right-0 ${isBlackKey(m) ? "bg-white/[0.025]" : ""} ${m % 12 === 0 ? "border-b border-white/10" : ""}`}
                  style={{ top: CHORD_LANE + i * ROW_H, height: ROW_H }}
                />
              );
            })}
            {/* Beat & bar lines */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundImage: `linear-gradient(to right, rgba(255,255,255,0.14) 1px, transparent 1px), linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px)`,
                backgroundSize: `${barW}px 100%, ${beatW}px 100%`,
              }}
            />
            {/* Chord lane */}
            <div className="absolute left-0 right-0 top-0 border-b border-white/10 bg-black/30" style={{ height: CHORD_LANE }}>
              {arr.chords.map((c, i) => {
                const active = time >= c.start && time < c.end;
                return (
                  <div
                    key={i}
                    className={`absolute top-1 truncate rounded px-1.5 py-0.5 text-[11px] font-semibold transition-colors ${
                      active ? "bg-amber-400 text-black" : "bg-amber-400/15 text-amber-200"
                    }`}
                    style={{ left: c.startStep * pxPerStep + 1, maxWidth: (c.endStep - c.startStep) * pxPerStep - 3 }}
                  >
                    {c.symbol}
                  </div>
                );
              })}
              {Array.from({ length: bars }, (_, b) => (
                <span
                  key={b}
                  className="absolute bottom-0 text-[9px] text-slate-500"
                  style={{ left: b * barW + 3 }}
                >
                  {b % 4 === 0 ? b + 1 : ""}
                </span>
              ))}
            </div>

            <NoteLayer notes={arr.notes} hi={hi} pxPerStep={pxPerStep} />

            {/* Playhead */}
            <div
              className="pointer-events-none absolute top-0 z-10 w-0.5 bg-amber-300 shadow-[0_0_12px_2px_rgba(252,211,77,0.6)]"
              style={{ height, transform: `translateX(${playX}px)` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
