"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MidiPlayer } from "@/lib/player";
import type { Arrangement } from "@/lib/types";

export function usePlayer(arr: Arrangement | null) {
  const playerRef = useRef<MidiPlayer | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const raf = useRef(0);

  const getPlayer = () => {
    if (!playerRef.current) {
      playerRef.current = new MidiPlayer();
      playerRef.current.onEnded = () => {
        setPlaying(false);
        setTime(0);
      };
    }
    return playerRef.current;
  };

  useEffect(() => {
    if (!arr) return;
    const p = getPlayer();
    p.load(arr.midi, arr.instrument);
    setTime(p.currentTime());
  }, [arr]);

  useEffect(() => () => playerRef.current?.dispose(), []);

  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      setTime(getPlayer().currentTime());
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing]);

  const play = useCallback(async () => {
    setLoading(true); // first play fetches the instrument samples
    try {
      await getPlayer().play();
      setPlaying(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const pause = useCallback(() => {
    getPlayer().pause();
    setPlaying(false);
    setTime(getPlayer().currentTime());
  }, []);

  const stop = useCallback(() => {
    getPlayer().stop();
    setPlaying(false);
    setTime(0);
  }, []);

  const seek = useCallback((t: number) => {
    getPlayer().seek(t);
    setTime(getPlayer().currentTime());
  }, []);

  return { time, playing, loading, play, pause, stop, seek, duration: arr?.duration ?? 0 };
}
