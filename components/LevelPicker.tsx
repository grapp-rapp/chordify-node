"use client";

export type GuitarLevel = 1 | 2 | 3 | "exact";

const OPTIONS: { value: GuitarLevel; stars: string; label: string; chords: string; melody: string }[] = [
  {
    value: 1,
    stars: "⭐",
    label: "Easy",
    chords: "1 chord per bar · tiny 1–3 finger chords (with a capo if needed) · 2 strums a bar",
    melody: "The tune with repeated notes merged · one note at a time · frets 0–5",
  },
  {
    value: 2,
    stars: "⭐⭐",
    label: "Medium",
    chords: "Normal open chords, no barre chords · a strum on every beat",
    melody: "The full tune, note for note · frets 0–9",
  },
  {
    value: 3,
    stars: "⭐⭐⭐",
    label: "Hard",
    chords: "All the chords (7ths, barre chords) in the song's own rhythm ↓↑",
    melody: "The full tune plus the song's own chord notes underneath",
  },
  {
    value: "exact",
    stars: "🎯",
    label: "Exact notes",
    chords: "Every note that was detected — for learning a riff note by note",
    melody: "Every note that was detected — for learning a riff note by note",
  },
];

export function LevelPicker({
  value,
  onChange,
  part = "chords",
}: {
  value: GuitarLevel;
  onChange: (l: GuitarLevel) => void;
  part?: "chords" | "melody";
}) {
  const active = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0];
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label="Difficulty level" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {OPTIONS.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={String(o.value)}
              type="button"
              role="radio"
              aria-checked={on}
              title={o[part]}
              onClick={() => onChange(o.value)}
              className={`flex flex-col items-center rounded-xl border px-3 py-2.5 transition ${
                on
                  ? "border-amber-300/70 bg-amber-400/15 text-white shadow-lg shadow-amber-900/20"
                  : "border-white/10 bg-black/20 text-slate-400 hover:border-white/20 hover:text-slate-200"
              }`}
            >
              <span className="text-sm leading-none">{o.stars}</span>
              <span className="mt-1 text-sm font-semibold">{o.label}</span>
            </button>
          );
        })}
      </div>
      <p className="text-center text-sm text-slate-400">{active[part]}</p>
    </div>
  );
}
