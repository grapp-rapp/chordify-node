"use client";

import { AudioLines, Cpu, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { InstrumentToggle } from "@/components/InstrumentToggle";
import { ModeToggle } from "@/components/ModeToggle";
import { MicRecorder } from "@/components/MicRecorder";
import { ProgressPanel } from "@/components/ProgressPanel";
import { ResultsView } from "@/components/ResultsView";
import { UploadDropzone } from "@/components/UploadDropzone";
import { decodeToMono, runAnalysis, UserFacingError, validateFile } from "@/lib/audio";
import { arrange } from "@/lib/music/arrange";
import type { AnalysisResult, ArrangeStyle, DetectMode, Instrument } from "@/lib/types";

type Phase = "input" | "working" | "done";

export default function Home() {
  const [instrument, setInstrument] = useState<Instrument>("piano");
  const [mode, setMode] = useState<DetectMode>("poly");
  const lastBlob = useRef<Blob | null>(null);
  const [phase, setPhase] = useState<Phase>("input");
  const [progress, setProgress] = useState({ stage: "Decoding audio", value: 0 });
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [tempo, setTempo] = useState<number | undefined>(undefined);
  const [style, setStyle] = useState<ArrangeStyle>("easy");
  const abortRef = useRef<AbortController | null>(null);

  const arrangement = useMemo(() => {
    if (!analysis) return null;
    try {
      return arrange(analysis, instrument, tempo, style);
    } catch (e) {
      console.error(e);
      return null;
    }
  }, [analysis, instrument, tempo, style]);

  const transcribe = async (blob: Blob, label: string, detect: DetectMode = mode) => {
    lastBlob.current = blob;
    setMode(detect);
    setError(null);
    setSource(label);
    setPhase("working");
    setProgress({ stage: "Decoding audio", value: 0 });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { samples, originalDuration } = await decodeToMono(blob);
      if (controller.signal.aborted) return;
      const result = await runAnalysis(
        detect,
        samples,
        originalDuration,
        (stage, value) => setProgress({ stage, value: 0.05 + value * 0.95 }),
        controller.signal,
      );
      setAnalysis(result);
      setTempo(undefined);
      setPhase("done");
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      console.error(e);
      setError(e instanceof UserFacingError ? e.message : "Something went wrong while analysing the audio. Please try another file.");
      setPhase("input");
    }
  };

  const onFile = (file: File) => {
    try {
      validateFile(file);
      void transcribe(file, file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    setPhase("input");
  };

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-white/5">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <button type="button" onClick={() => phase !== "working" && setPhase("input")} className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-cyan-400 text-white shadow-lg shadow-violet-900/40">
              <AudioLines className="h-5 w-5" />
            </span>
            <span className="text-lg font-bold tracking-tight text-white">
              Chordify<span className="text-violet-300">Node</span>
            </span>
          </button>
          <span className="hidden items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-200 sm:flex">
            <ShieldCheck className="h-3.5 w-3.5" /> Audio never leaves your device
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {phase === "input" && (
          <div className="space-y-8">
            <section className="mx-auto max-w-2xl text-center">
              <h1 className="bg-gradient-to-br from-white to-slate-400 bg-clip-text text-3xl font-bold tracking-tight text-transparent sm:text-5xl">
                Turn music into notes, chords &amp; tabs
              </h1>
              <p className="mt-3 text-slate-400 sm:text-lg">
                Upload or record audio. ChordifyNode detects every note, the rhythm and the chords, then writes it out for piano or guitar.
              </p>
            </section>

            <section className="card space-y-3 p-4 sm:p-5">
              <p className="text-sm font-semibold text-slate-300">
                <span className="mr-2 rounded-md bg-violet-500/20 px-1.5 py-0.5 text-xs text-violet-200">1</span>
                Choose your instrument &amp; what to detect
              </p>
              <InstrumentToggle value={instrument} onChange={setInstrument} />
              <ModeToggle value={mode} onChange={setMode} />
            </section>

            <section className="card space-y-3 p-4 sm:p-5">
              <p className="text-sm font-semibold text-slate-300">
                <span className="mr-2 rounded-md bg-violet-500/20 px-1.5 py-0.5 text-xs text-violet-200">2</span>
                Add your audio
              </p>
              {error && (
                <div className="flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200" role="alert">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="flex-1">{error}</span>
                  <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}
              <div className="grid gap-4 md:grid-cols-2">
                <UploadDropzone onFile={onFile} />
                <MicRecorder onRecording={(b) => void transcribe(b, `Recording ${new Date().toLocaleTimeString()}`)} />
              </div>
              <p className="text-center text-sm text-slate-500">
                No audio handy?{" "}
                <button
                  type="button"
                  className="font-medium text-violet-300 hover:underline"
                  onClick={async () => {
                    try {
                      const res = await fetch("/samples/ode-to-joy.wav");
                      if (!res.ok) throw new Error();
                      void transcribe(await res.blob(), "Ode to Joy (demo).wav");
                    } catch {
                      setError("Couldn't load the demo clip.");
                    }
                  }}
                >
                  Try the demo (melody + chords)
                </button>
              </p>
            </section>

            <section className="grid gap-3 text-sm text-slate-400 sm:grid-cols-3">
              {[
                ["Chords & several notes", "A neural note detector (Basic Pitch) finds every note sounding at once, from A0 to C8."],
                ["Rhythm & harmony", "Onset detection, tempo estimation, 16th-note quantization and chord names from triads to 7ths."],
                ["Whole songs", "Songs with drums, band or vocals become one easy piano or guitar part that follows the song's beat."],
              ].map(([t, d]) => (
                <div key={t} className="card p-4">
                  <p className="mb-1 flex items-center gap-2 font-semibold text-slate-200">
                    <Cpu className="h-4 w-4 text-violet-300" /> {t}
                  </p>
                  <p>{d}</p>
                </div>
              ))}
            </section>
          </div>
        )}

        {phase === "working" && (
          <div className="flex min-h-[50vh] items-center">
            <ProgressPanel stage={progress.stage} progress={progress.value} source={source} mode={mode} onCancel={cancel} />
          </div>
        )}

        {phase === "done" && arrangement && analysis && (
          <ResultsView
            arr={arrangement}
            source={source}
            detectedTempo={analysis.tempo}
            mode={analysis.mode}
            onMode={(m) => lastBlob.current && void transcribe(lastBlob.current, source, m)}
            onInstrument={setInstrument}
            onTempo={setTempo}
            onStyle={setStyle}
            onReset={() => {
              setPhase("input");
              setAnalysis(null);
            }}
          />
        )}
      </main>

      <footer className="border-t border-white/5 py-5 text-center text-xs text-slate-500">
        ChordifyNode · all processing runs locally in your browser via Web Audio &amp; Web Workers
      </footer>
    </div>
  );
}
