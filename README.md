# the-eye

An MCP server that lets an agent **measure what is visible on a macOS screen over time**, as numbers instead of
screenshots. It captures a screen region at the display's full refresh rate (ScreenCaptureKit) and logs one row per
display refresh. From that log it reports how smooth an animation *actually looked*: real on-screen fps, stalled
refreshes, hitches, frame-gap distribution, and the size/position curve of whatever moved.

Built to answer "did this change make the animation smoother?" objectively, and to A/B app builds and settings.
It's meant to be an agent's default way to test a macOS app's UI (SwiftUI or AppKit) on its own: find the element
(accessibility tree), drive it (`eye_drive`), and measure the result, without asking the user to try it.
Websites work the same way: `eye_drive {url}` (see [Websites](#websites)).

## How it measures

ScreenCaptureKit reports a status for every display refresh it observes in the region:

| row | meaning |
|---|---|
| `c` (complete) | the compositor showed a **new image** in the region at time `t` |
| `i` (idle) | a refresh happened but the region **did not change** |
| (no row) | no callback for that refresh. Either the display skipped it, or the capture missed it. On ProMotion, a late frame often makes the display skip the refresh entirely, so a missing frame shows up here rather than as idle. |

For every new image the native helper also computes, on a downsampled luma grid:

- `interval_ms`: time since the previous new image
- `diff` / `changed_frac`: mean absolute change and fraction of pixels changed vs the previous image
- `mean_luma`: average brightness
- `bbox_*`: extent (points, region-relative) of everything that differs from the **first** frame. If you start
  recording with a panel closed, this is the panel's visible width and height over time.

The analyzer splits the log into **animation segments**: runs of visibly-changing frames, split by pauses over 150 ms.
For each segment it reports:

- **fps**: new images per second, compared against the display refresh (120 on ProMotion). **This is the headline
  number.** Every refresh without a new image is a frame the viewer didn't get.
- **obs_hz**: refreshes the capture observed. ProMotion lowers the refresh rate on static content, so judge against this.
- **stall%**: observed refreshes mid-animation that showed **no new image**. This is a lower bound on dropped
  frames (see the missing-row case above).
- **gap p50/p95/max**, **hitches** (gaps of at least 1.5 frames) and **long hitches** (at least 3 frames)
- **velocity jumps**: frames where the extent's speed changes abruptly (stutter in the motion curve, not just in timing)
- **extent from→to [min..max]**: the size curve of what moved

The stream is asked for frames no closer than two thirds of a refresh apart, not exactly one refresh: display times
jitter by microseconds, and a limiter set to exactly one frame per refresh throws away every frame that comes a hair
early, which reads as judder the app never had. Each row also carries the box around what changed since the frame
before (`mv_*`), the measurement that lets a report follow a thing that slides or shrinks.

## What a viewer would have noticed

Numbers are for comparing; a person watching just *sees* that something stuck. So every report — each `eye_drive`
reply, the session's final report, `eye_status` on an open session, `eye_report` — opens with a verdict and the things a viewer would have noticed,
worst first (`src/notice.ts`), and the table follows for whoever needs it:

```
LOOKED BROKEN: 1 freeze, 1 juddering motion · 71.7 fps of 120 while moving.
✗ HUNG 150ms (18 refreshes with no new image) at 1.28s, 61% into the motion
    why: Janky's main thread was blocked 146ms from 1.28s · 32 stack samples
      in app code: static Janky.Model.reload() (97%)
      executing: mach_absolute_time [libsystem_kernel.dylib] (91%)
      commonest stack: mach_absolute_time [libsystem_kernel.dylib] ← static Janky.Model.reload() ← Janky.Stage.step() ← …
~ uneven: 5 of 43 frames of the motion arrived late (71.7 fps average of 120; pacing irregular, not one freeze)
· answered 50.0ms after click "Go" at 0.87s (from the moment the step was sent)
· the motion: 0.92s–1.52s (600ms) · width 0pt→405pt · 71.7 fps of 120
```

Verdicts: `LOOKED SMOOTH` · `MOSTLY SMOOTH` (visible only if you look for it) · `ROUGH` · `BROKEN` · `NOTHING MOVED` ·
`NO ANIMATION, only instant changes`. `✗` is clearly visible, `~` visible if you look, `·` a fact rather than a defect.

| noticed | rule |
|---|---|
| **HUNG / FROZE / hiccup** | a frame arrived ≥3 refreshes late once a motion is under way; late frames that changed nothing (the capture delivers identical "new" images mid-freeze) are merged into the same freeze, while a slow ease-out tail, which still delivers a frame every refresh, never counts (and well past its own cadence): ≥100ms / ≥50ms / less. A freeze long enough to split one motion into two is still one freeze ("stopped dead at 350pt and carried on") |
| **JUDDER / uneven** | more than a quarter / a tenth of a motion's frames arrived late, with no single freeze to blame |
| **steady low rate** | evenly every N refreshes (60 on a 120Hz display): something *drives* it at that rate — a timer, a 60Hz display link, video, ProMotion throttling — rather than frames being dropped |
| **sparse** | under 75% of the display rate and none of the above: choppy, or simply something that updates now and then |
| **SNAPPED / jump** | the moving edge leapt ≥12pt and ≥4× its neighbouring frames in one frame, without a freeze to explain it |
| **FLASH** | the region's mean brightness left for one or two frames and came straight back |
| **wobble** | the moving edge changed direction 4+ times |
| **LAGGED / slow** | first visible change more than 300ms / 150ms after a press, scroll or gesture `eye_drive` sent |
| facts | each motion's time span, travel (`width 0pt→405pt`), overshoot-and-settle, fps; instant **pops** (a change that took one or two frames, no transition); how fast the screen answered each step; a motion cut off by the end of the recording |

**Why.** With the probe in the app (`eye_drive` puts it in by itself), each freeze carries `why:` lines from the probe's main-thread watchdog
(see below): the stall that overlaps it, the app function that was running and the stack — or the statement that the
main thread was free the whole time, which puts the lost frames after the app (render server, GPU, window server) or
means the motion isn't driven from the main thread. A main-thread stall during a motion that no visible gap accounts
for is listed too. Without the probe the report says the cause was not measured and how to get it.

Test: `node test/notice.mjs` (synthetic recordings, no screen) and `node test/why-e2e.mjs` (a real fixture app that
blocks its main thread mid-animation; takes the input lock for a few seconds).

## What moved it

Under each motion the report adds `moved by:` — the engine behind the frames, fitted to them without being asked
(`src/physics.ts`). The agent reading the report knows what a spring is; what it lacks is the reflex that turns
moving pixels into one. This is that reflex.

```
· the motion: 1.06s–1.60s (542ms) · what moved travelled 301pt right · 120 fps of 120
    moved by: a SPRING, damping ratio 0.5, response 0.5s — in code: .spring(duration: 0.5, bounce: 0.5), or stiffness 158 damping 12.56 at mass 1; rubbery: it bounces back and forth before settling
      it settled 700ms after it began, overshot 16% past its target, fastest at 14% of the way through · fit off by 0.0% of the travel over 115 frames · read from the region's brightness, which follows the area that changed
```

(The fixture behind that line runs a `CASpringAnimation` with stiffness 157.91 and damping 12.57.)

| it says | model | numbers |
|---|---|---|
| **a SPRING** | damped harmonic oscillator, optionally launched already moving | damping ratio, response; `.smooth/.snappy/.bouncy(duration:)` or `.spring(duration:bounce:)`; stiffness and damping at mass 1; a word for the feel |
| **a TIMING CURVE** | cubic bezier over a fixed duration | the named curve (SwiftUI/CSS/Core Animation eases, polynomial ease-outs, Material) or its four control points; duration |
| **a PER-FRAME LERP** | `x += (target − x) × k` every frame; friction on a thing let go at speed (scroll momentum) draws the same curve | `k`, half-life, and the same thing as a decay factor per millisecond |
| **a BOUNCE** | let go, constant acceleration, rebounds off its target keeping a share of its speed | gravity in pt/s², when it first lands, the share kept (restitution), rebounds seen |
| **or equally:** | a second engine fits as well | a critically damped spring and an ease-out are the usual pair |
| **nothing simple** | no single engine reproduces the frames | driven by hand, retargeted mid-flight, or several animations overlapping |

Then what it measurably did, whatever produced it: settle time, overshoot, where it was fastest, and how far the best
model is from the frames (% of the travel).

The motion is read off the pixels, and which reading to believe is decided by following the thing itself
(`src/track.ts`). Every frame carries the box around what changed *since the frame before*: for a slide that is
where it was plus where it is, for a shape growing or shrinking it is the larger of its two outlines, and anything
that changed once and stayed (the pressed button, a title bar going active) is not in it. From those boxes:

- **something travelled** (a slide: nothing gets brighter, the size never changes): the fit reads its position;
- **both dimensions changed at once**: the fit reads one dimension's size, because the changed *area*, and with it
  the brightness, is the product of two curves and belongs to no engine;
- **one edge moved** (a bar opening): the region's mean brightness moves in step with the edge and is sub-pixel
  exact, so the fit reads that, with the position as second opinion;
- **nothing moved at all** (a fade: every pixel drifts a level or two per frame, no edge goes anywhere): the motion
  line says `nothing moved: it dimmed in place, a fade` and the fit reads the brightness. Such a run of frames
  counts as a motion although no single pixel steps (`drift_threshold`, mean change per frame);
- nothing could be followed (scattered changes, an old run): brightness, then the box of everything that differs
  from the first frame, then the running total of frame-to-frame change.

The line says which one was used, and the motion line says what was seen: `what moved travelled 401pt right`,
`what moved grew 60pt×44pt → 300pt×140pt`. An extent aimed with `anchor_x` still comes first when recorded. The
frames after a motion "ends" (it stopped changing visibly) are part of the fit: a spring or a lerp creeps on below
that threshold, and aiming at where it had got to instead of where it was going bends every number. A lerp is also
fitted per delivered frame instead of per second; when that fits clearly better the line says the motion is
frame-rate dependent (it stepped once per callback and fell behind wherever frames dropped).

A motion starts where the followed thing starts moving. A button lighting up under the press, then 60ms of nothing,
then the animation, used to be one segment, and the pause was charged to the animation as missing frames.

Position and size are read on the capture's grid (1–1.5pt), brightness is finer. On the fixture below all of them
come back within about 4% of the numbers the code asked for.

Test: `node test/physics.mjs` checks the fitter against SwiftUI's own `Spring` and `UnitCurve` (built from
`test/fixtures/truth.swift`), degraded the way a capture degrades them; `node test/track.mjs` checks the follower
on synthetic boxes (a slide, a grow, a shrink, one moving edge, each with a highlighted button elsewhere and a first
box that swallows both); `node test/feel-e2e.mjs` presses the buttons of `test/fixtures/springy.swift` (a bar on a
known `CASpringAnimation`, a critically damped one, an `easeInEaseOut` and a hand-rolled lerp; a puck that slides on
a spring and on an `easeOut`; a tile that grows and shrinks in both dimensions) and checks the engine and its numbers
come back from the screen alone. The last takes the input lock.

A bounce is only tried when the frames show one: the thing reaches its target, comes back off it and never passes
it (a spring crosses its target, a timing curve does not come back). And every engine answers for the rest after
the last frame too: the motion ended because nothing changed any more, so a spring whose overshoot would only come
after the frames it was fitted to is not what was on screen, and is not offered.

Not recognised as engines of their own: keyframe animations with several legs (they come out as `nothing simple`,
or as the one leg that dominates), `steps()` and anything ticking slower than the display (reported as a low frame
rate, which is what it is), and rotations (no box follows a thing turning in place; brightness sometimes does).

## What a still frame says

A window that is not moving still has things to measure, and a look at one (`eye_snapshot` of a `rect` or an `app`) comes
back with them under `## at rest`, nobody asking. They are read off the one frame: its pixels and the accessibility
frames of what is in it.

```
## at rest (measured off this one frame: its pixels and accessibility frames; approximate)
text: 5 read, ≈9–22pt · weakest contrast 2.7:1 ("Faint hint")
small text: ≈9.5pt "Tiny caption"
low contrast: 2.7:1 #9e9e9e on #ffffff "Faint hint"
almost aligned: "Lower" left edge at x 146, 2pt off "Upper", "Circular" (same width as "Upper")
uneven gaps: "One" · "Two" · "Three" · "Four" (a row): gaps 12, 12, 15pt
overlapping: "Back" and "Front" share 10×20pt
cut off: "Runs off the edge" runs 28pt past the window's right edge
corners: r≈30 continuous — "Still" · square — "One", "Two", "Three" +6 · r≈18 circular arc — "Circular" · r≈19 continuous — "Continuous" · capsule — "Pill"
```

| Line | How it is measured | How far to trust it |
|---|---|---|
| text size | height of the ink from the top of the tallest glyph to the baseline, over the share of the em that capitals and ascenders take in a UI sans (0.72) | ±5% for system-like fonts; a display face with unusual proportions reads off by its own ratio |
| contrast | WCAG ratio between the colour most of the text's frame is painted in and the core of the strokes | within 0.1 on a flat background; not reported over a picture or gradient |
| small / low contrast | under 10.5pt; under 4.5:1 (3:1 from 18pt). Disabled controls are not flagged | thresholds, not verdicts: secondary labels on macOS are legitimately faint |
| almost aligned | leading edges 0.5–3pt apart between twins (same role and size), or one thing just off a line three others hold | frames are the app's own, exact to 0.1pt |
| uneven gaps | three or more same-size things on one line whose spacing differs by 0.75–4pt | exact |
| overlapping | siblings sharing a corner of each other (not a whole side: panes and badges are meant) | exact |
| cut off | a thing outside a scroll area that runs 2pt or more past its window | exact |
| corners | the edge of the fill inside each corner at sub-pixel precision, fitted with a superellipse: exponent 2 is a circular arc, about 2.7 and up a continuous (squircle) corner | arc radius ±1%; continuous radius ±8% (renderers draw the curve slightly differently) |

`measure: false` on `eye_snapshot` skips it; while a recording runs it is skipped unless asked for, because reading
the accessibility tree costs the app frames. Judging what the numbers mean stays with the reader.

## Tools

Five tools. What an agent is sent on connect (the MCP `instructions`, the tool descriptions and schemas) is an
outline; the manual comes a chapter at a time, when its part is used. See [The manual](#the-manual).

| tool | what |
|---|---|
| `eye_drive` | **the one that acts: one session on an app.** Its window recorded, the user's input held, a hand on the mouse and, in a Debug build, a probe inside the app. The first call opens it (`app`; `app_path` starts the app), every call may move, `end:true` closes it and returns what the whole of it looked like. Two ways to move, mixed freely: a `wing` (a line of words, one unbroken motion, things by name: `"7" tap "Add" tap "3" tap "Equals" tap settle`) or exact `steps` (`move`, `click`, `down`/`up`, `scroll`, `pinch`, `rotate`, `smart_zoom`, `swipe`, `press {force}` / `force_click`, `wait`, `wait_until`, `assert`). `hands:false` only watches (no hand, no lock): until `end:true`, for `seconds`, or while a `command` runs. `ask:"…"` puts a yes/no to the person at the machine; `quit:true` quits the app; `duplicates` decides what happens when several copies run. See [Driving live](#driving-live-eye_drive) |
| `eye_snapshot` | one still image. `{rect}`: that screen region as it is. `{app}`: "Just a sec…" lock → raise the window even if covered or minimized → image, element `tree`, `element` at x/y → put everything back exactly → release (the user is held 0.3–0.4s). `{csv, t_s}`: a recording's keyframes near a time. A live image ends with `## at rest` |
| `eye_inspect` | **accessibility view, no recording**: everything the element under a point exposes (default: the pointer), or the element **tree** of an app (`process`) or of the windows visible in a rect, one line per element with its bounds |
| `eye_report` | re-analyze (default: the most recent run; a run folder works as `csv`): `summary`, `timeline`, `explain` (worst gaps × cursor × element × step × main thread), `hover` (element-under-pointer changes), `compare` (runs), `probe` (probe.ndjson / one layer) |
| `eye_status` | displays (id, points, scale, refresh rate), who holds the screen, **what the open session sees right now** (moving or still, extent, what a viewer noticed over the last seconds, command output, live probe layers, optional `tree`), and with `app` every running copy and build of it |

What a call does without being asked:

- **The probe goes in by itself**, once per app launch, when a session opens on an app. When it cannot (no Debug
  build, Xcode is debugging the app) one line says why and the session goes on. `probe:false` skips it,
  `probe:{match, watch}` chooses layers, `probe:"xcode"` prints the commands to send through Xcode's debugger.
- **Frames come back with the words**: the frame the screen settled on after every call and, with the final report,
  the recorded frame at each ✗ (`frames:false` to leave them out).
- **The window comes forward** when a session with a hand opens (also from minimized) and goes back, with everything
  that was above it, when the session ends (`front:false` leaves it where it is).
- **A session with a hand ends by itself** after `idle_s` (30) without a call; the next `eye_drive` call hands over
  its report.
- A watch session (`hands:false`) runs the passive steps (`wait`, `wait_until`, `assert`) and refuses the rest.

Old → new (thirteen tools became five): `eye_act`, `eye_record`, `eye_stop`, `eye_probe`, `eye_lock`, `eye_app`
launch / quit / relaunch → `eye_drive` (`steps` · `hands:false` with `seconds` / `command` · `end:true` · `probe` ·
`ask` · `app_path` / `quit` / `duplicates`) · `eye_glance` → `eye_snapshot {app}` · `eye_peek`, `eye_app list` →
`eye_status`.

### The manual

A tool description is paid for by every session of every agent that has the server connected, used or not. So the
agent-facing text lives once, in [`skills/the-eye/`](skills/the-eye/), and reaches an agent three ways:

| file | what | how it arrives |
|---|---|---|
| `SKILL.md` | the outline: when to use the-eye, the loop in one call, the five tools, the lock, how to read a verdict, the list of chapters | its body is the server's MCP `instructions` (front matter stripped, paths made real), so it is sent on connect |
| `wing.md` `fingers.md` `steps.md` `web.md` `reply.md` `session.md` `measure.md` | the chapters: every word, step, option and reply line | `eye_drive {guide:"wing"}` returns one and does nothing else: no session, no lock, no queue |

- **A wing that cannot be read** is refused before anything opens (no lock is taken for a typo) and comes back with
  its chapter: in full the first time a server hands it over, by name after that.
- **The first use of a part** (a wing, fingers, steps, a website, a report) adds one line that names its chapter,
  unless it was read already.
- **As a skill**: the folder is an [Agent Skill](https://agentskills.io), and the repository is a Claude Code plugin
  that carries it with the server (see [Install](#install)). A client with skills reads the chapters as files.

On connect the server sent 43,204 characters before this split and sends about 24,400 after it; what is left is
mostly the shape of the schemas. `node test/guide.mjs` holds it under 26,000, checks that every chapter is served
and that the chapters name every word `src/wing.ts` parses.

A change to what a tool does goes into the chapter that describes it, and into `SKILL.md` only when the outline
changes.

## Accessibility (AX) context

So an agent knows **what** it is looking at and **where** things are:

- **Hover**: while recording with `ax` (on with a hand, off when only watching or with `profile`), the capture hit-tests the element under the
  pointer up to `ax_hz` (10) times a second. When the element changes, its full description (every attribute,
  actions, parameterized attributes, ancestors, app, window, readable path) goes to the live JSON (`hover`) and to
  `hover.jsonl`; while it stays the same, its frame/state is refreshed every 0.5s. Reports end with a timeline of
  what the pointer was over; `cursor.csv` keeps role/label columns for `eye_report view:"explain"`.
- **Tree**: a session snapshots the element tree of the observed windows at start (`tree: basic|full|none`,
  saved as `ax_tree_start.txt/.json`); `eye_inspect`, `eye_status {tree}` and `eye_drive {look:true}` dump it on demand.
  The observed windows are found by AX hit-testing a grid of points in the rect, so only what is actually on top
  counts (occluded windows and transparent full-screen windows are ignored); `process` picks an app explicitly.
  `basic` folds unlabeled layout groups; `full` lists every node and its actions.
- AX frames are **global** points (same space as the pointer and step x/y; equal to display-local on the main display).
- **Cost:** any AX client makes SwiftUI apps maintain their accessibility graph (measured ~18% more main-thread time,
  −25% fps on NOOTCH!). Use `ax:false` for final fps numbers and A/B runs; reports say when AX was on.

## Layer probe (geometry from inside the app, no pixels)

`swift/EyeProbe.swift` is a small library loaded **into** the target app through a debugger. On every display refresh
(a `CADisplayLink` on the target screen) it walks the layer tree of every visible window and logs each layer's
**presentation** geometry, meaning the live animated values: frame, opacity, and the bounds of its shape path or
`CAShapeLayer` mask. Everything is in display-local points, top-left origin (the same space as the capture), and
timestamped on the same mach clock as `frames.csv`. A rect, `match` and `watch` narrow what is logged and shown.

- **Attach:** a session that opens on an app (`eye_drive {app}`) attaches it by itself, once per app launch
  (`probe:false` skips it; when it cannot attach, one line says why and the session goes on). It builds the library and signs a copy with the **target's own certificate**
  (needed for library validation; the key must be in your keychain). It stages the copy where the app can read it (its
  container when sandboxed) and loads it with `lldb -p`. If Xcode already debugs the app, `probe:"xcode"` returns the commands
  to send through Xcode's `InvokeDebuggerCommand` instead. The target must be debuggable (`get-task-allow`, e.g. a Debug build).
- **What moved each layer, and whether it is what the code asked for.** The probe report fits every moving layer's
  exact presentation values (one per display tick) with the same engines as the screen reading: spring, timing curve,
  per-frame lerp, bounce. Next to it, `declared:` quotes the Core Animation animation the app attached to that layer
  (class, key path, from → to, duration, timing function, a spring's mass / stiffness / damping), read from the layer
  itself, and a verdict says `✓ it ran as declared` or how it differed (interrupted, retargeted, stacked, slowed by
  dropped frames). A layer the app drives by hand each frame (SwiftUI on macOS, a display link) has nothing declared;
  the fit still speaks. Layers that move rigidly with one already described are folded into it.
  Test: `node test/probe-feel-e2e.mjs` (the `springy.swift` fixture with the probe loaded; takes the real input lock).
- **When the in-between was never shown.** A layer that covers a large part of its way in one step is not fitted:
  the report says `moved by: cannot be told`, the step, how long it had gone without an update, and the main-thread
  block that swallowed those positions (function included). The screen reading refuses the same way when over 40% of
  the way went in a single frame. The report ends with everything the app declared to Core Animation, on any layer.
- **What the app said, on the same clock.** A recording of an app also runs `eye-capture watch --exact` on it and
  writes `events.jsonl`: every value change, focus move, window, sheet, menu and announcement, stamped the moment its
  accessibility notification arrived. The report lists them under `what the app told accessibility`, each against
  the step before it and the motion around it (`304ms after click "Ease" · 57% into the motion`), and says under each
  response who was first: `the app knew first` (it reported the change before the screen began to show it), `the
  screen changed first`, or `yet the app reported a change` when nothing visible answered. A run in which the steps
  changed the screen and the app said nothing is flagged: assistive technology was not told. `events:false` on
  `eye_drive` does not attach the observer; fps on the fixture reads the same with and without it.
  Test: `node test/said-e2e.mjs` (the fixture changes a value in its action and announces 200ms later; both are
  200ms gap between them reads 207–208ms).
- **Under the pixels.** A recording of an app also reads what no screen recording can, from four places. Two need
  no root and are always on:
  - **Signposts** (`log stream --signpost` → `signs.txt`): what AppKit, Core Animation and the window server say of
    themselves. Every update cycle of the app, every event it handled, every commit, and the ones the frameworks
    flag as stalls; every frame of the window server, how long it rendered and spent on the GPU, and the ones it
    marks as stalled. So "who was late" works for any app, release builds included, with no probe and no root.
  - **Vitals** (`eye-capture vitals` → `vitals.jsonl`, twenty times a second): the energy, CPU time and wakeups the
    kernel billed to the app alone (`proc_pid_rusage`), plus two private SkyLight readings looked up at run time:
    the window server's own count of display updates (it checks the signpost stream, which is best-effort, and
    counts frames when the stream is absent) and the display's refresh period right now.

  Two need root, and run only when `sudo` runs them without a password (nothing ever asks for one):
  - **dtrace** (`under.txt`): every commit timed inside the app, every frame swap, and every time the window server
    learned that one of *this app's* windows changed and scheduled a frame for it. Pairing each of those with the
    swap that followed gives **the app's own share of the display's frames** and how long each took to reach the
    display, which is what clears or convicts the window server for one window.
  - **powermetrics** (`cost.jsonl`): CPU time of the app and of the window server, GPU and CPU power.

  The report says under a freeze **who was late** and where the time went (`the app was late: it committed nothing
  to Core Animation for 149ms; AppKit's update cycle ran 145ms and AppKit flagged it a stall: 4.8ms of it handling
  an event or committing, so it went to the app's own per-frame code`), tells per motion whether the app drives it
  frame by frame or left it to the window server, how many display frames were its own, how long the window server
  rendered each, and prices moving against rest for the whole machine and for the app alone. The rule for the root
  half: `<you> ALL=(root) NOPASSWD: /usr/sbin/dtrace, /usr/bin/powermetrics` in `/etc/sudoers.d/the-eye`
  (`sudo visudo -f /etc/sudoers.d/the-eye`). `root:false` on `eye_drive` leaves that half out;
  `THE_EYE_UNDER=0` leaves out everything (to measure what the readers cost: nothing measurable on a 120 fps
  animation). Limits: no process is billed for the GPU on Apple silicon, so the GPU is power for the whole machine;
  an animation handed to the window server changes no client window per frame, so its share is every frame the
  server makes while it runs; the dtrace probes for the app's share read two offsets inside the window server
  (found on macOS 27.2), and when they do not match the share is simply not reported.
- **The probe reaches any app when SIP is off.** With System Integrity Protection on, the probe needs a debuggable
  build signed by a certificate in your keychain. With it off the debugger may attach to anything, and the probe
  (built arm64 + arm64e, signed ad hoc when the app is someone else's) loads into release builds, hardened and
  sandboxed third-party apps and Apple's own arm64e apps: layers, main-thread stalls and symbolized stacks included.
- **Recorded alone.** A session on an app's window captures only the target app's windows,
  over mid grey (`--only-pid` in the helper): what shows through a see-through overlay window, or sits over the app,
  is not measured as its motion. `isolate:false` records the screen as it is (the default for a `rect`).
  Test against the real thing: `node test/nootch-see.mjs` (hover, open, at rest, close on NOOTCH!-Dev, probe loaded).
- **Main-thread watchdog (the "why").** While a probe recording runs, a run-loop observer on the app's main thread
  marks the start and end of every turn, and a watcher thread polls that mark every 3ms. A turn longer than 1.25
  display frames is a *stall*: while it lasts the watcher samples the main thread's stack (suspend → walk frame
  pointers inside the stack bounds → resume, a few microseconds, nothing allocated or locked meanwhile), densely for
  the first ~100ms and sparsely after, so a multi-second hang stays cheap. Each stall is one `H` line (start on the
  mach clock, duration, samples) with its frames in `F` lines (Swift and C++ names demangled in-process, image, and
  whether the image is the app's own); a hang still in progress is rewritten once a second. A healthy app pays two
  observer callbacks per run-loop turn. The session's reports and `eye_report view:"explain"` join stalls to
  on-screen gaps through `stalls.json` in the run folder. Stack sampling is arm64-only; on Intel stalls are timed but
  not sampled.
- **Control** is file based (`control.json` / `status.json` in that directory), so it works inside the sandbox.
- **Live:** `<recording>.live.json` is rewritten every 0.25s with the last 0.5s: ticks/s, walk cost, the layers that
  moved (updates, coverage = frames changed / frames in its motion, max gap, current rect/shape) and the `watch` layers.
  `eye_status` and every `eye_drive` reply show it. Expressions get `pr` (the JSON) and `L('label')`.
- **Cost:** about 0.2ms per frame on the app's main thread for a small tree. It's reported in every reply and report.
- **Limit:** it sees what the app hands to the system. Effects the window server renders itself (system glass,
  backdrops) can still lag on screen. The session records the screen at the same moment and aligns the probe report to it.
  Probe rows that update every frame alongside a capture that doesn't change point at the window server.

Tests: `node test/probe-feel-e2e.mjs` (the fixture), `node test/nootch-see.mjs ['<process>']` and
`node test/probe-cost.mjs '<process>'` (a real debuggable app).

Coordinates are **display-local points, top-left origin**. Runs are stored in `~/Library/Caches/the-eye/runs/<time>_<label>/`
(`frames.csv`, `frames.csv.meta.json`, `cursor.csv`, `hover.jsonl`, `ax_tree_start.*`, `actions.jsonl`, `stalls.json` when a probe ran, `keyframes/`). Override the location with `THE_EYE_DIR`.

### Live state

While recording, `frames.csv.live.json` is rewritten 10 times a second with what is visible right now:
- `moving`
- `last_1s`: new frames, idle refreshes, worst gap, hitches
- `anchored_screen`: the top-anchored extent. Its width is measured along a row inside the menu bar, starting from the
  display center; its height is how far the change hangs down. This is the open notch or panel, unaffected by changes elsewhere.
- `changed_extent_screen`: the bounding box of every change since the first frame
- `t0_mach`, `t0_wall`: the recording's clocks. The meta file is only written when the capture ends, so these are
  what lets steps and accessibility events be placed on a recording that is still running.

Commands started by `eye_drive {command}` get `THE_EYE_LIVE` (that file's path), `THE_EYE_RECT` and `THE_EYE_RUN_DIR`,
so a driver script can check state before every action. In step expressions (`wait_until`, `assert`, `guard`) and in
a wing's `until:"…"` / `check:"…"`, `a` is `anchored_screen`, `e` is the changed extent, `p` is the pointer and `h`
the element under it.

`eye_status` reads the same file for the open session. For a stream instead of a question there is a CLI:

```
$ the-eye live                      # = node src/index.ts live [--run DIR] [--seconds N] [--until moving|still]
3.20s MOVING
3.95s still · moved 0.75s · 88 new frames (117 fps) · worst gap 9ms
5.10s HITCH · a gap of 58ms in the last second (3 hitches)
```

One line each time the recorded screen starts moving, comes to rest or hitches, nothing while nothing happens. It
only reads the live file of the newest recording (or `--run`), and waits for one when none runs.

Interactive loop: `eye_inspect` (find targets) → `eye_drive {app, wing}` → read, send the next wing or steps → `eye_drive {end:true}`.

### One at a time

- **One driving session at a time, queued.** Every MCP client starts its own the-eye server, but there is one screen
  and one pointer. Driving calls (`eye_drive`, `eye_snapshot {app}`)
  take turns through a lease in `~/Library/Caches/the-eye/driver.json`. A call that finds another server
  mid-turn joins a FIFO queue (`queue/<pid>.json`) and waits inside the server, with MCP progress notifications, then
  runs and returns its real result — the agent never has to poll or retry. A holder that is idle between its agent's
  calls hands over at once to whoever waits (with nobody waiting it keeps the turn 60s, so one agent's calls stay
  together); a call in flight or an open session finishes first, and the holder's replies say who is
  queued. A wait is capped at 45s (`EYE_QUEUE_WAIT_MS`), below the usual 60s client timeout: the call then answers
  `QUEUED, not run`, and calling again within 20s keeps its place. Servers from older versions (no busy flag) are
  waited out until their lease expires. Read-only calls (`eye_inspect`, `eye_snapshot {rect}`, `eye_status`,
  `eye_report`) never queue. `test/queue.mjs` covers it with a private lease dir (`THE_EYE_LEASE_DIR`).
- **One copy of the app under test, checked by the server.** A family is every copy and every build of an app: same
  executable name, or the same stem once build-variant words are dropped (`NOOTCH!-Dev`, `NOOTCH!`; also the bundle-id
  stem). Before `eye_drive` or `eye_snapshot {app}` touch an app the
  server checks the family; if more than one runs it stops with the list and the choices: `duplicates: "quit_others"`
  (keep the pid you named, else the newest launch), `"relaunch"` (quit all, start the target's `.app` fresh, or
  `app_path`), `"allow"`, or stop and ask the user. Sessions on a `rect` alone flag duplicated apps found in their
  rect. Every app it has seen is watched (every 2s): a copy launched later shows up as a ⚠ line in the next tool result
  and in `eye_status`. `eye_status {app}` lists the family; `eye_drive {app_path}` launches (never a second copy), `duplicates:"relaunch"`
  relaunches and `{app, quit:true}` quits. Test: `test/single.mjs`.

### Waiting on the screen: `the-eye watch`

An MCP server can only answer, never wake the agent up later — so waiting for "the dialog", "the build", "the
window" used to mean polling screenshots. `the-eye watch` is a CLI instead: one line per UI event, as it happens,
from AXObserver (every app's windows, sheets, titles, announcements, values) and NSWorkspace (launch, quit, focus).
It only reads accessibility: no turn in the queue, no lock, no screenshots.

```
$ the-eye watch --app TextEdit --values
13:40:00 ready watching TextEdit
13:40:02 window-opened TextEdit "Untitled 2"
13:40:03 sheet-opened TextEdit — "Save As:" "Tags:" "File Format:" [New Folder | Cancel | Save]
13:40:05 sheet-closed TextEdit
13:40:06 window-closed TextEdit "Untitled 2"
13:40:06 app-quit TextEdit
```

Events: `app-launched` `app-quit` `app-focused` · `window-opened` `window-closed` `window-focused` `window-minimized` ·
`sheet-opened` `sheet-closed` · `title-changed` (`"old" → "new"`) · `announced` (VoiceOver announcements — some apps report results only this way, e.g. Calculator: `announced Calculator "Result, 46"`) · with
`--values`, `value-changed` for static text, progress (as %), level and busy indicators — throttled to ≤1/s per
element, always ending on the final value. Dialogs, sheets, banners and untitled windows carry what they say and
their `[buttons]`. Default scope: every regular app plus the system agents that raise dialogs (notifications,
permission prompts, Gatekeeper); `--app NAME|BUNDLE_ID|PID` (repeatable, names match as a prefix) narrows it.

- Streaming: run it under Claude Code's Monitor tool and every line arrives as a notification.
- One "tell me when": `--until TEXT` (repeatable, case-insensitive substring of a line) prints the first match and
  exits 0 — and a window that already matches when it starts counts (`already window …`), so there's no race
  between "check" and "wait". `--seconds N` caps it (exit 124 if nothing matched). Good as a background shell job:
  `the-eye watch --app Xcode --values --until "Build Succeeded" --seconds 600`.
- `--json` for one JSON object per line. `EYE_WATCH_RAW=1` echoes every raw AX notification to stderr.

The MCP instructions tell agents to use it, with the absolute command for this checkout. Test:
`test/watch-events.mjs` (a self-changing fixture app, then TextEdit driven in a watch session that holds the lock).

## Websites

`eye_drive {url:"localhost:3000", …}` runs the same session on a web page. The page opens in the eye's own
Chromium-family browser: Chrome for Testing, Chromium, Google Chrome, Brave or Edge, whichever is installed first, or
`THE_EYE_BROWSER` / `browser:"brave"`. That browser runs on its own profile (`~/Library/Caches/the-eye/browser/<name>`,
kept between sessions, never your everyday profile), with renderer accessibility forced on and no background
throttling. It shows one tab in one window, and it is reused by the next session. Because the window belongs to the
browser process, everything that works on an app works on the page unchanged: the window recording, what a viewer
noticed, the hand, wings that aim at things by their accessible name, and accessibility events.

On top of that, the session reaches into the page through the DevTools protocol:

- **Things found in the page.** `on:"…"` in steps and `el:"…"` in a wing take a CSS selector or what the thing is
  called (aria-label, label, text; exact before contains, interactive elements first). Before pressing, the hand waits
  (`timeout_ms`, default 5s) until the thing is visible, enabled, not covered by anything else at its centre, and still
  over two reads, scrolling it into view first if needed. A refusal says why: `button #off "Disabled one" is disabled`,
  `… is covered by #cover`, `nothing on the page matches "#nope"`.
- **Straight into the page:** steps `type {text, on?}` (key by key; `\n` = Enter), `key {key:"Shift+Tab" | "Meta+a" | …}`
  (Meta+a/c/x/v/z run the macOS editing commands), `goto {url}`, `reload`. Wing words: `type:"…"`, `key:"…"`,
  `goto:"…"`, `reload`.
- **The page's own state:** `wait_until` / `assert` take `js:"document.querySelector('#toast')?.textContent === 'Saved'"`,
  which is evaluated in the page and may await promises.
- **What the page said:** every reply lists the console errors and warnings, uncaught exceptions, failed loads (404s,
  CORS, network errors: `Log.entryAdded`), open dialogs, crashes, slow answers to input (Event Timing ≥40ms, one per
  interaction: waiting + handlers + until painted) and layout shifts that no input caused (with the elements that moved).
- **`look`** in a website session and `eye_inspect {page:true}` list what can be pressed or read in the window:
  `button #move "Move the box" [62,129 96×21] (disabled)`, with the selector, name, state, value and screen rect.

**The page probe** goes in by itself (`probe:false` skips it, `probe:{watch:["#box"]}` always shows those elements). It
is `src/eye-page.js`, the page-side twin of the app probe. On every animation frame it records the geometry of the
elements that are animating or were restyled, and it captures each CSS transition, CSS animation and Web Animation as
the page declared it. It also logs Long Animation Frames with the scripts that ran in them, slow input and layout
shifts. At the end it is written as a `probe.ndjson` in the app probe's format, on the capture's clock. That means:

- **"why:"** under a freeze names the script function and its place:
  `blockMainThread 127.0.0.1:5173:25 ran 200ms · event-listener BUTTON#block.onclick`. Forced style/layout, sync XHR or
  alert pauses, and time spent outside any script are called out too.
- **FROM INSIDE THE PAGE** shows each moving element's `declared:` animation, the fit on its exact per-frame values, and
  the verdict on the two:
  `CSS transition on transform none → translateX(200px): 0.3s ease-out = cubic-bezier(0, 0, 0.58, 1) · on the compositor` →
  `moved by: a TIMING CURVE over 300ms: easeOut …` → `✓ it ran as declared`.
  Under it, **THE PAGE ITSELF** gives the page's log, the slowest answers to input, and layout shifts with their CLS.

Limits: only Chromium-family browsers can be driven (Safari and Firefox have no DevTools protocol the eye can use).
Lookup does not reach into iframes or shadow DOM. Screen rects assume 100% page zoom. They are exact once the pointer
has moved over the page (a real pointer event calibrates the viewport's screen origin) and estimated before that.
A `file://` page's scripts are not attributed in long frames, so serve it over http. The dev server must be running:
`did not load: net::ERR_CONNECTION_REFUSED (is the dev server running?)`. `eye_drive {url, quit:true}` quits the
eye's browser.

## Input lock and drivers

Every lock (a session with a hand, `eye_drive {hands:"mine"}` or one with a `command`, `eye_snapshot {app}`, a question) taps every event type and drops
all physical input whose source process ID is 0: pointer, scroll, trackpad gestures, force touch, keys, modifiers and
media keys. It also seizes every pointing device at the HID level (`IOHIDDeviceOpen` with `kIOHIDOptionsTypeSeizeDevice`, including mice connected mid-lock), so the trackpad never reaches the window server and the cursor doesn't move at all, while posted moves still drive it. The kernel drops the seize if the process dies. The report has `pointer_devices_seized`, and `max_cursor_drift_pt` says how far the cursor ever got from where it should be (should be 0). One physical trackpad shows up as several HID handles that refuse each other's exclusive open, so
handles are grouped by physical device and a device counts as held when any of its handles is seized.

**Preflight first.** Everything that could make a lock fail — no event tap (Accessibility), another `eye-capture lock`
running, a pointing device some other process holds exclusively — is checked (with a seize-and-release test) before
anything appears on screen, and refuses with `preflight: …` at once.

**Two styles.** `full` shows a 3·2·1 countdown in the middle of every screen (0.5s per number, 1.5s total) while input
is still free (the tap is not armed until it ends; `test/lock.mjs` checks this), then the orange overlay on every
screen; the tools wait for it. `quick` ("Just a sec…") has no countdown: a small pill springs down under the menu bar
and the lock engages in ~0.1–0.2s. `eye_snapshot {app}` uses it, and so does a session that opens and ends in one call whose steps and wing take under
4 seconds (`wingMs` in `src/wing.ts` adds up the wing; `fingers play` and the like never count as short). Anything
longer gets `full`, also when `lock_style:"quick"` was asked; `lock_style:"full"` is always honoured.

**Who drives decides the lock; there is no switch.** The-eye's hand (the default) and the caller's own driver
(`hands:"mine"`, or a `command`) always hold the user's input. Only `hands:false`, where the user is the one acting,
leaves it free.

**The lock does not fail.** A lock that is refused in preflight, or whose helper dies, is taken again (`holdLock` in
`src/index.ts`, 0.3s apart growing to 2s) until one engages; nothing is driven meanwhile and nothing shows on screen
for a refusal. The reply says when it took more than one try and what the first refusal was. Only a run that is told
to stop gives up waiting. When the host app lacks Accessibility or Input Monitoring, the-eye asks for it: `eye-capture perms --ask` raises the
macOS prompt and opens the pane in System Settings, again on every failed try while something is missing, and the waiting
call goes on as soon as it is granted. `eye-capture perms` alone prints what is granted. The overlay
or pill is shown exactly while a lock is held, so orange on screen means no physical input gets through.

**Hands on the trackpad.** If the user is mid-drag, mid-scroll, mid-fling or mid-pinch when a lock is due, it waits up to
`--settle-ms` (1200) for them to finish (a quick pill greys out and says `let go… (reason)`), then engages anyway and
ends each interrupted action with tagged events (button up, scroll end, momentum end) so no app is left stuck in a
drag loop. The report has `settle_ms` and `interrupted_at_engage`.

**One lock across calls.** The helper reads `extend <seconds>` and `release` on stdin; a session keeps one lock for all
its calls and extends it instead of starting a new one (and a new countdown).

**Question mode.** A third style, `question`, puts a yes/no to the person at the machine. In order, with no countdown
and no settle wait: the lock engages and the orange overlay shows; return / enter, Esc and the left / right arrows are
ignored for the first 175ms (a key already on its way down cannot answer); a card fills the middle of every screen
with the question in big type and three big buttons side by side:

| button | means |
|---|---|
| **Nope** (left) | no. The user is taken to be using the machine: the-eye refuses every request to quit an app for the next 30s |
| **Yep** (centre, highlighted) | yes, this once |
| **Mi casa su casa** (right) | yes, and yes to this same question for the rest of the session (it is not shown again) |

← → move the highlight, return / enter takes it, Esc is Nope. A line along the card's bottom edge runs out in 6s, and
then the highlighted button is taken. After a question that ran out unanswered, the next one opens with Mi casa su
casa highlighted (nobody is there), until a question is answered by hand again. The lock is gone with the answer.
An agent asks with `eye_drive {ask}` (at most 140 characters) and is held until the answer. The server asks by
itself before it quits something that may be the user's: an app launched by Xcode's Run (`Kill <name>'s Xcode run
session?`) or a copy outside build folders (`Quit <name>?`), from `duplicates: "quit_others" | "relaunch"` and
`eye_drive {quit:true}`. A copy this server started itself is quit unasked. A stale older launch of a rebuilt build is still quit unasked, unless it is an Xcode run
session; the background launch watcher never asks and leaves such a copy running. Over a lock that is already held
the question is put on that lock (`ask <preselect> <seconds> <text>` on the helper's stdin) and the lock stays. A
question that cannot be shown (no permission for the lock) is not a no. `THE_EYE_ASK=yep|nope|casa` answers without
showing anything (tests). The rules live in `src/ask.ts`; `test/question.mjs` checks them, the keys and the timeout.

**Covered windows.** A press on a window hidden behind another app's window is refused. So a session with a hand raises
the app's window when it opens (`front:false` leaves it), and `eye_snapshot {app}` raises first. Afterwards the exact z-order,
focus, frame and minimized state are restored (`raise`/`restore` ops of `eye-capture input`, ~50–140ms each).

The user's emergency release is Esc six times in a row, each within 1s of the
previous (those presses are swallowed too; dots on the overlay pill fill up and a hint shows how many are left). Its result includes `pointer_events_by_source_pid` and `blocked_by_event_type`, so you can
check what it saw. Keystrokes typed while macOS Secure Input is on (a focused password field) bypass every event
tap, this one included. Events posted by any process pass through,
including Peekaboo, `cliclick` and your own CGEvent drivers. With `allow: "tagged"`, only events carrying
`eventSourceUserData == 0x45594521` ("EYE!") pass.

### Driving live: `eye_drive`

A list of points with a stop after each is not how a hand moves, and an agent should not have to move like that
either. `eye_drive` flies a **wing**: one line of words, one motion, nothing decided between its points. Exact
`steps` stay beside it for what has to repeat to the millisecond (measuring, A/B); both run in the same session.

```
eye_drive {app:"Calculator", wing:'"Clear" tap "7" tap "Add" tap "3" tap "Equals" tap settle', end:true}   the whole loop in one call
eye_drive {app:"Calculator", wing:'"Volume" down E 80 rest 200 W 30 up'}    opens a session; a drag, steered
eye_drive {wing:'slow E'}                                    keep going east…
eye_drive {wing:'S'}                                         …now bend south, from the speed it has
eye_drive {steps:[{op:"scroll", dy:-200, momentum:true}, {op:"wait_until", expr:"!moving"}]}
eye_drive {end:true}                                         let go, free the input, verdict for the whole session
eye_drive {rect:{x:356,y:0,w:800,h:300}, command:"./drive full"}                your own driver, watched
```

| word | what the hand does |
|---|---|
| `"Name"` · `Button:"Name"` · `#identifier` | fly to that thing, found in the app's accessibility tree as it is right now; exact name beats prefix beats substring, things that can be pressed win ties |
| `x,y` | fly to a point (global points) |
| `N NE E SE S SW W NW` or `↑↗→↘↓↙←↖` | with a distance: that far that way. Without: keep flying that way until the next wing, the window's edge, or `coast_ms` |
| `tap` `tap2` `tap3` `rtap` `down` `up` | press what is under the finger |
| `scroll up\|down\|left\|right <px>` · `fling …` | a phased two-finger scroll at the pointer, named by where the page goes (`scroll down` = further down the page, whatever the Natural scrolling setting), exactly that many pixels, landing and lifting by itself · the same with momentum after the fingers lift |
| `fingers …` · `… flick` · `lift` | two fingers on the trackpad, in two dimensions, named by where the FINGERS go (points, y down). What is under them follows as it does under a real hand: the scroll events are the ones this machine's trackpad would send under its Natural scrolling setting, direction flag included. Four strokes: `fingers up\|down\|left\|right\|<compass> <pt>` is a line; `fingers <dx>,<dy> <dx>,<dy> …` is ONE curved stroke through those offsets (a spline, it never stops at a point, so corners are turns); `fingers orbit <r> [turns]` draws a circle back to where it began (negative turns = the other way round); `fingers wander <r> [ms]` roams within `r` of where it is on two unrelated slow waves per axis with random phase, differently every time, and comes back (default 1500ms). They land with the first stroke and STAY DOWN: every further stroke is the same touch (began once, ended once) and exact to the pixel. Strokes written one after another are flown as ONE movement with no stop between them; the fingers slow into bends and run on the straights (speed follows the radius of the bend to the power ⅓, as a hand's does), a long stroke is faster than a short one, and each takes a slightly different time (±13%) around the wing's pace. `rest`, `settle`, `until:` and `check:` between strokes keep the fingers where they are; any other move lifts them first. `flick` after a stroke makes it leave at speed along its last direction, lift, and coast with momentum events. Fingers still down when the wing ends stay down while you read the reply, for `hold_ms` (default 20s), then lift by themselves; the reply says so either way. `fingers like:"last" [n]` plays back a touch the USER made, on its own clock: every recording also listens to the trackpad (`fingers.jsonl` in the run folder: one line per scroll event the user's fingers caused, never the-eye's own), a session that ends lists those touches under YOUR FINGERS (when, how long, where, travel, mean speed, how often it turned back, whether it left with a flick), and `like:` takes `last` or a run folder, with `n` choosing the touch (default the longest). A touch that left at speed (over 200 px/s in its last 40ms) is thrown again: the fingers lift at its end and momentum follows at that speed; one that came to a stop leaves the fingers down. This is how to play with something that follows the fingers and answers back (a notch that wobbles, a sheet that rubber-bands, a scrubber): stir it, read the reply, stir again or let go. Or let the hand do it: `fingers play [gentle\|lively\|wild] [size] [up\|down\|left\|right]` makes them play by themselves until told otherwise, also between calls (`hold_ms`). The hand reads the recording's 50ms motion bins twenty times a second and plays in phrases that run into each other: a pull and further while the thing grows, a wave that swells and goes on while the screen gives more, a shake, a slow slide, further than it has been, held stretched then let go, a flick let go at its fastest; it lifts to watch the thing settle and lands again; where the screen jumped without the fingers doing anything new (a POP) it goes slowly back over that place. Each stroke is a minimum-jerk submovement begun before the last has ended, and its turn, time and size lean on the previous one's. The reply lists what they did and where the screen gave most. A stroke written meanwhile redirects them, `fingers calm` stops the play with the fingers down, `lift` ends it. Also kept up until the next word: `fingers wave <±pt> [hz] [way]`, `fingers stir <r> [hz]`, `fingers roam <r>`, `fingers go <way>`, each optionally `along <dx>,<dy> [ms]` |
| `pinch <scale> [ms]` · `rotate <degrees> [ms]` · `zoom` · `swipe left\|right\|up\|down` | trackpad gestures where the hand is (`zoom` = smart zoom) |
| `press [ms]` · `force [ms]` | Force Touch: stage 1 · a force click |
| `rest <ms>` · `settle` · `halt` | let time pass (a heading keeps flying) · wait until the screen is still · brake |
| `until:"expr" [ms]` · `check:"expr"` | wait until the expression holds (default 2000ms) · stop the wing unless it holds |
| `layer:"label"` | fly to that probe layer, where it is right now |
| `slow` `walk` `brisk` `fast` `<n>/s` | pace from here on (220 / 450 / 700 / 1200 pt/s) |

How it moves (`Hand` in `swift/EyeCapture.swift`): a thread integrates position and velocity 120 times a second, and
velocity eases toward what was asked with a 40ms time constant: the hand has mass. A target followed by another target
is passed through, not stopped at, so a change of direction is an arc. A target followed by a press is landed on:
closing speed proportional to the distance left, which with that mass is a spring of damping ratio ≈ 0.67. A named
thing is looked at again every 30ms while the hand flies, and the aim moves with it.

What it will not do, by construction rather than by a check bolted on: reach for a thing that is not in sight. A name
that matches nothing ends the wing with the list of what *is* there; a thing with something else over it is not flown
to ("Button "7" is there but not in sight: Finder's sidebar is over it"); a `tap` after a named thing presses only if
that thing is what is under the finger at that moment. The hand reads the recording's live file itself and brakes
where it is when the capture stream drops. Presses and gestures from `steps` are held to the same app (the owner of
the element under the point is checked right before posting), and scrolls to where the app owns the window or the element under the pointer (a notch pill owns its window over the
menu bar while accessibility answers with the menu bar, so either counts), to the measured open area, or to
`scroll_zones`, which stay for the session once given. A refused scroll says who owns the place.

What comes back from every call: every element the pointer passed over, in order, with the stretch it covered and for
how long (a second thread hit-tests accessibility about every 2pt travelled); each press where it happened and on
what; after each step the pointer, the element under it and the visible state; where the hand is now; if it is still
flying, what lies ahead on its line and in how many milliseconds; the screen, what a viewer noticed during this call,
what the app told accessibility, and the frame it settled on. The element tree is shown when a session with a hand
opens (`look:true` shows it again).

The end, in this order: the hand lets go, the screen is given time to settle and its frame is taken, the capture
stops, the window goes back where it was, the lock is released, and then the report is written (the probe's account,
the analysis, the frame at each ✗). `quit:true` quits the app after that.

The session ends with `end:true`, or by itself after `idle_s` (30) without a call: a held button is released and the
user's input is never kept while nobody is steering. A watch session (`hands:false`) has no idle end; it stops after
`max_seconds`. The feeling costs the app the same as any accessibility client (see
[AX context](#accessibility-ax-context)); for final frame-rate numbers use `steps` with `ax:false` and `probe:false`.

### Two-finger gestures

`pinch`, `rotate`, `smart_zoom` and `swipe` are `NSEventTypeGesture` CGEvents carrying undocumented CGS fields:
110 is the IOHID type (8 zoom, 5 rotation, 22 zoom toggle, 16 navigation swipe), 113 and 114 are the magnification
and rotation deltas, 115 is the swipe direction and 132 is the phase. The field map comes from Calf Trail's
TouchSynthesis by way of Mac Mouse Fix. They must be posted at the session tap: AppKit never sees them from the HID tap.
They therefore bypass the input lock's tap, which is fine because they are ours. AppKit turns them into real `magnify`,
`rotate`, `smartMagnify` and `swipe` events with began/changed/ended phases. A pinch's per-event deltas multiply to
exactly `scale`, and rotation deltas sum to `degrees` (with clockwise positive; AppKit's sign is the opposite).
`scroll {momentum:true}` adds the coasting tail after the fingers lift (momentum began/changed/ended). Check with
`swiftc test/gesture-target.swift -o /tmp/gt`: a window that logs every gesture event it receives as JSON.

### Force Touch

`press {force:[0, 0.4, 0.8, 0], ms}` is a mouse down, a pressure curve, then a mouse up. `force` is a single axis of
keyframes, spread over `ms` and eased between them. 0…1 is stage 1 (a normal click's `NSEvent.pressure`), crossing 1 is
the force click (stage 2) and 1…2 is pressure inside stage 2. `force_click` is a ready-made curve,
`[0, 0.9, 1.5, 1.5, 0.9, 0]` over 700ms. A pressure event is a gesture CGEvent with IOHID type 32 (kIOHIDEventTypeForce).
Its field layout was read off a real trackpad with a listen-only tap: 132 phase, 143 stage, 144 pressure behavior
(5 = deep click), pressure in 119/139/148 plus float32 bits in 123/165, and stageTransition in 113/114/116/118/147
plus 115/117/164. It also follows the real order: the pressure gesture begins just before mouse down and ends just
before mouse up. Apps receive a real `pressureChange(with:)` sequence with `stage`, `pressure`, `stageTransition` and
`pressureBehavior`. They do **not** receive `quickLook(with:)` (Look up): a real trackpad's comes from lower in the
system, not from the pressure stream. `test/gestures.mjs` checks every gesture and press against a real window under
the input lock.

Press safety checks the pid of the AX element under the point first. CG's topmost window is often click-through: the
Dock keeps a full-screen window at layer 20 over every normal app.

### Hang protection

ScreenCaptureKit sometimes never calls back. This is common for `SCStream.stopCapture()` right after
another SCK screenshot, and occasional for `SCScreenshotManager`. Every helper call therefore has a deadline:
- capture stop: frames are already on disk, so the meta is written after 2s anyway (`stop_timed_out: true` in the meta)
- capture start: 8s; snapshot: 4s, then the server falls back to `/usr/sbin/screencapture`; displays: 5s
- one ScreenCaptureKit client at a time: while a recording runs, a second process that asks ScreenCaptureKit
  anything (a snapshot, even the list of displays) interrupts the recording's stream for tens of milliseconds
  (macOS 27.2: "Failed during stream due to application connection being interrupted"). So stills taken during a
  recording go through `/usr/sbin/screencapture`, `displays` reads CoreGraphics, and a session stops its capture
  before it puts the window back
- the server never uses `spawnSync` for helpers. Stopping escalates SIGTERM → SIGKILL, and a wedged input actor is killed and respawned.

Regression test: `node test/stop-hang.mjs [rounds]`.

Recordings started back to back sometimes get a spurious TCC refusal ("The user declined TCCs…") that sticks to the
helper process, so retrying inside it doesn't help. `eye_drive` starts a fresh helper (up to 3 tries, 0.7s/1.4s
apart) and says so in its result ("capture retried 1×…"); only the third refusal is reported as a failure.

## Install

Requires macOS 14+, Node ≥ 23.6 (it runs the TypeScript directly) and Xcode command-line tools (`swiftc`).
The native helper builds automatically on first start, or manually with `npm run build:native`.

```sh
cd the-eye && npm install
```

OpenCode (`opencode.jsonc`):

```jsonc
"mcp": { "servers": {
  "the-eye": { "type": "local", "command": ["node", "/path/to/the-eye/src/index.ts"],
               "timeout": { "execution": 660000 } }
} }
```

Claude Code: `claude mcp add the-eye -- node /path/to/the-eye/src/index.ts`

Or as a plugin, which brings the server and the manual as a skill (`the-eye:the-eye`) together:

```
/plugin marketplace add Kinark/the-eye
/plugin install the-eye@the-eye
```

The plugin's copy runs `npm install` by itself on its first start. From a checkout: `claude --plugin-dir .`. Use one
or the other, not both: two servers would queue behind each other.

**Permissions:** the host app (terminal or agent) needs **Screen Recording** for capture and **Accessibility** for
the input lock.

## The show-off page

```
npm run show-off
```

Serves `show-off/` on http://localhost:4173 and opens it (`SHOW_OFF_OPEN=0` to not open, `PORT` to move it). The page
logs its own frames and reports on itself, fits a puck you fling with `src/physics.ts`, reads a corner you draw with
`src/still.ts`, and replays one real recording with the report it produced. No build step, no dependencies; design
notes are in `show-off/MASTER.md`.

## Example

```
eye_drive  { app: "NOOTCH!-Dev", wing: '"Timer" tap settle', end: true, label: "timer-on" }
eye_drive  { rect: {x:356,y:0,w:800,h:300}, command: "./drive full", label: "timer-on-script" }
eye_report { runs: [{csv: ".../frames.csv", label: "baseline"}, {csv: ".../frames.csv", label: "timer-on"}] }
```

Tests: `node test/smoke.mjs` (all non-interactive tools), `node test/guide.mjs` (the manual: the size of what is sent on connect, every chapter, a wing that cannot be read), `node test/ax.mjs` (AX hover/tree path; never moves the pointer), `node test/notice.mjs` (what a viewer would notice, on synthetic recordings), `node test/why-e2e.mjs` (drive → see → why on a fixture app; takes the input lock).
