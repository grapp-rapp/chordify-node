"use client";

import { useEffect, useRef, useState } from "react";
import type { Arrangement } from "@/lib/types";

type AbcModule = typeof import("abcjs");
type Timing = { ms: number; left: number; top: number; height: number; elements: HTMLElement[][] };

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Engraved grand-staff notation via abcjs, with a cursor driven by the app's own
 * playback clock (abcjs's precomputed note timings are used only for positions).
 */
export function SheetMusic({ arr, time, onSeek }: { arr: Arrangement; time: number; onSeek: (t: number) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const timings = useRef<Timing[]>([]);
  const cursor = useRef<SVGLineElement | null>(null);
  const lit = useRef<HTMLElement[]>([]);
  const lastIdx = useRef(-1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const abcjs: AbcModule = await import("abcjs");
        if (cancelled || !host.current) return;
        const [tune] = abcjs.renderAbc(host.current, arr.abc, {
          responsive: "resize",
          add_classes: true,
          staffwidth: 760,
          paddingleft: 8,
          paddingright: 8,
        });
        const tc = new abcjs.TimingCallbacks(tune, { qpm: arr.tempo });
        timings.current = (tc.noteTimings ?? [])
          .filter((e) => e.type === "event" && e.left !== undefined)
          .map((e) => ({
            ms: e.milliseconds,
            left: e.left!,
            top: e.top!,
            height: e.height!,
            elements: (e.elements ?? []) as HTMLElement[][],
          }));
        const svg = host.current.querySelector("svg");
        if (svg) {
          const line = document.createElementNS(SVG_NS, "line");
          line.setAttribute("stroke", "#f59e0b");
          line.setAttribute("stroke-width", "2");
          line.setAttribute("opacity", "0");
          line.setAttribute("class", "abcjs-cursor");
          svg.appendChild(line);
          cursor.current = line;
        }
        lastIdx.current = -1;
        setError(null);
      } catch (e) {
        console.error(e);
        setError("Couldn't render sheet music for this transcription.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [arr.abc, arr.tempo]);

  // Move cursor / highlight current note.
  useEffect(() => {
    const list = timings.current;
    if (!list.length || !cursor.current) return;
    const ms = time * 1000;
    let lo = 0;
    let hi = list.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].ms <= ms + 1) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (idx === lastIdx.current) return;
    lastIdx.current = idx;
    lit.current.forEach((el) => el.classList.remove("abcjs-highlight"));
    lit.current = [];
    const line = cursor.current;
    if (idx < 0 || time <= 0) {
      line.setAttribute("opacity", "0");
      return;
    }
    const ev = list[idx];
    line.setAttribute("x1", String(ev.left - 2));
    line.setAttribute("x2", String(ev.left - 2));
    line.setAttribute("y1", String(ev.top));
    line.setAttribute("y2", String(ev.top + ev.height));
    line.setAttribute("opacity", "1");
    ev.elements.flat().forEach((el) => {
      el.classList.add("abcjs-highlight");
      lit.current.push(el);
    });
    // Keep the current system visible inside the scroll box.
    const box = host.current?.parentElement;
    const svg = host.current?.querySelector("svg");
    if (box && svg) {
      const scale = svg.getBoundingClientRect().width / (svg.viewBox.baseVal.width || 1);
      const y = ev.top * scale;
      if (y < box.scrollTop || y + ev.height * scale > box.scrollTop + box.clientHeight) {
        box.scrollTo({ top: Math.max(0, y - 40), behavior: "smooth" });
      }
    }
  }, [time]);

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs text-slate-400">
        <span>Grand staff · treble (right hand) &amp; bass (left hand) · click a note to jump</span>
        <span>
          ♩ = {arr.tempo} · 4/4
        </span>
      </div>
      <div className="scroll-thin max-h-[560px] overflow-auto bg-[#fdfcf8] p-3 sm:p-5">
        {error ? (
          <p className="p-6 text-center text-sm text-red-600">{error}</p>
        ) : (
          <div
            ref={host}
            className="sheet mx-auto max-w-4xl text-black"
            onClick={(e) => {
              // Seek to the clicked note using the rendered timing positions.
              const svg = host.current?.querySelector("svg");
              if (!svg) return;
              const pt = svg.createSVGPoint();
              pt.x = e.clientX;
              pt.y = e.clientY;
              const p = pt.matrixTransform(svg.getScreenCTM()?.inverse());
              let best: Timing | null = null;
              let bestD = Infinity;
              for (const t of timings.current) {
                if (p.y < t.top - 10 || p.y > t.top + t.height + 10) continue;
                const d = Math.abs(t.left - p.x);
                if (d < bestD) {
                  bestD = d;
                  best = t;
                }
              }
              if (best && bestD < 40) onSeek(best.ms / 1000 + 0.001);
            }}
          />
        )}
      </div>
    </div>
  );
}
