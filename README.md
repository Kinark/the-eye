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

## Tools

Ten tools. The server's MCP `instructions` carry the full "what / when / how" guide agents see on connect.

| tool | what |
|---|---|
| `eye_status` | displays (id, points, scale, refresh rate), active recordings / probe runs / locks, runs dir |
| `eye_inspect` | **accessibility view, no recording**: everything the element under a point exposes (default: the pointer), or the element **tree** of the windows visible in a rect, one line per element with its bounds |
| `eye_snapshot` | one PNG of a region (`rect`), or a recording's keyframes near a time (`csv`, `t_s`) |
| `eye_record` | record a region. No command/seconds → background, returns an id at once (with the AX tree). `seconds` → blocking. `command` → runs your input driver while recording, optional `lock_input`, returns output + report. `background:true` for long runs |
| `eye_peek` | live state of a running recording or probe: moving, extent, recent fps/hitches, **element under the pointer** (`hover:"full"` for every attribute), command output, probe layers, optional fresh AX `tree` |
| `eye_act` | **interactive driving**: `move`, `click`, `down`/`up`, `scroll` (two-finger, optional `momentum` fling), two-finger gestures `pinch {scale}`, `rotate {degrees}`, `smart_zoom`, `swipe {direction}`, Force Touch `press {force:[…]}` / `force_click`, `wait`, `wait_until`, `assert`. After **every** step: pointer, element under it, visible state. Expressions get `h` (the element). Presses and gestures only on `target_process`; scrolls only inside the open area or `scroll_zones` |
| `eye_stop` | end a recording and/or probe run (all if no id), kill a running command, return the report(s); the probe report is aligned to the capture |
| `eye_report` | re-analyze: `summary`, `timeline`, `explain` (worst gaps × cursor × element × eye_act step × main thread), `hover` (element-under-pointer changes), `compare` (runs), `probe` (probe.ndjson / one layer) |
| `eye_app` | list / quit / launch / relaunch the app under test, counting every copy and build of it |
| `eye_lock` | block all physical input, trackpad and keyboard (`seconds`), or `release:true` |
| `eye_probe` | load the layer probe into an app if needed and start recording layer geometry (see below) |

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
(`frames.csv`, `frames.csv.meta.json`, `cursor.csv`, `hover.jsonl`, `ax_tree_start.*`, `actions.jsonl`, `keyframes/`). Override the location with `THE_EYE_DIR`.

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

- **One driving session.** Every MCP client starts its own the-eye server, but there is one screen and one pointer.
  `eye_act`, `eye_lock`, `eye_record` and `eye_probe` take a lease in `~/Library/Caches/the-eye/driver.json`. It is
  renewed by each driving call, kept while a recording, lock or probe runs, and released when the session ends or 60s
  after its last driving call. Another server's driving call fails with `BUSY` and names the holder; read-only tools
  (`eye_inspect`, `eye_snapshot`, `eye_status`, `eye_report`, `eye_peek`, `eye_stop`) always work.
- **One copy of the app under test, checked by the server.** A family is every copy and every build of an app: same
  executable name, or the same stem once build-variant words are dropped (`NOOTCH!-Dev`, `NOOTCH!`; also the bundle-id
  stem). Before `eye_act` (its `target_process`, or the probe's target), `eye_probe` and `eye_record {process}` the
  server checks the family; if more than one runs it stops with the list and the choices: `duplicates: "quit_others"`
  (keep the pid you named, else the newest launch), `"relaunch"` (quit all, start the target's `.app` fresh, or
  `app_path`), `"allow"`, or stop and ask the user. Recordings without `process` flag duplicated apps found in their
  rect. Every app it has seen is watched (every 2s): a copy launched later shows up as a ⚠ line in the next tool result
  and in `eye_status`. `eye_app` lists, quits, launches (never a second copy) and relaunches. Test: `test/single.mjs`.

## Input lock and drivers

Every lock (`eye_act`'s automatic one, `eye_record lock_input`, `eye_lock`) taps every event type and drops
all physical input whose source process ID is 0: pointer, scroll, trackpad gestures, force touch, keys, modifiers and
media keys. It also seizes every pointing device at the HID level (`IOHIDDeviceOpen` with `kIOHIDOptionsTypeSeizeDevice`, including mice connected mid-lock), so the trackpad never reaches the window server and the cursor doesn't move at all, while posted moves still drive it. The kernel drops the seize if the process dies. The report has `pointer_devices_seized`, and `max_cursor_drift_pt` says how far the cursor ever got from where it should be (should be 0). Before blocking, it shows a 3·2·1 countdown in the middle of every screen (0.5s per
number, 1.5s total) while input is still free (the tap is not armed until it ends; `test/lock.mjs` checks this); the tools wait for it. The orange overlay is shown exactly while a lock is held, so orange on screen
means no physical input gets through. The user's emergency release is Esc six times in a row, each within 1s of the
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

Tests: `node test/smoke.mjs` (all non-interactive tools), `node test/ax.mjs` (AX hover/tree path; never moves the pointer).
