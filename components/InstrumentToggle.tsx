"use client";

import { Guitar, Piano } from "lucide-react";
import type { Instrument } from "@/lib/types";

const OPTIONS: { value: Instrument; label: string; hint: string; Icon: typeof Piano }[] = [
  { value: "piano", label: "Piano", hint: "Treble & bass clef, sheet music", Icon: Piano },
  { value: "guitar", label: "Guitar", hint: "Tabs & chord shapes (EADGBE)", Icon: Guitar },
];

export function InstrumentToggle({
  value,
  onChange,
  compact = false,
}: {
  value: Instrument;
  onChange: (v: Instrument) => void;
  compact?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Target instrument"
      className={`relative grid grid-cols-2 rounded-2xl border border-white/10 bg-black/30 p-1 ${compact ? "w-full sm:w-64" : "w-full"}`}
    >
      {/* sliding highlight */}
      <span
        aria-hidden
        className="absolute inset-y-1 w-[calc(50%-4px)] rounded-xl bg-gradient-to-br from-violet-600 to-fuchsia-600 shadow-lg shadow-violet-900/40 transition-transform duration-300 ease-out"
        style={{ transform: `translateX(${value === "piano" ? "4px" : "calc(100% + 4px)"})`, left: 0 }}
      />
      {OPTIONS.map(({ value: v, label, hint, Icon }) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(v)}
            className={`relative z-10 flex items-center justify-center gap-2.5 rounded-xl px-3 ${compact ? "py-2" : "py-3.5"} text-left transition-colors ${
              active ? "text-white" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Icon className={compact ? "h-4 w-4" : "h-6 w-6"} />
            <span className="flex flex-col">
              <span className={`font-semibold ${compact ? "text-sm" : "text-base"}`}>{label}</span>
              {!compact && <span className="hidden text-xs opacity-80 sm:block">{hint}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
