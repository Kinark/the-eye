# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`the-eye` is a macOS-only MCP server (stdio) that lets an agent measure what is on screen over time (real fps, stalls, hitches, motion extent per display refresh), read the accessibility tree, drive the pointer/trackpad, and lock physical input while it does. README.md is the behavioural spec and is kept in step with the code: update it when tool behaviour changes.

## Commands

```sh
npm install
npm start                      # = node src/index.ts — the MCP server on stdio
npm run build:native           # swiftc -O -swift-version 5 swift/EyeCapture.swift -o bin/eye-capture
node src/index.ts watch --help # the `the-eye watch` CLI (not the MCP server)
```

- Node ≥ 23.6 runs the `.ts` files directly by type stripping. There is no bundler and no linter; `npm run typecheck` (`tsc --noEmit`, strict, `erasableSyntaxOnly`) is the only static check and must stay clean. Only erasable TypeScript syntax works (no `enum`, no `namespace`, no parameter properties), and imports carry the `.ts` extension.
- `bin/` is gitignored build output. The server rebuilds `bin/eye-capture` itself whenever `swift/EyeCapture.swift` is newer than the binary (`ensureBinary` in `src/index.ts`), so after editing Swift you only need to start the server or run a test. A compile error surfaces as a server start failure.
- The probe library is built on demand by `eye_probe` as `bin/EyeProbe_<sha1 of source>.dylib` (old versions pile up in `bin/`; safe to delete).

### Tests

There is no test runner. Each `test/*.mjs` is a standalone script that starts the server over stdio with the MCP client SDK. Run one with `node test/<name>.mjs` and read its output: some assert and exit non-zero (`smoke`, `notice`, `why-e2e`, `queue`, `single`, `stale`, `lock`, `gestures`, `watch-events`), others only print what the tools returned.

| script | needs / does |
|---|---|
| `smoke.mjs` | all non-interactive tools; the default check |
| `notice.mjs` | the perception layer (`src/notice.ts`) on synthetic `frames.csv` files; no screen, no input, the fastest check after touching `analyze.ts`/`notice.ts` |
| `physics.mjs` | the motion fitter (`src/physics.ts`) against SwiftUI's own `Spring`/`UnitCurve` (builds `test/fixtures/truth.swift`); no screen, no input |
| `track.mjs` | the follower (`src/track.ts`) on synthetic change boxes: slide, grow, shrink, one moving edge, scattered noise; no screen, no input |
| `still.mjs` | the still-frame reader (`src/still.ts`) on drawn pixels and made-up frames: text size and contrast, corner shapes, near misses, gaps, overlap, cut-off; no screen, no input |
| `still-e2e.mjs` | builds `fixtures/still.swift` (known text sizes and colours, planted layout flaws, the four corner shapes), looks once with `eye_glance` and `eye_snapshot`, checks the unasked reading; holds input for a fraction of a second |
| `ax.mjs` | AX hover/tree path; never moves the pointer |
| `stale.mjs` | dummy `.app` bundles in a temp dir; touches no screen or input |
| `queue.mjs` | several servers on a private lease dir (`THE_EYE_LEASE_DIR`) |
| `single.mjs` | lease + duplicate-app rules; launches Calculator, no input lock |
| `stop-hang.mjs [rounds]` | ScreenCaptureKit hang regression |
| `watch-events.mjs` | the `watch` CLI: builds `test/fixtures/ticker.swift`, then drives TextEdit under `eye_lock` |
| `watch.mjs '<eye_record json>' [peek_ms]` | not the watch CLI: starts a background recording and prints `eye_peek` on an interval |
| `why-e2e.mjs [jank_ms]` | builds `test/fixtures/janky.swift` as a debuggable app, loads the probe, clicks it with `eye_act` and checks the reply names the freeze and the blocking function (`0` = the clean-run case). **Takes the real input lock** |
| `feel-e2e.mjs` | builds `test/fixtures/springy.swift` (known spring, critically damped spring, easeInOut, per-frame lerp, a sliding puck on a spring and on easeOut, a tile growing and shrinking in two dimensions, a ball dropped onto a floor (gravity 3125pt/s², restitution 0.6), the tile fading in place), clicks each with `eye_act` and checks the reply names the engine and its numbers. **Takes the real input lock** |
| `probe-feel-e2e.mjs` | the same `springy.swift` fixture signed debuggable, with the probe loaded: presses each button and checks the probe report quotes the declared `CAAnimation` (stiffness 157.91, damping 12.57, 0.35s easeInOut…), fits the layer's exact values (spring, curve, lerp, bounce, fade) and says it ran as declared. **Takes the real input lock** |
| `said-e2e.mjs` | accessibility events on the recording's clock: the `springy.swift` fixture changes a value in each button's action and announces 200ms later; asserts both are reported, timed and placed in the motion, `events:false`, and the explain view. **Takes the real input lock** |
| `nootch-see.mjs ['<process>']` | the whole reflex layer against NOOTCH!-Dev (must be running, debuggable): probe, hover, open, still frame, close; prints everything, asserts nothing. **Takes the real input lock** |
| `lock.mjs`, `gestures.mjs`, `act.mjs` | **take the real input lock** (countdown, orange overlay; Esc ×6 releases). The user loses trackpad and keyboard while they run, so say so before running them |
| `probe-e2e.mjs`, `probe-cost.mjs`, `probe-drive.mjs`, `glass-drag.mjs`, `timer-pill.mjs`, `explain-e2e.mjs`, `process-tree.mjs` | take a process name: a running, debuggable (`get-task-allow`) app, in practice NOOTCH! |

`node test/call.mjs <tool> '<json args>'` calls one tool on a fresh server and prints its text: the quickest way to try a change by hand.

The host process (terminal or agent) needs **Screen Recording** and **Accessibility** permission, or capture and input/lock tests fail.

## Architecture

Two halves: a TypeScript MCP server that orchestrates, and one Swift binary that touches the system. The server never links native code; it spawns `bin/eye-capture <subcommand>` and talks JSON over stdio or files.

### TypeScript (`src/`)

- `index.ts`: everything MCP. Tool registration, the `INSTRUCTIONS` string (the agent-facing guide sent on connect; tool changes must be reflected there as well as in README), child-process management for captures/locks/xctrace, the `Job` model (one per `eye_record`), `eye_act` step execution, window raise/restore for `eye_glance`. `node src/index.ts watch …` short-circuits at the top of the file and just execs the binary's `watch` subcommand.
- `single.ts`: the "one at a time" rules. A file lease (`~/Library/Caches/the-eye/driver.json` + `queue/<pid>.json`) serialises driving tools across every the-eye server on the machine, and app-family checks refuse to act when several copies/builds of the target app are running. Every driving tool handler is wrapped in `driving(name, fail, handler)`; read-only tools are not. `name` may be a function of the args that returns `null` for calls that don't drive (`eye_lock {release}`, `eye_app list`). A new tool that moves the pointer, locks, records or launches must be wrapped.
- `probe.ts`: the `eye_probe` tool and probe reports. Builds `swift/EyeProbe.swift` as a dylib, re-signs a copy with the target app's certificate, stages it where the (possibly sandboxed) target can read it, and loads it with `lldb -p`. Control and status are files in that directory. Reports also say what moved each layer: `segmentSeries` turns one stretch of a layer's changes into a per-tick series on the channel that travelled furthest, `fitMotion` (physics.ts) fits it, `describeDeclared` quotes the `A` lines (the `CAAnimation`s the probe found attached to a changing layer) and `declaredVerdict` compares the two.
- `analyze.ts`: `frames.csv` → animation segments and metrics (pure, no I/O beyond reading the run). A frame counts as moving when pixels step (`changed_frac`) or when the whole picture drifts (`diff` ≥ `drift_threshold`): the second is what makes a fade a motion.
- `notice.ts`: the same rows → what a viewer would have noticed, in words, worst first (verdict, freezes, judder, jumps, flashes, response times) with causes from `stalls.json`. Every report leads with it; a new kind of defect goes here, with a case in `test/notice.mjs`. README "What a viewer would have noticed" lists the rules.
- `physics.ts`: one motion's samples → the engine that reproduces them (spring, cubic-bezier timing curve, per-frame lerp, gravity bounce) and its parameters, by least squares over a few seeds; pure math, no I/O. `notice.ts` calls it for every motion and picks which pixel signal to feed it (anchored extent, mean brightness, bbox extent, cumulative change). A new engine goes here with ground truth in `test/fixtures/truth.swift`. README "What moved it". A bounce is only attempted when the frames show its signature (turns back off the target, never passes it), and every cost includes a stretch of rest after the last frame unless the run was cut, so no model may hide an overshoot beyond the data.
- `track.ts`: one motion's frames → the thing itself, followed through the per-frame box of what changed since the previous frame (`mv_*` columns): its position (a slide), its size (growth in two dimensions), where the motion really starts and whether what came before happened elsewhere. `analyze.ts` uses it to start a segment at the motion instead of at the press; `notice.ts` uses it to choose which reading `physics.ts` fits.
- `still.ts`: one frame (raw sRGB pixels from the helper + the accessibility tree JSON) → what a window that holds still says: text size and WCAG contrast read off the ink, corner shape by fitting a superellipse to the fill edge (exponent 2 = circular arc, well above = continuous), and from frames alone near-miss alignment, uneven gaps, corner overlaps, things cut by the window. Pure math, no I/O; `atRest()` in `index.ts` feeds it and appends the lines to `eye_glance` and live `eye_snapshot`. The rules are deliberately narrow (leading edges only, twins or one-off-a-line-of-three, nothing inside scroll areas): on a real app a loose rule drowns the reply. Loosen one only with a real app in front of you.
- `explain.ts`: joins the worst gaps with cursor, hovered element, `eye_act` step and main-thread samples (`scripts/xctrace_summary.py` turns an Instruments trace into the latter).

### Swift (`swift/`)

`EyeCapture.swift` is a single-file, top-level-code program (Swift 5 mode, no package). The header comment lists the subcommands; `switch sub` at the bottom dispatches them:

- `capture`: ScreenCaptureKit stream → one CSV row per refresh, plus `frames.csv.live.json` rewritten 10×/s and keyframes.
  - Each row carries two boxes: `bbox_*` (everything that differs from the FIRST frame) and `mv_*` (what changed since the PREVIOUS frame, with its centre of change). `track.ts` follows a moving thing through the second; rows of older runs lack it and read as 0. Columns are only ever appended, `loadRun` reads them by index.
  - `minimumFrameInterval` is two thirds of the asked frame period on purpose. Asked for exactly one frame per refresh, ScreenCaptureKit drops every frame that arrives a hair early and a smooth 120Hz animation records as ~97 fps with "late" frames (measured: 8 of 8 runs flagged uneven before, 0 of 24 after). Do not tighten it back.
- `snapshot --raw file` / `raw --in image --out file`: the same picture as headerless 8-bit sRGB RGBA, so `still.ts` needs no PNG decoder; `index.ts` deletes the file once read.
- `input`: a **persistent** JSON-lines actor (one command in, one line out) for pointer/gesture/Force Touch synthesis and AX inspect/tree/raise/restore. The server keeps one alive and replaces it when the binary's mtime changes or it dies.
- `lock`: event tap plus HID seize of pointing devices, with the countdown/overlay/pill UI. Reads `extend <s>` / `release` on stdin.
- `watch`: AXObserver + NSWorkspace events as lines.
- `displays`, `snapshot`, `release-cursor`.

`EyeProbe.swift` is not part of that binary: it is injected into the app under test and logs layer presentation geometry per display refresh on the same mach clock as `frames.csv`. Its `EyeMainWatchdog` times every main run-loop turn and samples the main thread's stack while one overruns (`H`/`F` lines); `probe.ts` `readStalls` resolves them into `stalls.json` next to the capture. Code that runs while the main thread is suspended (`sample()`) must not allocate or take a lock.

### Cross-cutting conventions

- **Events**: `startEvents` (index.ts) spawns `eye-capture watch --app <pid> --json --exact` with stdout on `events.jsonl` in the run folder, killed in `stopCapture`. `--exact` stamps `t` when the AX notification arrives (before any question is put to the app), batches value changes per element (first at once, then one line per quarter second with `n`, `t_last`) and adds focus and menu notifications. `loadSaid` / `placeSaid` (notice.ts) merge an element's run of changes and place each event; `notice()` attaches the first event after a step to that step's response line.
- **Root readings**: `src/under.ts`. `startUnder` runs `sudo -n dtrace` (pid provider: `CA::Transaction::commit` in the app, `IOMFBDisplay::swap_set_layer` in WindowServer → `under.txt`) and `sudo -n powermetrics` (→ `cost.jsonl`, stamped on arrival) only when `sudo -n -l` allows them. Root children cannot be signalled: dtrace is held by `-c /bin/cat` on a stdin pipe, powermetrics by its stdout pipe; closing the pipes ends them (`endUnder`). `whoWasLate` judges a freeze by the longest silence between commits; `why-e2e` checks it against a 150ms block when root is allowed. On this machine the rule is in `/etc/sudoers.d/the-eye`.
- **Probe reach**: `buildProbe` makes a fat arm64 + arm64e dylib (Apple's apps load only arm64e; the watchdog reads `__opaque_pc` / `__opaque_fp` there). `stageFor` signs it with the target's certificate when the key is in the keychain, else ad hoc (`Target.foreign`), which loads only with SIP off.
- **Recorded alone**: `eye-capture capture --only-pid` (set by `eye_act`'s own recording and `eye_record {process}`, off with `isolate:false`) uses `SCContentFilter(display:including:[app])` over a mid-grey `backgroundColor`. That property is `assign`: the colour must outlive the stream (`captureBackdrop` is a global for that reason; a temporary crashed the helper at random).
- **Leaps**: `fitMotion` names no engine when over 40% of the way went in one frame; the probe report then prints `leap()`'s account (step, wait, main-thread block). `track.ts` ignores the slivers a rigid thing leaves when it has all but stopped (box minus step = one size, checked at its fastest frames).
- **Coordinates** are display-local points, top-left origin, everywhere (rects, pointer, capture, probe). AX frames are global points, which equal display-local only on the main display.
- **Runs** live in `~/Library/Caches/the-eye/runs/<time>_<label>/` (`THE_EYE_DIR` overrides): `frames.csv`, `frames.csv.meta.json`, `cursor.csv`, `hover.jsonl`, `ax_tree_start.*`, `actions.jsonl`, `stalls.json` (when a probe ran), `keyframes/`. The analyzers read these files, so a column or field change in Swift needs the matching change in `analyze.ts`/`explain.ts`.
- **Every helper call has a deadline.** ScreenCaptureKit sometimes never calls back, so the server must not use `spawnSync` for helpers, stops escalate SIGTERM → SIGKILL, and snapshot falls back to `/usr/sbin/screencapture`. Keep new native calls behind a timeout (`test/stop-hang.mjs` guards this).
- **Synthetic input is tagged** with `eventSourceUserData == 0x45594521` ("EYE!"). The lock drops events whose source pid is 0 (physical) and lets posted ones through. Gesture and pressure events use undocumented CGEvent fields and must be posted at the session tap; the field maps are documented in README ("Two-finger gestures", "Force Touch").
- **Orange on screen means input is locked.** The overlay/pill is shown exactly while a lock is held, and lock preflight must fail before anything appears. `test/lock.mjs` checks both.
- AX observation costs the target app real frame time; reports say when AX was on, and A/B numbers are taken with `ax:false`.

### Environment variables

`THE_EYE_DIR` (runs dir) · `THE_EYE_LEASE_DIR` (lease/queue dir, for tests) · `EYE_QUEUE_WAIT_MS` (queue wait cap, default 45000) · `EYE_WATCH_RAW=1` (echo raw AX notifications to stderr). Commands started by `eye_record` receive `THE_EYE_LIVE`, `THE_EYE_RECT` and `THE_EYE_RUN_DIR`.
