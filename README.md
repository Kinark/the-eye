# the-eye

An MCP server that lets an agent **measure what is visible on a macOS screen over time**, as numbers instead of
screenshots. It captures a screen region at the display's full refresh rate (ScreenCaptureKit) and logs one row per
display refresh. From that log it reports how smooth an animation *actually looked*: real on-screen fps, stalled
refreshes, hitches, frame-gap distribution, and the size/position curve of whatever moved.

Built to answer "did this change make the animation smoother?" objectively, and to A/B app builds and settings.
It's meant to be an agent's default way to test a macOS app's UI (SwiftUI or AppKit) on its own: find the element
(accessibility tree), drive it (`eye_act`), and measure the result, without asking the user to try it.

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

Numbers are for comparing; a person watching just *sees* that something stuck. So every report — `eye_act`,
`eye_record`, `eye_stop`, `eye_peek`, `eye_report` — opens with a verdict and the things a viewer would have noticed,
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
| **LAGGED / slow** | first visible change more than 300ms / 150ms after a press, scroll or gesture `eye_act` sent |
| facts | each motion's time span, travel (`width 0pt→405pt`), overshoot-and-settle, fps; instant **pops** (a change that took one or two frames, no transition); how fast the screen answered each step; a motion cut off by the end of the recording |

**Why.** With `eye_probe` loaded in the app, each freeze carries `why:` lines from the probe's main-thread watchdog
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

A window that is not moving still has things to measure, and a look at one (`eye_glance`, live `eye_snapshot`) comes
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

Twelve tools. The server's MCP `instructions` carry the full "what / when / how" guide agents see on connect.

| tool | what |
|---|---|
| `eye_status` | displays (id, points, scale, refresh rate), active recordings / probe runs / locks, runs dir |
| `eye_inspect` | **accessibility view, no recording**: everything the element under a point exposes (default: the pointer), or the element **tree** of an app (`process`) or of the windows visible in a rect, one line per element with its bounds |
| `eye_snapshot` | one PNG of a region (`rect`), or a recording's keyframes near a time (`csv`, `t_s`) |
| `eye_glance` | **a quick look at a window that may be covered**: "Just a sec…" lock → raise the window → `look` (`image`, `tree`, `element` at x/y) and optional short `steps` → put the window back exactly → release. Reports how long the user was held and where the time went (typically 0.3–0.4s) |
| `eye_record` | record a region (`rect`), or an app's window wherever it is (`process`, optional `window` title; no rect needed). No command/seconds → background, returns an id at once (with the AX tree). `seconds` → blocking. `command` → runs your input driver while recording, optional `lock_input`, returns output + report. `background:true` for long runs |
| `eye_peek` | live state of a running recording or probe: moving, extent, recent fps/hitches, **element under the pointer** (`hover:"full"` for every attribute), command output, probe layers, optional fresh AX `tree` |
| `eye_act` | **interactive driving**: `move`, `click`, `down`/`up`, `scroll` (two-finger, optional `momentum` fling), two-finger gestures `pinch {scale}`, `rotate {degrees}`, `smart_zoom`, `swipe {direction}`, Force Touch `press {force:[…]}` / `force_click`, `wait`, `wait_until`, `assert`. After **every** step: pointer, element under it, visible state. **With no recording running it records the target's window for those steps itself** (`see`, default on: ~0.3s before the first step, up to 1.5s after the last while motion settles, all inside the lock) and ends with what it looked like. Expressions get `h` (the element). Presses and gestures only on `target_process` (the owner of the element under the point is checked right before posting); a press aimed at a probe layer (`on`) must still be inside it; scrolls only inside the open area or `scroll_zones` |
| `eye_stop` | end a recording and/or probe run (all if no id), kill a running command, return the report(s); the probe report is aligned to the capture |
| `eye_report` | re-analyze (default: the most recent run; a run folder works as `csv`): `summary`, `timeline`, `explain` (worst gaps × cursor × element × eye_act step × main thread), `hover` (element-under-pointer changes), `compare` (runs), `probe` (probe.ndjson / one layer) |
| `eye_app` | list / quit / launch / relaunch the app under test, counting every copy and build of it |
| `eye_lock` | block all physical input, trackpad and keyboard (`seconds`, `style: full\|quick`), or `release:true` |
| `eye_probe` | load the probe into an app if needed and start recording layer geometry **and main-thread stalls with stack samples** — the cause behind every freeze in later reports (see below) |

Old → new: `eye_displays`→`eye_status` · `eye_start`/`eye_record_while`→`eye_record` · `eye_abort`→`eye_stop` ·
`eye_analyze`/`eye_timeline`/`eye_compare`/`eye_explain`/`eye_probe_report`→`eye_report` · `eye_frames`→`eye_snapshot` ·
`eye_lock_input`/`eye_unlock`→`eye_lock` · `eye_probe_attach`/`eye_probe_start`→`eye_probe` · `eye_probe_peek`→`eye_peek` ·
`eye_probe_stop`→`eye_stop`.

## Accessibility (AX) context

So an agent knows **what** it is looking at and **where** things are:

- **Hover**: while recording with `ax` (default on, off with `profile`), the capture hit-tests the element under the
  pointer up to `ax_hz` (10) times a second. When the element changes, its full description (every attribute,
  actions, parameterized attributes, ancestors, app, window, readable path) goes to the live JSON (`hover`) and to
  `hover.jsonl`; while it stays the same, its frame/state is refreshed every 0.5s. Reports end with a timeline of
  what the pointer was over; `cursor.csv` keeps role/label columns for `eye_report view:"explain"`.
- **Tree**: `eye_record` snapshots the element tree of the observed windows at start (`tree: basic|full|none`,
  saved as `ax_tree_start.txt/.json`); `eye_inspect`, `eye_peek {tree}` and `eye_act {tree}` dump it on demand.
  The observed windows are found by AX hit-testing a grid of points in the rect, so only what is actually on top
  counts (occluded windows and transparent full-screen windows are ignored); `process` picks an app explicitly.
  `basic` folds unlabeled layout groups; `full` lists every node and its actions.
- AX frames are **global** points (same space as the pointer and `eye_act` x/y; equal to display-local on the main display).
- **Cost:** any AX client makes SwiftUI apps maintain their accessibility graph (measured ~18% more main-thread time,
  −25% fps on NOOTCH!). Use `ax:false` for final fps numbers and A/B runs; reports say when AX was on.

## Layer probe (geometry from inside the app, no pixels)

`swift/EyeProbe.swift` is a small library loaded **into** the target app through a debugger. On every display refresh
(a `CADisplayLink` on the target screen) it walks the layer tree of every visible window and logs each layer's
**presentation** geometry, meaning the live animated values: frame, opacity, and the bounds of its shape path or
`CAShapeLayer` mask. Everything is in display-local points, top-left origin (the same space as the capture), and
timestamped on the same mach clock as `frames.csv`. A rect, `match` and `watch` narrow what is logged and shown.

- **Attach:** `eye_probe {process}` builds the library and signs a copy with the **target's own certificate**
  (needed for library validation; the key must be in your keychain). It stages the copy where the app can read it (its
  container when sandboxed) and loads it with `lldb -p`. If Xcode already debugs the app, it returns the commands
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
- **Recorded alone.** `eye_act`'s own recording and `eye_record {process}` capture only the target app's windows,
  over mid grey (`--only-pid` in the helper): what shows through a see-through overlay window, or sits over the app,
  is not measured as its motion. `isolate:false` on `eye_record` records the screen as it is.
  Test against the real thing: `node test/nootch-see.mjs` (hover, open, at rest, close on NOOTCH!-Dev, probe loaded).
- **Main-thread watchdog (the "why").** While a probe recording runs, a run-loop observer on the app's main thread
  marks the start and end of every turn, and a watcher thread polls that mark every 3ms. A turn longer than 1.25
  display frames is a *stall*: while it lasts the watcher samples the main thread's stack (suspend → walk frame
  pointers inside the stack bounds → resume, a few microseconds, nothing allocated or locked meanwhile), densely for
  the first ~100ms and sparsely after, so a multi-second hang stays cheap. Each stall is one `H` line (start on the
  mach clock, duration, samples) with its frames in `F` lines (Swift and C++ names demangled in-process, image, and
  whether the image is the app's own); a hang still in progress is rewritten once a second. A healthy app pays two
  observer callbacks per run-loop turn. `eye_stop`, the capture reports and `eye_report view:"explain"` join stalls to
  on-screen gaps through `stalls.json` in the run folder. Stack sampling is arm64-only; on Intel stalls are timed but
  not sampled.
- **Control** is file based (`control.json` / `status.json` in that directory), so it works inside the sandbox.
- **Live:** `<recording>.live.json` is rewritten every 0.25s with the last 0.5s: ticks/s, walk cost, the layers that
  moved (updates, coverage = frames changed / frames in its motion, max gap, current rect/shape) and the `watch` layers.
  `eye_peek` and `eye_act` show it. `eye_act` expressions get `pr` (the JSON) and `L('label')`.
- **Cost:** about 0.2ms per frame on the app's main thread for a small tree. It's reported in every peek and report.
- **Limit:** it sees what the app hands to the system. Effects the window server renders itself (system glass,
  backdrops) can still lag on screen. Record an `eye_record` capture of the same moment; `eye_stop` aligns the probe report to it.
  Probe rows that update every frame alongside a capture that doesn't change point at the window server.

Test: `node test/probe-e2e.mjs '<process>' [seconds] '<start args json>'`.

Coordinates are **display-local points, top-left origin**. Runs are stored in `~/Library/Caches/the-eye/runs/<time>_<label>/`
(`frames.csv`, `frames.csv.meta.json`, `cursor.csv`, `hover.jsonl`, `ax_tree_start.*`, `actions.jsonl`, `stalls.json` when a probe ran, `keyframes/`). Override the location with `THE_EYE_DIR`.

### Live state

While recording, `frames.csv.live.json` is rewritten 10 times a second with what is visible right now:
- `moving`
- `last_1s`: new frames, idle refreshes, worst gap, hitches
- `anchored_screen`: the top-anchored extent. Its width is measured along a row inside the menu bar, starting from the
  display center; its height is how far the change hangs down. This is the open notch or panel, unaffected by changes elsewhere.
- `changed_extent_screen`: the bounding box of every change since the first frame

Commands started by `eye_record` get `THE_EYE_LIVE` (that file's path), `THE_EYE_RECT` and `THE_EYE_RUN_DIR`, so a
driver script can check state before every action. In `eye_act` expressions, `a` is `anchored_screen`, `e` is the
changed extent, `p` is the pointer and `h` the element under it.

Interactive loop: `eye_inspect` (find targets) → `eye_record` → repeat `eye_act` (act → read numbers + element → decide) → `eye_stop`.

### One at a time

- **One driving session at a time, queued.** Every MCP client starts its own the-eye server, but there is one screen
  and one pointer. Driving tools (`eye_act`, `eye_glance`, `eye_lock`, `eye_record`, `eye_probe`, `eye_app`
  launch/quit) take turns through a lease in `~/Library/Caches/the-eye/driver.json`. A call that finds another server
  mid-turn joins a FIFO queue (`queue/<pid>.json`) and waits inside the server, with MCP progress notifications, then
  runs and returns its real result — the agent never has to poll or retry. A holder that is idle between its agent's
  calls hands over at once to whoever waits (with nobody waiting it keeps the turn 60s, so one agent's calls stay
  together); a call in flight, a lock, a recording or a probe finishes first, and the holder's replies say who is
  queued. A wait is capped at 45s (`EYE_QUEUE_WAIT_MS`), below the usual 60s client timeout: the call then answers
  `QUEUED, not run`, and calling again within 20s keeps its place. Servers from older versions (no busy flag) are
  waited out until their lease expires. Read-only tools (`eye_inspect`, `eye_snapshot`, `eye_status`, `eye_report`,
  `eye_peek`, `eye_stop`) never queue. `test/queue.mjs` covers it with a private lease dir (`THE_EYE_LEASE_DIR`).
- **One copy of the app under test, checked by the server.** A family is every copy and every build of an app: same
  executable name, or the same stem once build-variant words are dropped (`NOOTCH!-Dev`, `NOOTCH!`; also the bundle-id
  stem). Before `eye_act` (its `target_process`, or the probe's target), `eye_probe` and `eye_record {process}` the
  server checks the family; if more than one runs it stops with the list and the choices: `duplicates: "quit_others"`
  (keep the pid you named, else the newest launch), `"relaunch"` (quit all, start the target's `.app` fresh, or
  `app_path`), `"allow"`, or stop and ask the user. Recordings without `process` flag duplicated apps found in their
  rect. Every app it has seen is watched (every 2s): a copy launched later shows up as a ⚠ line in the next tool result
  and in `eye_status`. `eye_app` lists, quits, launches (never a second copy) and relaunches. Test: `test/single.mjs`.

### Waiting on the screen: `the-eye watch`

An MCP server can only answer, never wake the agent up later — so waiting for "the dialog", "the build", "the
window" used to mean polling `eye_glance`. `the-eye watch` is a CLI instead: one line per UI event, as it happens,
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
`test/watch-events.mjs` (a self-changing fixture app, then TextEdit driven under `eye_lock`).

## Input lock and drivers

Every lock (`eye_act`'s automatic one, `eye_record lock_input`, `eye_lock`, `eye_glance`) taps every event type and drops
all physical input whose source process ID is 0: pointer, scroll, trackpad gestures, force touch, keys, modifiers and
media keys. It also seizes every pointing device at the HID level (`IOHIDDeviceOpen` with `kIOHIDOptionsTypeSeizeDevice`, including mice connected mid-lock), so the trackpad never reaches the window server and the cursor doesn't move at all, while posted moves still drive it. The kernel drops the seize if the process dies. The report has `pointer_devices_seized`, and `max_cursor_drift_pt` says how far the cursor ever got from where it should be (should be 0). One physical trackpad shows up as several HID handles that refuse each other's exclusive open, so
handles are grouped by physical device and a device counts as held when any of its handles is seized.

**Preflight first.** Everything that could make a lock fail — no event tap (Accessibility), another `eye-capture lock`
running, a pointing device some other process holds exclusively — is checked (with a seize-and-release test) before
anything appears on screen, and refuses with `preflight: …` at once.

**Two styles.** `full` shows a 3·2·1 countdown in the middle of every screen (0.5s per number, 1.5s total) while input
is still free (the tap is not armed until it ends; `test/lock.mjs` checks this), then the orange overlay on every
screen; the tools wait for it. `quick` ("Just a sec…") has no countdown: a small pill springs down under the menu bar
and the lock engages in ~0.1–0.2s. `eye_glance` and `eye_act {front}` (when its steps fit in 5s) use it. The overlay
or pill is shown exactly while a lock is held, so orange on screen means no physical input gets through.

**Hands on the trackpad.** If the user is mid-drag, mid-scroll, mid-fling or mid-pinch when a lock is due, it waits up to
`--settle-ms` (1200) for them to finish (a quick pill greys out and says `let go… (reason)`), then engages anyway and
ends each interrupted action with tagged events (button up, scroll end, momentum end) so no app is left stuck in a
drag loop. The report has `settle_ms` and `interrupted_at_engage`.

**One lock across calls.** The helper reads `extend <seconds>` and `release` on stdin; `eye_act` inside a held lock extends
it instead of starting a new one (and a new countdown).

**Covered windows.** A press on a window hidden behind another app's window is refused. `eye_act` (`front`, default
automatic) then raises the target's window and retries once; `eye_glance` raises first. Afterwards the exact z-order,
focus, frame and minimized state are restored (`raise`/`restore` ops of `eye-capture input`, ~50–140ms each).

The user's emergency release is Esc six times in a row, each within 1s of the
previous (those presses are swallowed too; dots on the overlay pill fill up and a hint shows how many are left). Its result includes `pointer_events_by_source_pid` and `blocked_by_event_type`, so you can
check what it saw. Keystrokes typed while macOS Secure Input is on (a focused password field) bypass every event
tap, this one included. Events posted by any process pass through,
including Peekaboo, `cliclick` and your own CGEvent drivers. With `allow: "tagged"`, only events carrying
`eventSourceUserData == 0x45594521` ("EYE!") pass.

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
- the server never uses `spawnSync` for helpers. Stopping escalates SIGTERM → SIGKILL, and a wedged input actor is killed and respawned.

Regression test: `node test/stop-hang.mjs [rounds]`.

Recordings started back to back sometimes get a spurious TCC refusal ("The user declined TCCs…") that sticks to the
helper process, so retrying inside it doesn't help. `eye_record` starts a fresh helper (up to 3 tries, 0.7s/1.4s
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
  "the-eye": { "type": "local", "command": ["node", "/Users/kinark/Desktop/AI_Playground/the-eye/src/index.ts"],
               "timeout": { "execution": 660000 } }
} }
```

Claude Code: `claude mcp add the-eye -- node /Users/kinark/Desktop/AI_Playground/the-eye/src/index.ts`

**Permissions:** the host app (terminal or agent) needs **Screen Recording** for capture and **Accessibility** for
the input lock.

## Example

```
eye_record { rect: {x:356,y:0,w:800,h:300}, command: "./drive full", lock_input: true, ax: false, label: "timer-on" }
eye_report { runs: [{csv: ".../frames.csv", label: "baseline"}, {csv: ".../frames.csv", label: "timer-on"}] }
```

Tests: `node test/smoke.mjs` (all non-interactive tools), `node test/ax.mjs` (AX hover/tree path; never moves the pointer), `node test/notice.mjs` (what a viewer would notice, on synthetic recordings), `node test/why-e2e.mjs` (act → see → why on a fixture app; takes the input lock).
