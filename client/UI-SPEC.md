# Whisper — UI Specification

Two pages. Plain HTML/CSS/JS, no build step, deployed to Vercel with root
directory `client`.

| Page | File | Purpose |
| --- | --- | --- |
| Landing | `index.html` | What Whisper is, in one screen. Particle-text hero over the video. |
| Speaker | `speak.html` | The live tool. 8 AI-predicted options in a ring, joystick-driven, speaks aloud. |

---

## 1. Art direction

### 1.1 The reference

Everything is derived from one film still: a figure on a cliff edge at golden
hour, backlit cumulus towering behind them, telephone poles running off the
ridge, a laptop screen glowing cold blue against all that warm light.

Three things in that image do real work for us:

- **The poles.** A line of communication running off into cloud. That is
  literally the product — a signal leaving a body and reaching someone.
- **The one cool light.** The laptop screen is the only cold colour in a warm
  frame. That becomes our single accent, reserved for *live* state — the
  highlighted option, the active connection. Nothing else gets to be blue.
- **The scale.** One small figure, enormous sky. The UI keeps that ratio:
  generous emptiness, small dense type, nothing shouting.

### 1.2 Palette

Sampled from the still. Warm near-black through to cloud cream, one cold accent.

| Token | Hex | Use |
| --- | --- | --- |
| `--ink-900` | `#0a0807` | Page ground, deepest shadow |
| `--ink-800` | `#131010` | Panel ground |
| `--ink-700` | `#1e1815` | Raised surface |
| `--umber-600` | `#2f231a` | Hairlines, dividers |
| `--umber-500` | `#4a3524` | Borders on warm surfaces |
| `--ember-400` | `#c8762f` | Deep amber, pressed states |
| `--ember-300` | `#e0964a` | Primary amber |
| `--gold-300` | `#edb46a` | Highlight amber, particle blend |
| `--gold-200` | `#f4cd92` | Bright cloud edge |
| `--haze-100` | `#f6e6cd` | Primary text on dark |
| `--haze-50` | `#fbf3e6` | Brightest text |
| `--signal` | `#9fc4e8` | **Reserved.** Live/selected state only |
| `--moss` | `#46523c` | Cliff green, rare muted accent |

Contrast floor: `--haze-100` on `--ink-900` is ~15:1. Option text on the ring
must never drop below 7:1 — this is an assistive device before it is a demo.

### 1.3 Typography

| Role | Face | Notes |
| --- | --- | --- |
| Display | **Cormorant Garamond** 300 | Hero and section heads. Huge, light, wide tracking. Ethereal comes from *air*, not glow. |
| Interface | **Public Sans** 300/400/600 | Body, options, buttons. Designed for US government accessibility — high x-height, open apertures. |
| Telemetry | **IBM Plex Mono** 400 | Status pills, the trace log, anything machine-emitted. |

Rules:
- Display face never below 28px and never above 300 weight.
- Labels are small-caps-ish: 11px, `letter-spacing: 0.18em`, uppercase, mono.
- **Option text on the speaker page is Public Sans, not the serif.** Legibility
  beats mood the moment the tool is in use.

### 1.4 Motion

The background video already moves. Everything else is nearly still.

- Transitions 400–700ms, `cubic-bezier(0.16, 1, 0.3, 1)`.
- The only continuous motion in the UI chrome is the highlight breathing on the
  active option (2.4s, opacity 0.85→1, no scale).
- `prefers-reduced-motion` pauses the video, freezes particles into formed text,
  and kills the breathing.

---

## 2. What we are deliberately NOT doing

The brief said avoid the look of an AI-vibecoded UI. Concretely, these are the
tells, and the counter-move each time:

> **Revision.** The build now uses **liquid glass** panels and rounded
> geometry by explicit request. Glass is doing a real job here: the
> background video is shown *untinted*, so legibility has to come from
> panels that carry their own local contrast rather than from a wash over
> the whole film still. The rest of the anti-generic direction stands, and
> the glass is tuned warm (amber-tinted, specular top edge) rather than the
> default cold white frost.

| The tell | Why it reads as generated | What we do instead |
| --- | --- | --- |
| Violet→indigo gradient (`#8b5cf6`→`#6366f1`) | The default accent of every scaffold. *(Note: this is `ParticleText`'s default `highlightColor` — we override it to amber.)* | Amber/honey from the still. Zero purple in the build. |
| `bg-white/10 backdrop-blur-xl` frost on a flat dark page | Cold white glass floating on nothing, used as decoration | Warm glass (`rgba(20,14,11,·)`) with a specular top streak, floating on **real moving footage** it actually refracts. Panels earn their place by solving contrast. |
| Gradient-filled heading text | `bg-clip-text` on the h1 | Solid cream. The particles *are* the effect. |
| Inter / Space Grotesk for everything | One neutral grotesque at every size | Three-face system: serif display, accessible sans, mono telemetry. |
| ✨ emoji in headings and buttons | Emoji as iconography | No emoji anywhere in the product. |
| "✨ Powered by AI" pill above the h1 | Announcing the model instead of the outcome | The value line is about a person speaking, not about a model. |
| Centred hero + `Get Started` / `Learn More` pair | Symmetric, two-button default | Left-aligned hero sitting low in the frame. **One** call to action. |
| Three-column feature grid, rounded icon squares | The universal below-fold block | A single horizontal numbered sequence — 01 NUDGE / 02 PREDICT / 03 SPEAK / 04 LEARN — set as film credits, hairline-separated, no boxes. |
| Slate `#0f172a` + neon glow + `shadow-2xl` | Default dark mode | Warm near-black `#0a0807`, no drop shadows at all, one restrained glow on the live option. |
| Animated gradient blobs | Filler motion | The actual video. |
| Bento grid, fake "Trusted by" logos | Padding out an empty page | The page is short on purpose. |
| "Empower your workflow with AI" copy | Generic value proposition | Specific mechanics: "four directions and a press." |

**Asymmetry is the single biggest signal.** Generated layouts centre everything
and space it evenly. The landing hero sits left and low; the speaker page is an
off-centre ring with a narrow right rail.

---

## 3. Page 1 — Landing (`index.html`)

### 3.1 Structure

```
┌──────────────────────────────────────────────────────────┐
│  WHISPER                            FIREHACKS 2026       │  ← hairline rule under
│                                                          │
│                                                          │
│                    (video breathes here — negative space)│
│                                                          │
│                                                          │
│  ┌─────────────────────────────────┐                     │
│  │  W H I S P E R                  │  ← ParticleText     │
│  └─────────────────────────────────┘                     │
│  A joystick, four directions, and a voice.               │
│  ...two-line value statement...                          │
│                                                          │
│  [ Open the speaker → ]   Runs without hardware.         │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ 01 NUDGE  │ 02 PREDICT │ 03 SPEAK   │ 04 LEARN           │
│ short     │ short      │ short      │ short              │
└──────────────────────────────────────────────────────────┘
```

### 3.2 Requirements

- **R1.1** Full-bleed background video, `autoplay muted loop playsinline`,
  `object-fit: cover`, fixed behind all content, `z-index: 0`.
- **R1.2** Two scrim layers over the video: a bottom-up warm gradient
  (`--ink-900` → transparent, 0–65% height) for text legibility, and a flat 18%
  `--ink-900` wash for overall contrast. Without these the cream type dies
  against the bright cloud.
- **R1.3** Hero heading is `ParticleText` reading **WHISPER**, `trigger="hover"`
  — pointer entry scatters the glyphs and re-gathers them.
- **R1.4** Particle colours: `color: --haze-50`, `highlightColor: --gold-300`.
  Never the component's default violet.
- **R1.5** Hero block is left-aligned, anchored to the lower third. Max width
  56ch on the value statement.
- **R1.6** Exactly one primary CTA → `speak.html`. Adjacent to it, in muted
  text: a note that the tool runs with a keyboard when no hardware is attached.
- **R1.7** The four-step strip is one row on desktop, wrapping to 2×2 under
  760px. Numbers in mono, labels in tracked caps, one line of description each.
  Separated by 1px `--umber-600` verticals. No cards, no icons.
- **R1.8** Top bar: wordmark left, event/stack line right, 1px hairline beneath,
  transparent background.
- **R1.9** Reduced motion: video paused on its poster frame, particles render
  already-formed.
- **R1.10** The page must still be legible if the video fails to load — the
  scrim gradients sit on `--ink-900`, so a failed video degrades to warm black.

---

## 4. Page 2 — Speaker (`speak.html`)

The demo surface. Everything a judge looks at during the money shot.

### 4.1 Structure

```
┌──────────────────────────────────────────────────────────┐
│ WHISPER · SPEAKER      [DEVICE ●][SERVER ●][VOICE ●]     │
├────────────────────────────────────┬─────────────────────┤
│                                    │  CONTEXT            │
│              ○  I'm cold           │  name, time of day, │
│        ○                ○          │  recent phrases     │
│                                    │  ─────────────────  │
│   ○         ┌─────┐          ○     │  TRACE              │
│             │  ▲  │                │  10:41 predicted 8  │
│             │ HUB │                │  10:41 → highlight  │
│             └─────┘                │  10:42 rejected     │
│        ○                ○          │  10:42 re-predicted │
│              ○                     │  10:42 spoke        │
├────────────────────────────────────┴─────────────────────┤
│  "I'd like to sit up, please."          [Speak again]    │
│                                         [Not what I meant]│
└──────────────────────────────────────────────────────────┘
```

### 4.2 The ring — the core idea

Eight options on an **ellipse** (rx 380 / ry 250 desktop), one per compass
direction, because the physical joystick has exactly eight reachable positions.
The screen layout *is* the input topology — a user learns "up-left is always
top-left" and stops reading.

- **R2.1** Slots in fixed compass order clockwise from top: `up`, `up_right`,
  `right`, `down_right`, `down`, `down_left`, `left`, `up_left`.
- **R2.2** A slot's screen position never changes. Fewer than 8 items leaves
  slots empty rather than reflowing — positional memory is the accessibility
  win, and reflow would destroy it.
- **R2.3** Selection is a single glass **lens** (`.ring__lens`) that *flows*
  between slots, not a highlight class toggling per slot. Because every slot
  is the same size, the lens only ever translates — no width/height
  animation, no reflow, which is what removes the choppiness. It squashes
  slightly mid-flight (`scale(1.07, 0.9)`) so it reads as liquid rather than
  a box teleporting. The active slot drops its own glass so you never get two
  stacked panes.
- **R2.4** Centre hub shows the last direction received and pulses on `press`,
  so the room can see the hardware working even when a nudge changes nothing.
- **R2.5** Ellipse radii are CSS custom properties, so the ring shrinks on
  smaller viewports without touching JS.
- **R2.6** Below 900px the ring degrades to a **vertical list** in the same
  compass order, keeping index positions stable.

### 4.3 Input contract

Backend sends state, frontend sends nothing (the ESP32 posts to the backend
directly). The frontend maps directions to intent locally only in mock mode.

Consumed over WebSocket `/ws`:

| Message | Effect |
| --- | --- |
| `{"state":"options","items":[...],"highlight":0}` | Render/replace ring, set highlight |
| `{"state":"speak","text":"..."}` | Show sentence large, speak via Web Speech |
| `{"state":"expanding"}` | Hub enters thinking state |
| `{"state":"confirm","text":"..."}` | Show sentence, await press |
| `{"state":"idle"}` | Dim ring |
| `{"state":"context", ...}` | Update the context rail |

- **R2.7** Unknown `state` values are logged to the trace and otherwise ignored.
  Never throw on an unrecognised message — the backend will change under us.
- **R2.8** Direction semantics with the frozen 4-way contract:
  `up` = previous slot, `down`/`right` = next slot, `left` = regenerate,
  `press` = select. If firmware later sends `up_right` etc., jump straight to
  that slot. **Both are supported from day one.**

### 4.4 Fallbacks — non-negotiable for a live demo

- **R2.9 Keyboard path.** Arrow keys move, `Enter`/`Space` selects, `R`
  regenerates, `1`–`8` jump directly to a slot. The whole demo is completable
  with no hardware and no backend.
- **R2.10 Mock mode.** If the WebSocket fails or is absent, the page runs a
  local scripted agent with plausible AAC phrases and shows a `SIMULATED` badge.
  Frontend is never blocked on backend or AI being ready.
- **R2.11 Connection pills.** `DEVICE` / `SERVER` / `VOICE`, each green when
  live, amber when degraded, dim when down. A judge can see at a glance which
  parts are real.
- **R2.12 Voice unlock.** Autoplay policy blocks programmatic `audio.play()`
  before a user gesture. The first interaction "blesses" the audio element
  (muted play → pause) so later joystick-driven playback is allowed; until
  then `VOICE` shows amber with a "click to enable" affordance.
- **R2.13 Voice picker** in the header, persisted to `localStorage`, so the
  voice can be chosen during rehearsal instead of during the demo.

### 4.5 The brain rail

Makes the agent visible instead of a black box — the thing that separates this
from a hardcoded demo in a judge's mind.

- **R2.14** `CONTEXT`: user name, time of day, and the last few chosen phrases —
  i.e. exactly the inputs `predict_options()` receives.
- **R2.15** `TRACE`: timestamped mono log, newest at the bottom, auto-scrolled.
  Rejections render in amber so the learning moment is visually obvious when a
  volunteer corrects a wrong guess on stage.
- **R2.16** Rail collapses under 1100px; the ring always wins the space.

### 4.6 Speech

- **R2.17** On `state:"speak"`, `tts.js` POSTs to our backend `/api/tts`, which
  forwards to the self-hosted **Kokoro FastAPI** server; the returned audio
  becomes a Blob URL on a hidden `<audio>` element. A manual **Speak again**
  control replays the last sentence (demos need repeats). The browser's
  `speechSynthesis` is deliberately not used — see [TTS-SETUP.md](../TTS-SETUP.md).
- **R2.18** The sentence is also rendered in `aria-live="polite"` — for a screen
  reader user *and* so it survives a muted laptop.
- **R2.19** Cancel any in-flight utterance before speaking a new one.

---

## 5. Configuration

- **R3.1** API base resolves in order: `?api=` query param → `localStorage`
  → default. Set it at demo time from the URL bar, no redeploy.
- **R3.2** WebSocket URL derives from the API base (`http`→`ws`, `https`→`wss`).
- **R3.3** Default when served from localhost: `http://localhost:8000`.

> **Deployment note.** Vercel's Python serverless functions **do not support
> WebSocket connections.** The `/ws` endpoint cannot work on
> `fire-hacks.vercel.app`. For the demo the backend runs locally on `:8000`
> (which is already required — the ESP32 posts to a LAN address), and the client
> is pointed at it with `?api=http://<laptop-ip>:8000`. The Vercel deploy stays
> useful for the landing page and REST endpoints.

---

## 6. Accessibility

This is an AAC device. These are requirements, not polish.

- **R4.1** Ring is `role="listbox"`, options `role="option"` with
  `aria-selected`. Highlight changes move `aria-activedescendant`.
- **R4.2** Option text ≥ 7:1 contrast, ≥ 20px, never truncated — options wrap.
- **R4.3** Every control reachable by keyboard with a visible `--signal` focus
  ring. No focus trap.
- **R4.4** Colour is never the only signal: the highlighted option also carries
  a ring and a scale-free glow.
- **R4.5** Full `prefers-reduced-motion` path across video, particles, breathe.

---

## 7. File map

```
client/
  index.html        landing
  speak.html        speaker tool
  style.css         tokens, glass system, shell, landing
  speak.css         speaker page + liquid ring
  particle-text.js  vanilla port of the React component
  target-cursor.js  vanilla port; GSAP via CDN, degrades to native cursor
  speak.js          WS client, mock agent, input, TTS
  config.js         API/WS resolution
  login.html        preserved from the starter kit
  home.html         preserved from the starter kit
  auth.css          original starter-kit styles
  script.js         original auth logic
```
