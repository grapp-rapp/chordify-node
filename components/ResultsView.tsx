"use client";

import {
  AlertTriangle,
  Download,
  FileText,
  FileType2,
  Loader2,
  Minus,
  Music2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Square,
} from "lucide-react";
import { useState } from "react";
import { usePlayer } from "@/hooks/usePlayer";
import { exportMidi, exportPdf, exportText } from "@/lib/export";
import type { Arrangement, ArrangeStyle, DetectMode, Instrument } from "@/lib/types";
import { ModeToggle } from "./ModeToggle";
import { StyleToggle } from "./StyleToggle";
import { ChordStrip } from "./ChordStrip";
import { GuitarTab } from "./GuitarTab";
import { InstrumentToggle } from "./InstrumentToggle";
import { PianoRoll } from "./PianoRoll";
import { SheetMusic } from "./SheetMusic";

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function ResultsView({
  arr,
  source,
  detectedTempo,
  mode,
  onMode,
  onInstrument,
  onTempo,
  onStyle,
  onReset,
}: {
  arr: Arrangement;
  source: string;
  detectedTempo: number;
  mode: DetectMode;
  onMode: (m: DetectMode) => void;
  onInstrument: (i: Instrument) => void;
  onTempo: (bpm: number) => void;
  onStyle: (s: ArrangeStyle) => void;
  onReset: () => void;
}) {
  const player = usePlayer(arr);
  const [pianoView, setPianoView] = useState<"roll" | "sheet">("roll");
  const [pdfBusy, setPdfBusy] = useState(false);
  const [tempoDraft, setTempoDraft] = useState<string | null>(null);

  const commitTempo = (v: number) => {
    if (Number.isFinite(v)) onTempo(Math.min(240, Math.max(40, Math.round(v))));
    setTempoDraft(null);
  };

  const stats = [
    { label: "Notes", value: arr.notes.length },
    { label: "Key", value: arr.key },
    { label: "Bars", value: Math.ceil(arr.totalSteps / arr.stepsPerBar) },
    { label: "Chords", value: new Set(arr.chords.map((c) => c.name)).size },
  ];

  return (
    <div className="min-w-0 space-y-5">
      {/* Title row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-slate-500">Transcription</p>
          <h2 className="truncate text-xl font-semibold text-slate-100">{source}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ModeToggle value={mode} onChange={(m) => m !== mode && onMode(m)} compact />
          <InstrumentToggle value={arr.instrument} onChange={onInstrument} compact />
          <button type="button" onClick={onReset} className="btn-ghost">
            <RotateCcw className="h-4 w-4" /> New
          </button>
        </div>
      </div>

      {/* Transport + tempo + exports */}
      <div className="card flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={player.playing ? player.pause : player.play}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-lg shadow-violet-900/40 transition hover:scale-105"
            aria-label={player.playing ? "Pause" : "Play"}
          >
            {player.playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
          </button>
          <button type="button" onClick={player.stop} className="rounded-full p-2.5 text-slate-300 hover:bg-white/10" aria-label="Stop">
            <Square className="h-4 w-4" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="w-10 text-right font-mono text-xs tabular-nums text-slate-400">{fmt(player.time)}</span>
            <input
              type="range"
              min={0}
              max={Math.max(0.1, player.duration)}
              step={0.01}
              value={Math.min(player.time, player.duration)}
              onChange={(e) => player.seek(Number(e.target.value))}
              className="w-full min-w-24 accent-violet-500 lg:w-64"
              aria-label="Playback position"
            />
            <span className="w-10 font-mono text-xs tabular-nums text-slate-500">{fmt(player.duration)}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-black/20 px-1.5 py-1" title={`Detected: ${detectedTempo} BPM`}>
            <button type="button" className="rounded-lg p-1 hover:bg-white/10" aria-label="Slower" onClick={() => commitTempo(arr.tempo - 1)}>
              <Minus className="h-3.5 w-3.5" />
            </button>
            <input
              type="number"
              value={tempoDraft ?? arr.tempo}
              onChange={(e) => setTempoDraft(e.target.value)}
              onBlur={() => tempoDraft !== null && commitTempo(Number(tempoDraft))}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              className="w-11 bg-transparent text-center font-mono text-sm text-slate-100 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
              aria-label="Tempo in BPM"
            />
            <button type="button" className="rounded-lg p-1 hover:bg-white/10" aria-label="Faster" onClick={() => commitTempo(arr.tempo + 1)}>
              <Plus className="h-3.5 w-3.5" />
            </button>
            <span className="pr-1 text-xs text-slate-500">BPM</span>
            {arr.tempo !== detectedTempo && (
              <button type="button" className="text-xs text-violet-300 hover:underline" onClick={() => commitTempo(detectedTempo)}>
                reset
              </button>
            )}
            <span className="hidden pl-1 text-xs text-slate-500 xl:inline">
              ×2 / ÷2:
              <button type="button" className="ml-1 text-violet-300 hover:underline" onClick={() => commitTempo(arr.tempo * 2)}>
                double
              </button>
              <button type="button" className="ml-1 text-violet-300 hover:underline" onClick={() => commitTempo(arr.tempo / 2)}>
                half
              </button>
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-ghost" onClick={() => exportMidi(arr, source)}>
              <Download className="h-4 w-4" /> MIDI
            </button>
            <button type="button" className="btn-ghost" onClick={() => exportText(arr, source)}>
              <FileText className="h-4 w-4" /> Text
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={pdfBusy}
              onClick={async () => {
                setPdfBusy(true);
                try {
                  await exportPdf(arr, source);
                } finally {
                  setPdfBusy(false);
                }
              }}
            >
              {pdfBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileType2 className="h-4 w-4" />} PDF
            </button>
          </div>
        </div>
      </div>

      {arr.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
          {arr.warnings.map((w) => (
            <p key={w} className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /> {w}
            </p>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <div className="card min-w-0 p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Music2 className="h-4 w-4 text-amber-300" /> Chords
          </p>
          <ChordStrip chords={arr.chords} instrument={arr.instrument} time={player.time} onSeek={player.seek} />
        </div>
        <div className="grid grid-cols-4 gap-2 lg:grid-cols-2">
          {stats.map((s) => (
            <div key={s.label} className="card px-3 py-2">
              <p className="text-[11px] uppercase tracking-wider text-slate-500">{s.label}</p>
              <p className="truncate text-sm font-semibold text-slate-100">{s.value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <StyleToggle value={arr.style} instrument={arr.instrument} onChange={onStyle} />
        <p className="text-sm text-slate-400">
          {arr.style === "full"
            ? "Every detected note, exactly as played."
            : arr.instrument === "piano"
              ? "Melody in the right hand, chords in the left on the song's beat (kick → bass notes)."
              : "Chords strummed on the song's beat: ↓ on the beat, ↑ in between."}
        </p>
      </div>

      {arr.instrument === "piano" ? (
        <div className="space-y-3">
          <div className="inline-flex rounded-xl border border-white/10 bg-black/20 p-1 text-sm">
            {(["roll", "sheet"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setPianoView(v)}
                className={`rounded-lg px-3 py-1.5 font-medium transition ${pianoView === v ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-200"}`}
              >
                {v === "roll" ? "Piano Roll" : "Sheet Music"}
              </button>
            ))}
          </div>
          {pianoView === "roll" ? (
            <PianoRoll arr={arr} time={player.time} playing={player.playing} onSeek={player.seek} />
          ) : (
            <SheetMusic arr={arr} time={player.time} onSeek={player.seek} />
          )}
        </div>
      ) : (
        <GuitarTab arr={arr} time={player.time} onSeek={player.seek} />
      )}
    </div>
  );
}
