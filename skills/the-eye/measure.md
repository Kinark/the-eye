# measure: numbers you can stand behind

## The probe

It goes in by itself, once per app launch, when a session opens on an app. From inside it times the main thread
(every freeze gets its cause) and logs each layer's animated geometry and the animation its code declared.

- It needs a Debug build (or System Integrity Protection off) and cannot join an app Xcode is debugging. When it
  cannot go in, one line says why and the session goes on.
- It costs about 0.2ms a frame: `probe:false` for the cleanest fps numbers.
- `probe:true` tries again. `probe:{match:[…]}` logs only layers whose label (layer class, view class, name)
  contains one of the strings; `watch:[…]` always shows those layers in the live summary, moving or not, which is
  what lets a step aim at one with `on`. `full_walk` and `max_layers` widen what it walks.
- `probe:"xcode"`: the app runs under Xcode's debugger. The reply prints the lldb commands to send through Xcode.

## A/B

The same steps twice with different `label`s, then `eye_report {runs:[{csv,label},…]}`; the first is the baseline.
Compare runs taken the same way: probe on in both or off in both, `ax` the same, the same steps (not wings: a wing
aims at things as they are, steps repeat to the millisecond).

For final frame-rate numbers: steps with `ax:false` and `probe:false`.

## What costs the app frames

- Accessibility. Reading a SwiftUI app's tree turns on its accessibility work for a while (slower frames): don't
  call `eye_inspect` or ask for a tree in the middle of a measurement. Reports say when AX was on.
- The probe, about 0.2ms a frame.
- `profile:true` records Instruments (Time Profiler + Hitches) beside the session, aligned with the frames for
  `eye_report view:"explain"`. Starting it takes a few seconds, and accessibility hover is off by default while it
  runs. An object names another process or template: `{process, template, hitches, keep_trace}` (the raw .trace is
  dropped by default: it embeds the app's environment, which may contain secrets).

## What is recorded

- `isolate` (default true on a window, false on a rect): the app's own windows alone, over mid grey, so nothing
  behind a see-through window or over the app is mistaken for its motion.
- `events` (default true): what the app tells accessibility, on the recording's clock.
- `keyframe_ms`: a small frame kept every N ms while the picture changes (default 100 with a hand, 200 watching; 0 =
  none). The film strip and the frames at each ✗ come from them; `eye_snapshot {csv, t_s}` reads them.
- `frames:false` leaves the images out of the replies.
- `label` names the run folder and the reports.

## Under the pixels

Signposts and the app's own energy need no root and are always read. This app's own share of the display's frames
and GPU power need dtrace and powermetrics without a password: add
`<you> ALL=(root) NOPASSWD: /usr/sbin/dtrace, /usr/bin/powermetrics` to `/etc/sudoers.d/the-eye`
(`sudo visudo -f /etc/sudoers.d/the-eye`). Nothing ever asks for a password. `root:false` leaves the root readers
out.

## Reading the analysis differently

`motion_threshold` (fraction of sampled pixels that must change for a frame to count as moving, default 0.0005),
`split_gap_ms` (a pause longer than this splits motions, default 150) and `refresh_hz` (the target rate, default
from the capture) apply to `eye_drive` and `eye_report` alike.

## Coordinates

POINTS, top-left origin, everywhere. `rect` is display-local (`eye_status` lists displays); the pointer,
accessibility frames and step x/y are global. On the main display both are the same.

The measured extent (`a`, `e` in expressions) is a pixel difference: translucent glass over a similar background
measures smaller than the view. For true bounds use accessibility frames (`eye_inspect`, `h.frame`) and keep
`wait_until` thresholds loose.

## When a bug does not reproduce

Input is synthetic and reaches apps by another path than a physical trackpad. Vary it: speeds, phased or unphased
scroll, momentum, hover paths, the user's own touch played back (`fingers like:`), your own CGEvent driver
(`command`), and report what each run measured.

## The files of a run

`~/Library/Caches/the-eye/runs/<time>_<label>/` (`THE_EYE_DIR` moves it): `frames.csv` (one row per display
refresh), `cursor.csv`, `actions.jsonl`, `events.jsonl`, `hover.jsonl`, `fingers.jsonl`, `stalls.json` (when a probe
ran), `probe.ndjson`, `keyframes/`.
