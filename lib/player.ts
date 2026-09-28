/**
 * Plays back the generated MIDI file with recorded instrument samples (MusyngKite General MIDI
 * soundfont: acoustic grand piano / steel-string guitar, one recording per note, loaded on
 * demand for just the pitches the piece uses). If a sample can't be fetched (offline), that
 * pitch falls back to a synthesized voice:
 *  - piano: additive synthesis with slightly inharmonic, individually decaying partials
 *  - guitar: Karplus–Strong plucked string
 * Notes are scheduled with a look-ahead scheduler, so long pieces don't create thousands of
 * nodes up front.
 */
import { Midi } from "@tonejs/midi";
import type { Instrument } from "./types";

interface PlayNote {
  midi: number;
  time: number;
  duration: number;
  velocity: number;
}

const LOOKAHEAD = 0.25; // seconds
const SAMPLE_BASE = "https://gleitz.github.io/midi-js-soundfonts/MusyngKite/";
const SAMPLE_SET: Record<Instrument, string> = { piano: "acoustic_grand_piano", guitar: "acoustic_guitar_steel" };
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const SAMPLE_TIMEOUT_MS = 8000;

/** Recorded samples are shared by all players and survive re-arrangements. */
const sampleCache = new Map<string, Promise<AudioBuffer | null>>();

function fetchSample(ctx: BaseAudioContext, instrument: Instrument, midi: number): Promise<AudioBuffer | null> {
  const key = `${instrument}:${midi}`;
  let p = sampleCache.get(key);
  if (!p) {
    const name = `${FLAT_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
    const url = `${SAMPLE_BASE}${SAMPLE_SET[instrument]}-mp3/${name}.mp3`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SAMPLE_TIMEOUT_MS);
    p = fetch(url, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => ctx.decodeAudioData(b))
      .catch(() => {
        sampleCache.delete(key); // allow a retry later (e.g. back online)
        return null;
      })
      .finally(() => clearTimeout(timer));
    sampleCache.set(key, p);
  }
  return p;
}
const TICK_MS = 50;

function renderPiano(ctx: BaseAudioContext, midi: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const f0 = 440 * 2 ** ((midi - 69) / 12);
  const len = Math.floor(sr * Math.max(1.2, 3.2 - (midi - 21) * 0.025));
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const B = 0.0004; // inharmonicity
  for (let h = 1; h <= 10; h++) {
    const f = f0 * h * Math.sqrt(1 + B * h * h);
    if (f > sr / 2.2) break;
    const amp = 1 / (h ** 1.3);
    const decay = 1.2 + h * 0.9 + (midi - 21) * 0.03;
    const w = (2 * Math.PI * f) / sr;
    for (let i = 0; i < len; i++) d[i] += amp * Math.exp((-decay * i) / sr) * Math.sin(w * i);
  }
  const attack = Math.floor(sr * 0.004);
  let peak = 0;
  for (let i = 0; i < len; i++) {
    if (i < attack) d[i] *= i / attack;
    peak = Math.max(peak, Math.abs(d[i]));
  }
  for (let i = 0; i < len; i++) d[i] /= peak || 1;
  return buf;
}

function renderGuitar(ctx: BaseAudioContext, midi: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const f0 = 440 * 2 ** ((midi - 69) / 12);
  const len = Math.floor(sr * 2.5);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  // y[n] = g * (y[n-N] + y[n-N-1]) / 2 has a loop delay of N + 0.5 samples.
  const N = Math.max(2, Math.round(sr / f0 - 0.5));
  let seed = midi * 7919;
  for (let i = 0; i <= N; i++) {
    seed = (seed * 16807) % 2147483647;
    d[i] = (seed / 2147483647) * 2 - 1;
  }
  // Soften the initial burst (finger rather than pick).
  for (let pass = 0; pass < 2; pass++) for (let i = 1; i <= N; i++) d[i] = 0.5 * (d[i] + d[i - 1]);
  const damping = 0.996 - Math.max(0, midi - 52) * 0.0004;
  for (let i = N + 1; i < len; i++) d[i] = damping * 0.5 * (d[i - N] + d[i - N - 1]);
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
  for (let i = 0; i < len; i++) d[i] /= peak || 1;
  return buf;
}

export class MidiPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private samples = new Map<string, AudioBuffer>();
  private notes: PlayNote[] = [];
  private instrument: Instrument = "piano";
  private timer: number | null = null;
  private nextIndex = 0;
  private startCtxTime = 0;
  private startOffset = 0;
  private active = new Set<AudioBufferSourceNode>();
  duration = 0;
  playing = false;
  pausedAt = 0;
  onEnded?: () => void;
  /** Practice speed (1 = normal). Samples keep their pitch; timing is stretched. */
  private speed = 1;
  private guitarVolume = 1;
  /** Original recording played underneath ("play along"): song time = offset + t × rate. */
  private backing: HTMLAudioElement | null = null;
  private backingOffset = 0;
  private backingRate = 1;
  private backingOn = true;

  setBacking(url: string | null, offset: number, rate: number) {
    this.backing?.pause();
    this.backing = null;
    if (url) {
      const el = new Audio(url);
      el.preload = "auto";
      el.preservesPitch = true; // slowing down must not lower the pitch
      this.backing = el;
    }
    this.backingOffset = offset;
    this.backingRate = rate;
    if (this.playing) void this.play(this.currentTime());
  }

  setBackingOptions(on: boolean, volume: number) {
    this.backingOn = on;
    if (this.backing) this.backing.volume = Math.max(0, Math.min(1, volume));
    if (!on) this.backing?.pause();
    else if (this.playing) this.syncBacking(this.currentTime(), true);
  }

  setGuitarVolume(v: number) {
    this.guitarVolume = v;
    if (this.master) this.master.gain.value = 0.35 * v;
  }

  setSpeed(speed: number) {
    const pos = this.currentTime();
    this.speed = speed;
    if (this.playing) void this.play(pos);
  }

  /** Keeps the original recording aligned with the arrangement's clock. */
  private syncBacking(songTime: number, force = false) {
    const el = this.backing;
    if (!el || !this.backingOn) return;
    const target = this.backingOffset + songTime * this.backingRate;
    el.playbackRate = this.speed * this.backingRate;
    if (target < 0 || target > (el.duration || Infinity)) {
      el.pause();
      return;
    }
    if (force || Math.abs(el.currentTime - target) > 0.12) el.currentTime = target;
    if (el.paused) void el.play().catch(() => {});
  }

  load(midiBytes: Uint8Array, instrument: Instrument) {
    const wasPlaying = this.playing;
    const pos = this.currentTime();
    this.stopVoices();
    const midi = new Midi(midiBytes);
    this.notes = midi.tracks
      .flatMap((t) => t.notes.map((n) => ({ midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity })))
      .sort((a, b) => a.time - b.time);
    this.duration = midi.duration;
    this.instrument = instrument;
    this.pausedAt = Math.min(pos, this.duration);
    if (wasPlaying) void this.play(this.pausedAt);
  }

  private ensureCtx() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.connect(this.ctx.destination);
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35 * this.guitarVolume;
      this.master.connect(comp);
    }
    return this.ctx;
  }

  /** Fetches the recorded samples for every pitch in the piece (in parallel). */
  private async loadSamples() {
    const ctx = this.ensureCtx();
    const pitches = [...new Set(this.notes.map((n) => n.midi))];
    const inst = this.instrument;
    await Promise.all(
      pitches.map(async (m) => {
        const buf = await fetchSample(ctx, inst, m);
        if (buf) this.samples.set(`${inst}:${m}`, buf);
      }),
    );
  }

  private voice(midi: number): AudioBuffer {
    const key = `${this.instrument}:${midi}`;
    const sample = this.samples.get(key);
    if (sample) return sample;
    let b = this.buffers.get(key);
    if (!b) {
      const ctx = this.ensureCtx();
      b = this.instrument === "guitar" ? renderGuitar(ctx, midi) : renderPiano(ctx, midi);
      this.buffers.set(key, b);
    }
    return b;
  }

  currentTime(): number {
    if (!this.playing || !this.ctx) return this.pausedAt;
    return Math.min(this.duration, this.startOffset + (this.ctx.currentTime - this.startCtxTime) * this.speed);
  }

  async play(from = this.pausedAt) {
    const ctx = this.ensureCtx();
    if (ctx.state === "suspended") await ctx.resume();
    await this.loadSamples();
    this.stopVoices();
    if (from >= this.duration - 0.01) from = 0;
    this.startOffset = from;
    this.startCtxTime = ctx.currentTime + 0.05;
    this.nextIndex = this.notes.findIndex((n) => n.time + n.duration > from);
    if (this.nextIndex < 0) this.nextIndex = this.notes.length;
    this.playing = true;
    this.syncBacking(from, true);
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
  }

  pause() {
    this.pausedAt = this.currentTime();
    this.stopVoices();
  }

  stop() {
    this.stopVoices();
    this.pausedAt = 0;
  }

  seek(t: number) {
    const clamped = Math.max(0, Math.min(this.duration, t));
    if (this.playing) void this.play(clamped);
    else this.pausedAt = clamped;
  }

  dispose() {
    this.stopVoices();
    this.backing?.pause();
    this.backing = null;
    void this.ctx?.close();
    this.ctx = null;
  }

  private stopVoices() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    const now = this.ctx?.currentTime ?? 0;
    this.active.forEach((src) => {
      try {
        src.stop(now + 0.02);
      } catch {
        /* already stopped */
      }
    });
    this.active.clear();
    this.playing = false;
    this.backing?.pause();
  }

  private schedule() {
    const ctx = this.ctx!;
    const songNow = this.startOffset + (ctx.currentTime - this.startCtxTime) * this.speed;
    if (songNow > this.startOffset + 0.3) this.syncBacking(songNow);
    // Song time → AudioContext time at the current practice speed.
    const at = (songTime: number) => this.startCtxTime + (songTime - this.startOffset) / this.speed;
    while (this.nextIndex < this.notes.length && this.notes[this.nextIndex].time < songNow + LOOKAHEAD * this.speed) {
      const n = this.notes[this.nextIndex++];
      const offsetInNote = Math.max(0, songNow - n.time);
      if (offsetInNote >= n.duration) continue;
      const when = at(n.time + offsetInNote);
      const src = ctx.createBufferSource();
      src.buffer = this.voice(n.midi);
      const g = ctx.createGain();
      const level = 0.25 + 0.75 * n.velocity;
      const endAt = at(n.time + n.duration);
      const release = this.instrument === "guitar" ? 0.2 : 0.3;
      g.gain.setValueAtTime(level, when);
      g.gain.setValueAtTime(level, endAt);
      g.gain.exponentialRampToValueAtTime(0.001, endAt + release);
      src.connect(g).connect(this.master!);
      src.start(Math.max(ctx.currentTime, when), offsetInNote);
      src.stop(endAt + release + 0.02);
      this.active.add(src);
      src.onended = () => this.active.delete(src);
    }
    if (songNow >= this.duration + 0.3) {
      this.stopVoices();
      this.pausedAt = 0;
      this.onEnded?.();
    }
  }
}
