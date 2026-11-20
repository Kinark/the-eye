# reply: reading what comes back

## Every eye_drive reply

What the hand did (elements passed over, presses, where it is now), then the screen (moving / still), what a viewer
noticed during this call, what the app told accessibility, and the frame the screen settled on. `end:true` adds the
report for the whole session, with the recorded frame at each ✗.

FRAMES come back unasked. Look at them; they are the picture the numbers describe.

## WHAT IT LOOKED LIKE

It opens with a verdict: SMOOTH · MOSTLY SMOOTH · ROUGH · BROKEN · NOTHING MOVED. Then, worst first, each thing a
viewer would have noticed: freezes, judder, jumps, flashes, slow answers to input.

- ✗ = clearly visible
- ~ = visible if you look
- · = a fact, not a defect

Read the verdict; go to `eye_report` only when you need numbers.

NOT SEEN IN FULL, SAW NOTHING or "⚠ NOT SEEING" mean exactly that: do not report on that stretch as if you had
watched it. THE EYE WAS SHUT names a stretch the capture missed.

## moved by:

Under a motion: the engine fitted to its frames.

| line | meaning |
|---|---|
| SPRING | damping ratio, response, and the SwiftUI call that reproduces it |
| TIMING CURVE | its name or cubic-bezier, and the duration |
| PER-FRAME LERP | the factor; "frame-rate dependent" = it fell behind where frames dropped |
| BOUNCE | gravity and restitution |
| "or equally:" | the frames cannot tell two engines apart |
| "nothing simple" | no single engine: driven by hand, retargeted, or several at once |
| "it dimmed / brightened in place" | a fade |

These are measurements: whether it is the right motion is your call. For reference, SwiftUI's `.smooth` is bounce 0,
`.snappy` 0.15, `.bouncy` 0.3, all 0.5s.

## why:

Under a freeze: its cause, from the probe inside the app. Either how long the main thread was blocked and in which
function, or that it was free and the frames were lost after the app.

With the probe, FROM INSIDE THE APP also gives, per moving layer:

- "declared:" the Core Animation animation the code attached
- the same fit as "moved by:", on the layer's exact values
- "✓ it ran as declared" or "≠ …"

No "declared:" means the app drives the value itself each frame (SwiftUI on macOS does).

When the probe could not go in, one line says why (no Debug build, Xcode is debugging the app) and "why:" is missing.

## WHO WAS LATE

Under a freeze: the app committed nothing / the window server was late / nothing changed. Per motion: how often the
app committed, how many frames reached the display, what moving cost in energy. These come from signposts, and from
dtrace and powermetrics where sudo allows them without a password (`guide:"measure"`). Nothing ever asks for one.

## what the app told accessibility

Value changes, focus, windows, sheets and announcements, placed on the recording's clock. Under "answered …" it says
who was first: "the app knew first" = the wait was in drawing, not deciding. If the app told accessibility nothing,
assistive technology was not told what changed.

## YOUR FINGERS

At the end of a session that watched: each two-finger touch the user made (`guide:"fingers"`).

## "## at rest" (eye_snapshot)

What one still frame says by itself: text sizes and the weakest contrast (WCAG), a thing 0.5–3pt off its neighbours'
line, uneven gaps, overlaps, a label cut by the window, the shape of each corner (circular arc or continuous, with
radius). The rules are narrow on purpose: an empty line means "nothing plainly off", not "perfect".
`measure:false` skips it.

## eye_report

Re-reads a finished run (default: the most recent; a run folder works as `csv`).

| view | |
|---|---|
| `summary` (default) | what a viewer would have noticed, then one row per motion: fps = new images per second against the display refresh; stall% = observed refreshes with no new image (a lower bound); hitch = a gap ≥ 1.5 frames, long ≥ 3; jumps = abrupt speed changes of the moving edge; w/h = its extent in points |
| `timeline` | binned time series (frames, idle, worst gap, % moved, luma, extent); `bin_ms` default 50 |
| `explain` | the worst on-screen gaps joined with where the pointer was, the element under it, the step that ran and, with `profile`, the app's main thread |
| `hover` | every change of the element under the pointer |
| `compare` | `runs:[{csv,label},…]` side by side against the first |
| `probe` | `file: probe.ndjson`: per-layer report, or one layer's per-frame series with `layer_id` |

`from_s` / `to_s` narrow any of them to a stretch.

## When something did not run

- "NOT RUN, nothing was sent": read the reason; nothing reached the app.
- "QUEUED, not run": another agent session is driving. Call again within 20s to keep your place.
- "the lock engaged on try N": it was refused first (the line says why) and then taken; the call ran.
- A list of running copies with choices: several builds of the app run. Pick with `duplicates`
  (`guide:"session"`).
