"use client";

import { Sparkles, ScanLine } from "lucide-react";
import type { ArrangeStyle, Instrument } from "@/lib/types";

export function StyleToggle({
  value,
  instrument,
  onChange,
}: {
  value: ArrangeStyle;
  instrument: Instrument;
  onChange: (s: ArrangeStyle) => void;
}) {
  const options: { value: ArrangeStyle; label: string; hint: string; Icon: typeof Sparkles }[] = [
    {
      value: "easy",
      label: "Easy arrangement",
      hint:
        instrument === "piano"
          ? "The whole song (drums included) as one piano part: melody in the right hand, chords on the song's beat in the left"
          : "The whole song (drums included) as strummed chords following the song's beat",
      Icon: Sparkles,
    },
    { value: "full", label: "Full transcription", hint: "Every note that was detected, exactly as played", Icon: ScanLine },
  ];
  return (
    <div role="radiogroup" aria-label="Arrangement style" className="inline-flex rounded-xl border border-white/10 bg-black/20 p-1 text-sm">
      {options.map(({ value: v, label, hint, Icon }) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={v === value}
          title={hint}
          onClick={() => onChange(v)}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition ${
            v === value ? "bg-amber-400/15 text-amber-100" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Icon className="h-4 w-4" /> {label}
        </button>
      ))}
    </div>
  );
}
