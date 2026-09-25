"use client";

import { FileAudio, UploadCloud } from "lucide-react";
import { useRef, useState } from "react";
import { ACCEPTED_EXT } from "@/lib/audio";

export function UploadDropzone({ onFile, disabled }: { onFile: (f: File) => void; disabled?: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const pick = (files: FileList | null) => {
    const f = files?.[0];
    if (f) onFile(f);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-disabled={disabled}
      aria-label="Upload an audio file"
      onClick={() => !disabled && input.current?.click()}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !disabled) {
          e.preventDefault();
          input.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled) pick(e.dataTransfer.files);
      }}
      className={`group relative flex h-full min-h-56 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-6 text-center transition ${
        over
          ? "border-violet-400 bg-violet-500/10"
          : "border-white/15 hover:border-violet-400/60 hover:bg-white/[0.03]"
      } ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      <div
        className={`rounded-2xl bg-violet-500/15 p-4 text-violet-300 transition ${over ? "scale-110" : "group-hover:scale-105"}`}
      >
        {over ? <FileAudio className="h-8 w-8" /> : <UploadCloud className="h-8 w-8" />}
      </div>
      <div>
        <p className="font-semibold text-slate-100">{over ? "Drop to transcribe" : "Drag & drop an audio file"}</p>
        <p className="mt-1 text-sm text-slate-400">
          or <span className="text-violet-300 underline-offset-2 group-hover:underline">browse your files</span>
        </p>
      </div>
      <p className="text-xs text-slate-500">MP3 · WAV · M4A (also OGG, FLAC) — up to 5 minutes analysed</p>
      <input
        ref={input}
        type="file"
        className="hidden"
        accept={[...ACCEPTED_EXT, "audio/*"].join(",")}
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
