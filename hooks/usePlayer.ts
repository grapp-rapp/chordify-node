"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MidiPlayer } from "@/lib/player";
import type { Arrangement } from "@/lib/types";

/**
 * Playback state for an arrangement. `songUrl` (the user's original recording) is played
 * underneath the guitar part when "play along" is on, kept in sync via the arrangement's
 * audioOffset/audioRate.
 */
export function usePlayer(arr: Arrangement | null, songUrl: string | null = null) {
  const playerRef = useRef<MidiPlayer | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [speed, setSpeedState] = useState(1);
  const [withSong, setWithSong] = useState(true);
  const [songVolume, setSongVolume] = useState(0.55);
  const [guitarVolume, setGuitarVolumeState] = useState(1);
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

  // Re-point the backing track whenever the song or its alignment changes.
  const offset = arr?.audioOffset ?? 0;
  const rate = arr?.audioRate ?? 1;
  useEffect(() => {
    getPlayer().setBacking(songUrl, offset, rate);
  }, [songUrl, offset, rate]);

  useEffect(() => {
    getPlayer().setBackingOptions(withSong, songVolume);
  }, [withSong, songVolume, songUrl]);

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

  const setSpeed = useCallback((s: number) => {
    getPlayer().setSpeed(s);
    setSpeedState(s);
  }, []);

  const setGuitarVolume = useCallback((v: number) => {
    getPlayer().setGuitarVolume(v);
    setGuitarVolumeState(v);
  }, []);

  return {
    time,
    playing,
    loading,
    play,
    pause,
    stop,
    seek,
    duration: arr?.duration ?? 0,
    speed,
    setSpeed,
    withSong,
    setWithSong,
    songVolume,
    setSongVolume,
    guitarVolume,
    setGuitarVolume,
    hasSong: !!songUrl,
  };
}
