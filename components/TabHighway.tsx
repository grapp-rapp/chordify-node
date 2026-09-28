"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Arrangement, GuitarNote } from "@/lib/types";

const STRING_NAMES = ["E", "A", "D", "G", "B", "e"];
const TOP = 46; // room for chord badges
const GAP = 26; // between strings
const HEIGHT = TOP + GAP * 5 + 44;
const PX_PER_BEAT = 96;
const PLAYHEAD = 0.22; // playhead position as a fraction of the width

interface Strum {
  start: number;
  end: number;
  strings: number[];
  dir: "down" | "up";
  label: string | null;
}

/**
 * Simply-Guitar-style scrolling highway: strings run left→right, everything slides into a fixed
 * playhead. A strummed chord is one coloured bar across the strings it uses (chord name on top);
 * single notes are fret-number bubbles on their string.
 */
export function TabHighway({ arr, time, onSeek }: { arr: Arrangement; time: number; onSeek: (t: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const { strums, picks } = useMemo(() => {
    const byStep = new Map<number, GuitarNote[]>();
    const picks: GuitarNote[] = [];
    for (const g of arr.guitar) {
      if (!g.strum) {
        picks.push(g);
        continue;
      }
      byStep.set(g.startStep, [...(byStep.get(g.startStep) ?? []), g]);
    }
    const strums: Strum[] = [];
    let lastLabel = "";
    [...byStep.entries()]
      .sort((a, b) => a[0] - b[0])
      .forEach(([step, notes]) => {
        const chord = arr.chords.find((c) => step >= c.startStep && step < c.endStep);
        const name = chord ? (chord.shapeSymbol ?? chord.symbol) : "";
        // Label a strum when the chord changes or a new bar starts, like a songbook.
        const label = name && (name !== lastLabel || step % arr.stepsPerBar === 0) ? name : null;
        lastLabel = name;
        strums.push({
          start: notes[0].start,
          end: Math.max(...notes.map((n) => n.end)),
          strings: notes.map((n) => n.pos.string),
          dir: notes[0].strum ?? "down",
          label,
        });
      });
    return { strums, picks };
  }, [arr]);

  const pxPerSec = PX_PER_BEAT / (arr.stepSec * 4);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== width * dpr || canvas.height !== HEIGHT * dpr) {
      canvas.width = width * dpr;
      canvas.height = HEIGHT * dpr;
    }
    const g = canvas.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const px = width * PLAYHEAD;
    const xOf = (t: number) => px + (t - time) * pxPerSec;
    const yOf = (string: number) => TOP + (5 - string) * GAP;
    const t0 = time - px / pxPerSec - 1;
    const t1 = time + (width - px) / pxPerSec + 1;

    // Background
    const bg = g.createLinearGradient(0, 0, 0, HEIGHT);
    bg.addColorStop(0, "#3b1a86");
    bg.addColorStop(1, "#24104f");
    g.fillStyle = bg;
    g.fillRect(0, 0, width, HEIGHT);
    g.fillStyle = "rgba(0,0,0,0.18)";
    g.fillRect(0, 0, px, HEIGHT); // "already played" side

    // Bar and beat lines
    const beatSec = arr.stepSec * 4;
    for (let b = Math.max(0, Math.floor(t0 / beatSec)); b * beatSec < t1; b++) {
      const x = xOf(b * beatSec);
      const isBar = b % 4 === 0;
      g.strokeStyle = isBar ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.08)";
      g.lineWidth = isBar ? 1.5 : 1;
      g.beginPath();
      g.moveTo(x, TOP - 8);
      g.lineTo(x, yOf(0) + 8);
      g.stroke();
      if (isBar) {
        g.fillStyle = "rgba(255,255,255,0.35)";
        g.font = "10px system-ui, sans-serif";
        g.fillText(String(b / 4 + 1), x + 3, yOf(0) + 24);
      }
    }

    // Strings
    for (let s = 0; s < 6; s++) {
      g.strokeStyle = `rgba(255,255,255,${0.22 + s * 0.03})`;
      g.lineWidth = 1 + (5 - s) * 0.35; // low strings are thicker
      g.beginPath();
      g.moveTo(0, yOf(s));
      g.lineTo(width, yOf(s));
      g.stroke();
    }

    const round = (x: number, y: number, w: number, h: number, r: number) => {
      g.beginPath();
      g.roundRect(x, y, w, h, r);
    };

    // Strummed chords: one bar across the strings played
    for (const st of strums) {
      if (st.end < t0 || st.start > t1) continue;
      const x = xOf(st.start);
      const yTop = yOf(Math.max(...st.strings)) - 12;
      const yBot = yOf(Math.min(...st.strings)) + 12;
      const now = time >= st.start - 0.02 && time < Math.min(st.end, st.start + 0.35);
      const color = st.dir === "down" ? "#22d3ee" : "#a78bfa";
      if (now) {
        g.shadowColor = color;
        g.shadowBlur = 18;
      }
      g.fillStyle = now ? "#ffffff" : color;
      round(x - 7, yTop, 14, yBot - yTop, 7);
      g.fill();
      g.shadowBlur = 0;
      // direction arrow under the bar
      g.fillStyle = color;
      g.font = "bold 13px system-ui, sans-serif";
      g.textAlign = "center";
      g.fillText(st.dir === "down" ? "↓" : "↑", x, yOf(0) + 38);
      if (st.label) {
        g.font = "bold 13px system-ui, sans-serif";
        const w = Math.max(24, g.measureText(st.label).width + 12);
        g.fillStyle = now ? "#fcd34d" : "#0b0d14";
        round(x - w / 2, 8, w, 22, 6);
        g.fill();
        g.fillStyle = now ? "#0b0d14" : "#ffffff";
        g.fillText(st.label, x, 24);
      }
      g.textAlign = "left";
    }

    // Notes the song plays together: joined into one chord block (name on top), like a chord
    // in a songbook, with each string's fret still shown.
    const together = new Map<number, GuitarNote[]>();
    for (const n of picks) together.set(n.startStep, [...(together.get(n.startStep) ?? []), n]);
    for (const [step, group] of together) {
      if (group.length < 2) continue;
      const first = group[0];
      if (first.end < t0 || first.start > t1) continue;
      const x = xOf(first.start);
      const strings = group.map((n) => n.pos.string);
      const yTop = yOf(Math.max(...strings)) - 15;
      const yBot = yOf(Math.min(...strings)) + 15;
      const now = time >= first.start - 0.02 && time < Math.max(...group.map((n) => n.end));
      g.fillStyle = now ? "rgba(252,211,77,0.45)" : "rgba(34,211,238,0.35)";
      round(x - 15, yTop, 30, yBot - yTop, 9);
      g.fill();
      const chord = arr.chords.find((c) => step >= c.startStep && step < c.endStep);
      const label = chord ? (chord.shapeSymbol ?? chord.symbol) : null;
      if (label) {
        g.font = "bold 13px system-ui, sans-serif";
        const w = Math.max(24, g.measureText(label).width + 12);
        g.fillStyle = now ? "#fcd34d" : "#0b0d14";
        round(x - w / 2, 8, w, 22, 6);
        g.fill();
        g.fillStyle = now ? "#0b0d14" : "#ffffff";
        g.textAlign = "center";
        g.fillText(label, x, 24);
        g.textAlign = "left";
      }
    }

    // Picked notes: fret bubbles
    for (const n of picks) {
      if (n.end < t0 || n.start > t1) continue;
      const x = xOf(n.start);
      const y = yOf(n.pos.string);
      const now = time >= n.start - 0.02 && time < n.end;
      // sustain trail
      g.strokeStyle = now ? "rgba(252,211,77,0.6)" : "rgba(255,255,255,0.25)";
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(Math.max(x, xOf(n.end) - 4), y);
      g.stroke();
      const label = String(n.pos.fret);
      g.font = "bold 13px system-ui, sans-serif";
      const w = Math.max(22, g.measureText(label).width + 10);
      if (now) {
        g.shadowColor = "#fcd34d";
        g.shadowBlur = 16;
      }
      g.fillStyle = now ? "#fcd34d" : "#ffffff";
      round(x - w / 2, y - 11, w, 22, 6);
      g.fill();
      g.shadowBlur = 0;
      g.fillStyle = "#1e1b4b";
      g.textAlign = "center";
      g.fillText(label, x, y + 5);
      g.textAlign = "left";
    }

    // String names (on top of the scrolling content)
    g.fillStyle = "rgba(20,10,50,0.85)";
    g.fillRect(0, TOP - 14, 22, GAP * 5 + 28);
    g.fillStyle = "rgba(255,255,255,0.7)";
    g.font = "bold 11px ui-monospace, monospace";
    for (let s = 0; s < 6; s++) g.fillText(STRING_NAMES[s], 7, yOf(s) + 4);

    // Playhead
    g.shadowColor = "#22d3ee";
    g.shadowBlur = 14;
    g.strokeStyle = "#67e8f9";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(px, 4);
    g.lineTo(px, HEIGHT - 4);
    g.stroke();
    g.shadowBlur = 0;
    g.fillStyle = "#67e8f9";
    g.beginPath();
    g.moveTo(px - 7, 2);
    g.lineTo(px + 7, 2);
    g.lineTo(px, 11);
    g.fill();
  }, [time, width, arr, strums, picks, pxPerSec]);

  return (
    <div ref={boxRef} className="overflow-hidden rounded-2xl border border-violet-400/20 shadow-lg shadow-violet-950/50">
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: HEIGHT, display: "block", cursor: "pointer" }}
        aria-label="Scrolling guitar tab"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left;
          onSeek(Math.max(0, time + (x - width * PLAYHEAD) / pxPerSec));
        }}
      />
    </div>
  );
}
