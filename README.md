# ChordifyNode

Record or upload audio (MP3 / WAV / M4A) and turn it into playable **piano notes & sheet music** or **guitar tabs with chords**. It detects **chords and several notes at once**, not just a single melody. Everything runs locally in the browser, so audio never leaves your device.

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
```

Click **"Try the demo (melody + chords)"** on the home page to see the full pipeline without your own audio.

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build && npm start` | Production build / serve |
| `npm run test:poly` | Polyphonic accuracy tests on synthesized audio: block chords, melody over chords, 7th chords, strummed guitar (notes, chord names, sheet-music validity, playable guitar grips). Takes about 2 minutes on CPU. |
| `npm run test:engine` | Melody-mode tests (clean, noisy, detuned, vibrato, A0 bass, C8, repeated notes, silence, noise, grid alignment) |
| `npx tsx scripts/make-samples.ts` | Regenerates `public/samples/ode-to-joy.wav` |

## Detection modes

| Mode | Engine | Best for |
| --- | --- | --- |
| **Chords & notes** (default) | [Basic Pitch](https://github.com/spotify/basic-pitch-ts) neural network (Spotify, Apache-2.0) via TensorFlow.js, running on the GPU (WebGL) in a Web Worker | Piano, guitar, anything with several notes at once |
| **Melody only** | Hand-written YIN pitch tracker | Singing, whistling, single-note solos |

You can switch modes on the results screen, which re-analyses the same audio.

## Easy arrangement vs. full transcription

On the results screen, **Easy arrangement** (the default) turns the *whole song* into one playable part, Simply Piano / Simply Guitar style, whatever instruments it had. Drums can't become notes, so their **rhythm** is kept instead (`lib/music/easy.ts`):

- **Piano:** the right hand plays the main melody, one note at a time. The left hand plays bass + chord on the song's own groove: kick-drum hits become bass notes, and snare/hi-hat hits become chord stabs.
- **Guitar:** chord shapes strummed on the song's groove, with ↓ on the beat and ↑ in between. Chords are simplified to beginner-friendly triads.

**Full transcription** shows every detected note exactly as played.

## Architecture

There's no server. The DSP runs in a **Web Worker** in the browser.

```
lib/audio.ts          decode any browser-supported format → mono 22.05 kHz
lib/dsp/worker.ts     Web Worker entry; picks the engine per mode
lib/dsp/poly.ts       Basic Pitch → notes; removes octave ghosts, sub-harmonics and release blips;
                      per-key activations → harmony features
lib/dsp/analyze.ts    YIN melody tracker, onsets, tempo, chroma (shared helpers)
lib/music/arrange.ts  beat alignment + 16th-note quantization, key detection, chord naming
                      (maj, min, dim, sus2, sus4, 7, maj7, m7; bass-note and key aware),
                      PIANO: treble/bass split → ABC grand staff with chords → abcjs
                      GUITAR: Viterbi search over playable grips (≤ 6 strings, ≤ 4-fret span)
                      MIDI via @tonejs/midi
lib/music/theory.ts   keys, chord templates, guitar chord-shape finder
lib/player.ts         MIDI playback (synth piano / Karplus–Strong guitar)
lib/export.ts         .mid, .txt, .pdf (piano PDFs include the engraved sheet music)
public/model/         Basic Pitch model weights (~900 KB)
```

Speed: in the browser (GPU), about 3× faster than real time. An 18-second clip takes about 6 s, including model load.

## Limits and handling

- Full band mixes work, but drums and effects add stray notes (a warning is shown). Solo piano or guitar gives the cleanest results.
- Quiet notes an octave above a louder one are ambiguous (harmonic vs. played octave). They are kept, and they never change chord names.
- Files over 5 minutes are truncated with a warning. The maximum upload size is 60 MB.
- Tempo can land on half or double time. Use the BPM control, or its *double* / *half* shortcuts.
- The mic recorder turns off echo cancellation, noise suppression, and auto-gain, because they distort music.

## Putting it on GitHub

`node_modules/` and `.next/` are git-ignored. They're rebuilt by `npm install` / `npm run build`, so the repository is only about 40 files.

```bash
git commit -m "ChordifyNode"
gh auth login
gh repo create chordifynode --public --source=. --push
```
