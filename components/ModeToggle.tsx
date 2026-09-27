"use client";

import { AudioLines, ListMusic } from "lucide-react";
import type { DetectMode } from "@/lib/types";

const OPTIONS: { value: DetectMode; label: string; hint: string; Icon: typeof ListMusic }[] = [
  { value: "poly", label: "Chords & notes", hint: "Full songs, bands, strummed guitar — several notes at once", Icon: ListMusic },
  { value: "melody", label: "Melody only", hint: "One note at a time — singing, whistling, solos", Icon: AudioLines },
];

export function ModeToggle({
  value,
  onChange,
  compact = false,
  disabled,
}: {
  value: DetectMode;
  onChange: (m: DetectMode) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Detection mode" className={`grid grid-cols-2 gap-2 ${compact ? "w-full sm:w-auto" : ""}`}>
      {OPTIONS.map(({ value: v, label, hint, Icon }) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(v)}
            title={hint}
            className={`flex items-center gap-2.5 rounded-xl border text-left transition disabled:opacity-50 ${
              compact ? "px-3 py-1.5 text-sm" : "px-3.5 py-2.5"
            } ${
              active
                ? "border-cyan-400/60 bg-cyan-400/10 text-white"
                : "border-white/10 bg-black/20 text-slate-400 hover:border-white/20 hover:text-slate-200"
            }`}
          >
            <Icon className={`shrink-0 ${compact ? "h-4 w-4" : "h-5 w-5"} ${active ? "text-cyan-300" : ""}`} />
            <span className="flex flex-col">
              <span className="font-semibold">{label}</span>
              {!compact && <span className="text-xs opacity-80">{hint}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
