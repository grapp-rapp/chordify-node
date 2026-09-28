# ChordifyNode — Project Handoff (for a new AI assistant)

Paste this whole file into the new assistant at the start of the conversation.

---

## 1. What this is

**ChordifyNode** is a free web app. The user uploads or records a song (MP3/WAV/M4A), and the app turns it into **easy guitar chords and tabs at a chosen difficulty level**. Everything runs **in the browser**: there is no server, and audio never leaves the device.

- **Live site:** https://chordify-node.vercel.app
- **GitHub repo:** https://github.com/grapp-rapp/chordify-node (public)
- **Local folder (Windows):** `C:\Users\משתמש\song converter`
- **Owner:** a beginner programmer. Give **very simple, numbered, click-by-click instructions**, and explain what went wrong in plain words.

## 2. How the owner updates the live site (important)

The owner uploads files through the **GitHub website** (drag and drop). They do **not** use `git push`: the local repo has no remote, and `gh` isn't logged in.

1. Open github.com/grapp-rapp/chordify-node, then **Add file → Upload files**.
2. Drag the changed **folders** (not the loose files inside them), e.g. `app`, `components`, `lib`, `scripts`. Dragging only files puts them at the repo root and breaks the build.
3. Click **Commit changes**. Vercel usually redeploys automatically.
4. If Vercel doesn't update, go to the Vercel project → **⋯ (top right) → Create Deployment →** type `main`.
   **Never use "Redeploy"** on an old deployment, because it rebuilds that old commit.

Known consequence: files deleted locally stay on GitHub, because web upload can't delete. Four old piano components (`InstrumentToggle`, `PianoRoll`, `SheetMusic`, `StyleToggle`) may still be on GitHub. They're harmless and the build still passes.

Google Search Console is set up and verified with the HTML-file method: `public/googledaa74873af3e5deb.html`. **Never delete that file.** The sitemap and robots files come from `app/sitemap.ts` and `app/robots.ts`.

## 3. Tech stack

- **Next.js 16.3.6** (App Router, Turbopack), React 19, Tailwind CSS v4, lucide-react icons, TypeScript.
  ⚠️ `AGENTS.md` says: *"This is NOT the Next.js you know"*. Read `node_modules/next/dist/docs/` before using Next APIs.
- **Polyphonic note detection:** `@spotify/basic-pitch` (TensorFlow.js 3.x, WebGL) in a **Web Worker**. The model files live in `public/model/`.
- **Melody-only mode:** a hand-written YIN pitch tracker.
- **Playback:** recorded samples from the MusyngKite soundfont (gleitz.github.io/midi-js-soundfonts, loaded on demand), with a synth fallback when offline.
- **Export:** MIDI (`@tonejs/midi`), TXT, PDF (`jspdf`). `abcjs` is only used by old piano code.
- Dev-only packages: `tsx` (runs the test scripts), `audio-decode` (decodes MP3 in Node for testing).

## 4. Commands

```bash
npm install
npm run dev          # http://localhost:3000
npm run build        # production build (must pass before uploading)
npx tsc --noEmit     # typecheck
npx eslint .         # lint
npm run test:engine  # melody-mode tests (11 checks, ~30 s)
npm run test:poly    # polyphonic + guitar-level tests (~3 min on CPU)
npx tsx scripts/analyze-song.ts <song.mp3> <startSec> <durSec> <out.json>   # run a real song in Node, cache the analysis
npx tsx scripts/inspect-song.ts <out.json> guitar 16                         # print the arrangement bar by bar
```

All tests pass on the latest commit.

## 5. Pipeline / architecture

```
lib/audio.ts        decode upload → mono 22,050 Hz (OfflineAudioContext); starts the worker
lib/dsp/worker.ts   Web Worker. Has a shim: defines `window = undefined` because tfjs 3.x
                    crashes in workers (`if (!window)` bug). Don't remove it.
lib/dsp/poly.ts     Basic Pitch → notes; removes artifacts (sub-octave ghosts, short blips,
                    re-joins held notes split by drums); per-key chroma for harmony; tempo
lib/dsp/analyze.ts  YIN melody tracker; shared helpers: rhythmEnvelopes (full band + kick band <150 Hz),
                    estimateTempo (metre-aware: beat + 8ths + half bar, kick-weighted; fixed a 3:2 error),
                    chromagram
lib/music/beats.ts  DP beat tracker (Ellis/librosa style) on the kick-weighted envelope + downbeat
                    detection (bass-note changes, kick, snare). Gives a TimeMap (seconds ↔ 16th steps)
                    so the grid follows real tempo drift.
lib/music/arrange.ts  quantize → key detection (Krumhansl) → chord detection (maj, min, dim, sus2, sus4,
                    7, maj7, m7; key prior + bass bonus) → guitar/piano output, text and MIDI.
                    arrange(analysis, instrument, tempo?, style "easy"|"full", level 1|2|3)
lib/music/easy.ts   Easy arrangements: groove detection, melody skyline (piano), and the GUITAR LEVELS:
                    levelShape(), chooseCapo(), dropRareChords(), onePerBar(), guitarStrums()
lib/music/theory.ts key and chord templates, guitarChordShape() (generic voicing finder)
lib/player.ts       sampled MIDI playback with a look-ahead scheduler
components/         LevelPicker, ChordSheet (songbook view), GuitarTab (Chords | Tab | Text views),
                    ChordStrip (chord diagrams), ResultsView, MicRecorder, UploadDropzone, ModeToggle, ProgressPanel
app/page.tsx        main page (guitar-only; level state lives here, default = Beginner)
```

## 6. Guitar levels and play-along (the current main feature)

**Every level is the song's own notes** (the owner rejected strummed-chord patterns as "weird strokes, not the song"). The code is `guitarMelody()` in `lib/music/easy.ts`, used with part = "melody". The strummed "chords" part still exists in the engine and tests, but not in the UI.

| Level | What you play |
|---|---|
| ⭐ Easy (default) | the tune on an 8th-note grid, repeated notes merged (every pitch change is kept, so it stays recognisable), frets 0–5 |
| ⭐⭐ Medium | the full tune note for note, frets 0–9 |
| ⭐⭐⭐ Hard | the full tune plus the song's own chord notes under it (≤2, not the bass, not the tune's neighbours) |
| 🎯 Exact notes | every detected note |

Verified on Crazy Frog – Axel F: Easy plays F–D–G–D / A–A♯–A–F–D–A in first position.

- **TabHighway** (`components/TabHighway.tsx`, canvas): a Simply-Guitar-style scrolling highway. Notes are fret bubbles; notes played together are joined into one chord block with the chord name; there is a glowing playhead, and clicking seeks.
- **Play along:** the original recording plays under the guitar part through `<audio>` with `preservesPitch`. The arrangement is laid out at the measured beat length (`TimeMap.beatPeriod`), with `audioOffset`/`audioRate` in the Arrangement, so song time = offset + t × rate. It is re-synced when it drifts more than 120 ms.
- **Speed** 60/80/100/120% (`MidiPlayer.setSpeed`), plus song and guitar volume sliders.
- Known issue: the bar-start (downbeat) guess can be one beat off (Axel F's riff starts on beat 4 of the previous bar). Playing along isn't affected; bar numbers are.

## 7. History / key decisions

1. First build: Next.js + a planned Python backend. Python wasn't installed, so all DSP was moved to the browser.
2. Added polyphony (Basic Pitch) plus a melody-only mode.
3. Added "easy arrangements" of whole songs (drums become rhythm, not notes).
4. Real songs sounded bad, which led to: real instrument samples, beat tracking, and downbeat detection.
5. SEO: metadata, sitemap, robots, Google verification.
6. **The owner decided: guitar only** (piano was too hard and sounded bad). Added the difficulty levels, capo, and chord sheet. The piano engine code remains in `lib/` (the tests use it), but there's no piano UI.

Test songs used (on the owner's PC, not in the repo): *Crazy Frog – Axel F* (D minor, 138 BPM; Beginner gives capo 5 with G/Am/Em/F/A shapes) and *Dumb Ways to Die* (128 BPM, F–C alternation).

## 8. Known limitations and ideas for next steps

- Only tested on synthetic audio plus two real songs. **Ask the owner which song sounds wrong and where** before changing algorithms.
- Downbeat (bar start) detection is heuristic and can be off by 1–2 beats on some songs.
- A melody over busy drums can pick up stray notes (Exact notes mode only).
- Web upload can't delete files on GitHub. A proper `git push` setup would help (`gh auth login`, `git remote add origin …`, `git push -f origin main` — the local repo history is complete).
- Ideas: a "strum pattern" picker, a transpose/key-change button, chord-change practice mode, slower playback speed, and a better name (the "Chordify" brand belongs to another company).

## 9. Working agreements with the owner

- Keep instructions extremely simple (numbered steps, what to click).
- The owner asks to commit after each change ("Commit the working tree changes with a sensible message"). Use a clear message, and end commit messages with a co-author line if their tool expects one.
- Before saying something works, run `npx tsc --noEmit`, `npx eslint .`, `npm run build`, and the relevant tests.
