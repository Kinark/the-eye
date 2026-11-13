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

- Node ≥ 23.6 runs the `.ts` files directly by type stripping. There is no tsconfig, no bundler, no linter and no `tsc` step, so only erasable TypeScript syntax works (no `enum`, no `namespace`, no parameter properties), and imports carry the `.ts` extension.
- `bin/` is gitignored build output. The server rebuilds `bin/eye-capture` itself whenever `swift/EyeCapture.swift` is newer than the binary (`ensureBinary` in `src/index.ts`), so after editing Swift you only need to start the server or run a test. A compile error surfaces as a server start failure.
- The probe library is built on demand by `eye_probe` as `bin/EyeProbe_<sha1 of source>.dylib` (old versions pile up in `bin/`; safe to delete).

### Tests

There is no test runner. Each `test/*.mjs` is a standalone script that starts the server over stdio with the MCP client SDK. Run one with `node test/<name>.mjs` and read its output: some assert and exit non-zero (`smoke`, `queue`, `single`, `stale`, `lock`, `gestures`, `watch-events`), others only print what the tools returned.

| script | needs / does |
|---|---|
| `smoke.mjs` | all non-interactive tools; the default check |
| `ax.mjs` | AX hover/tree path; never moves the pointer |
| `stale.mjs` | dummy `.app` bundles in a temp dir; touches no screen or input |
| `queue.mjs` | several servers on a private lease dir (`THE_EYE_LEASE_DIR`) |
| `single.mjs` | lease + duplicate-app rules; launches Calculator, no input lock |
| `stop-hang.mjs [rounds]` | ScreenCaptureKit hang regression |
| `watch-events.mjs` | the `watch` CLI: builds `test/fixtures/ticker.swift`, then drives TextEdit under `eye_lock` |
| `watch.mjs '<eye_record json>' [peek_ms]` | not the watch CLI: starts a background recording and prints `eye_peek` on an interval |
| `lock.mjs`, `gestures.mjs`, `act.mjs` | **take the real input lock** (countdown, orange overlay; Esc ×6 releases). The user loses trackpad and keyboard while they run, so say so before running them |
| `probe-e2e.mjs`, `probe-cost.mjs`, `probe-drive.mjs`, `glass-drag.mjs`, `timer-pill.mjs`, `explain-e2e.mjs`, `process-tree.mjs` | take a process name: a running, debuggable (`get-task-allow`) app, in practice NOOTCH! |

`node test/call.mjs <tool> '<json args>'` calls one tool on a fresh server and prints its text: the quickest way to try a change by hand.

The host process (terminal or agent) needs **Screen Recording** and **Accessibility** permission, or capture and input/lock tests fail.

## Architecture

Two halves: a TypeScript MCP server that orchestrates, and one Swift binary that touches the system. The server never links native code; it spawns `bin/eye-capture <subcommand>` and talks JSON over stdio or files.

### TypeScript (`src/`)

- `index.ts`: everything MCP. Tool registration, the `INSTRUCTIONS` string (the agent-facing guide sent on connect; tool changes must be reflected there as well as in README), child-process management for captures/locks/xctrace, the `Job` model (one per `eye_record`), `eye_act` step execution, window raise/restore for `eye_glance`. `node src/index.ts watch …` short-circuits at the top of the file and just execs the binary's `watch` subcommand.
- `single.ts`: the "one at a time" rules. A file lease (`~/Library/Caches/the-eye/driver.json` + `queue/<pid>.json`) serialises driving tools across every the-eye server on the machine, and app-family checks refuse to act when several copies/builds of the target app are running. Every driving tool handler is wrapped in `driving(name, fail, handler)`; read-only tools are not. `name` may be a function of the args that returns `null` for calls that don't drive (`eye_lock {release}`, `eye_app list`). A new tool that moves the pointer, locks, records or launches must be wrapped.
- `probe.ts`: the `eye_probe` tool and probe reports. Builds `swift/EyeProbe.swift` as a dylib, re-signs a copy with the target app's certificate, stages it where the (possibly sandboxed) target can read it, and loads it with `lldb -p`. Control and status are files in that directory.
- `analyze.ts`: `frames.csv` → animation segments and metrics (pure, no I/O beyond reading the run).
- `explain.ts`: joins the worst gaps with cursor, hovered element, `eye_act` step and main-thread samples (`scripts/xctrace_summary.py` turns an Instruments trace into the latter).

### Swift (`swift/`)

`EyeCapture.swift` is a single-file, top-level-code program (Swift 5 mode, no package). The header comment lists the subcommands; `switch sub` at the bottom dispatches them:

- `capture`: ScreenCaptureKit stream → one CSV row per refresh, plus `frames.csv.live.json` rewritten 10×/s and keyframes.
- `input`: a **persistent** JSON-lines actor (one command in, one line out) for pointer/gesture/Force Touch synthesis and AX inspect/tree/raise/restore. The server keeps one alive and replaces it when the binary's mtime changes or it dies.
- `lock`: event tap plus HID seize of pointing devices, with the countdown/overlay/pill UI. Reads `extend <s>` / `release` on stdin.
- `watch`: AXObserver + NSWorkspace events as lines.
- `displays`, `snapshot`, `release-cursor`.

`EyeProbe.swift` is not part of that binary: it is injected into the app under test and logs layer presentation geometry per display refresh on the same mach clock as `frames.csv`.

### Cross-cutting conventions

- **Coordinates** are display-local points, top-left origin, everywhere (rects, pointer, capture, probe). AX frames are global points, which equal display-local only on the main display.
- **Runs** live in `~/Library/Caches/the-eye/runs/<time>_<label>/` (`THE_EYE_DIR` overrides): `frames.csv`, `frames.csv.meta.json`, `cursor.csv`, `hover.jsonl`, `ax_tree_start.*`, `actions.jsonl`, `keyframes/`. The analyzers read these files, so a column or field change in Swift needs the matching change in `analyze.ts`/`explain.ts`.
- **Every helper call has a deadline.** ScreenCaptureKit sometimes never calls back, so the server must not use `spawnSync` for helpers, stops escalate SIGTERM → SIGKILL, and snapshot falls back to `/usr/sbin/screencapture`. Keep new native calls behind a timeout (`test/stop-hang.mjs` guards this).
- **Synthetic input is tagged** with `eventSourceUserData == 0x45594521` ("EYE!"). The lock drops events whose source pid is 0 (physical) and lets posted ones through. Gesture and pressure events use undocumented CGEvent fields and must be posted at the session tap; the field maps are documented in README ("Two-finger gestures", "Force Touch").
- **Orange on screen means input is locked.** The overlay/pill is shown exactly while a lock is held, and lock preflight must fail before anything appears. `test/lock.mjs` checks both.
- AX observation costs the target app real frame time; reports say when AX was on, and A/B numbers are taken with `ax:false`.

### Environment variables

`THE_EYE_DIR` (runs dir) · `THE_EYE_LEASE_DIR` (lease/queue dir, for tests) · `EYE_QUEUE_WAIT_MS` (queue wait cap, default 45000) · `EYE_WATCH_RAW=1` (echo raw AX notifications to stderr). Commands started by `eye_record` receive `THE_EYE_LIVE`, `THE_EYE_RECT` and `THE_EYE_RUN_DIR`.
