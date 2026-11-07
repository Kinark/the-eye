# the-eye

An MCP server that lets an agent **measure what is visible on a macOS screen over time**, as numbers instead of
screenshots. It captures a screen region at the display's full refresh rate (ScreenCaptureKit) and logs one row per
display refresh. From that log it reports how smooth an animation *actually looked*: real on-screen fps, stalled
refreshes, hitches, frame-gap distribution, and the size/position curve of whatever moved.

Built to answer "did this change make the animation smoother?" objectively, and to A/B app builds and settings.

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

## Tools

| tool | what |
|---|---|
| `eye_displays` | displays: id, points, scale, refresh rate |
| `eye_record` | record a region for N s (blocking) and return the report |
| `eye_start` / `eye_stop` | background recording around your own actions |
| `eye_record_while` | record + optionally **lock the physical trackpad/mouse** + run a shell command (your input driver) + report. Best for A/B tests. |
| `eye_act` | **interactive driving**: run a few input steps (`move`, `click`, `down`/`up`, `scroll`, `wait`, `wait_until`, `assert`) and get the measured visible state after **every** step. You read it, think, and send the next steps. Steps can carry a `guard`. Scrolls are refused unless the pointer is inside the measured open area or a `scroll_zones` rect. |
| `eye_peek` / `eye_abort` | live status of a background `eye_record_while` run (what's visible now, last few seconds of fps and hitches, the driver's latest output), or kill it immediately |
| `eye_analyze` | re-analyze a run (time window, thresholds) |
| `eye_compare` | side-by-side table of runs with deltas vs the first |
| `eye_timeline` | binned time series (frames, idle, worst gap, % moved, luma, extent) |
| `eye_frames` | keyframe PNGs near a time (record with `keyframe_ms`) |
| `eye_snapshot` | one PNG of a region |
| `eye_lock_input` / `eye_unlock` | block physical pointer input. Synthetic events pass, the keyboard stays live, **Esc** releases, and it auto-releases after a timeout. |
| `eye_status` | active captures and locks |
| `eye_probe_attach` | load the **layer probe** into a running app (see below) |
| `eye_probe_start` / `eye_probe_peek` / `eye_probe_stop` | record per-frame layer geometry; peek every ~0.5s while acting |
| `eye_probe_report` | re-analyze a probe recording, or dump one layer's per-frame series |

## Layer probe (geometry from inside the app, no pixels)

`swift/EyeProbe.swift` is a small library loaded **into** the target app through a debugger. On every display refresh
(a `CADisplayLink` on the target screen) it walks the layer tree of every visible window and logs each layer's
**presentation** geometry, meaning the live animated values: frame, opacity, and the bounds of its shape path or
`CAShapeLayer` mask. Everything is in display-local points, top-left origin (the same space as the capture), and
timestamped on the same mach clock as `frames.csv`. A rect, `match` and `watch` narrow what is logged and shown.

- **Attach:** `eye_probe_attach {process}` builds the library and signs a copy with the **target's own certificate**
  (needed for library validation; the key must be in your keychain). It stages the copy where the app can read it (its
  container when sandboxed) and loads it with `lldb -p`. If Xcode already debugs the app, it returns the commands
  to send through Xcode's `InvokeDebuggerCommand` instead. The target must be debuggable (`get-task-allow`, e.g. a Debug build).
- **Control** is file based (`control.json` / `status.json` in that directory), so it works inside the sandbox.
- **Live:** `<recording>.live.json` is rewritten every 0.25s with the last 0.5s: ticks/s, walk cost, the layers that
  moved (updates, coverage = frames changed / frames in its motion, max gap, current rect/shape) and the `watch` layers.
  `eye_probe_peek`, `eye_peek` and `eye_act` show it. `eye_act` expressions get `pr` (the JSON) and `L('label')`.
- **Cost:** about 0.2ms per frame on the app's main thread for a small tree. It's reported in every peek and report.
- **Limit:** it sees what the app hands to the system. Effects the window server renders itself (system glass,
  backdrops) can still lag on screen. Record an `eye_start` capture of the same moment and pass its `capture_csv`.
  Probe rows that update every frame alongside a capture that doesn't change point at the window server.

Test: `node test/probe-e2e.mjs '<process>' [seconds] '<start args json>'`.

Coordinates are **display-local points, top-left origin**. Runs are stored in `~/Library/Caches/the-eye/runs/<time>_<label>/`
(`frames.csv`, `frames.csv.meta.json`, `keyframes/`). Override the location with `THE_EYE_DIR`.

### Live state

While recording, `frames.csv.live.json` is rewritten 10 times a second with what is visible right now:
- `moving`
- `last_1s`: new frames, idle refreshes, worst gap, hitches
- `anchored_screen`: the top-anchored extent. Its width is measured along a row inside the menu bar, starting from the
  display center; its height is how far the change hangs down. This is the open notch or panel, unaffected by changes elsewhere.
- `changed_extent_screen`: the bounding box of every change since the first frame

Commands started by `eye_record_while` get `THE_EYE_LIVE` (that file's path), `THE_EYE_RECT` and `THE_EYE_RUN_DIR`, so a
driver script can check state before every action. In `eye_act` expressions, `a` is `anchored_screen`, `e` is the
changed extent, and `p` is the pointer.

Interactive loop: `eye_start` → `eye_lock_input` → repeat `eye_act` (act → read numbers → decide) → `eye_unlock` → `eye_stop`.

### Input lock and drivers

The lock drops pointer events whose source process ID is 0 (physical hardware). Its result includes
`pointer_events_by_source_pid`, so you can check what it saw. Events posted by any process pass through,
including Peekaboo, `cliclick` and your own CGEvent drivers. With `allow: "tagged"`, only events carrying
`eventSourceUserData == 0x45594521` ("EYE!") pass.

### Hang protection

ScreenCaptureKit sometimes never calls back. This is common for `SCStream.stopCapture()` right after
another SCK screenshot, and occasional for `SCScreenshotManager`. Every helper call therefore has a deadline:
- capture stop: frames are already on disk, so the meta is written after 2s anyway (`stop_timed_out: true` in the meta)
- capture start: 8s; snapshot: 4s, then the server falls back to `/usr/sbin/screencapture`; displays: 5s
- the server never uses `spawnSync` for helpers. Stopping escalates SIGTERM → SIGKILL, and a wedged input actor is killed and respawned.

Regression test: `node test/stop-hang.mjs [rounds]`.

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
eye_record_while { rect: {x:356,y:0,w:800,h:300}, command: "./drive full", lock_input: true, label: "timer-on" }
eye_compare { runs: [{csv: ".../frames.csv", label: "baseline"}, {csv: ".../frames.csv", label: "timer-on"}] }
```

Test: `node test/smoke.mjs`.
