# steps: exact, repeatable to the millisecond

`eye_drive {steps:[…]}` is for measuring and A/B: the same coordinates and timings every run, with a stop after each
step. Up to 60 steps a call. For everything else a wing is easier (`guide:"wing"`).

```
eye_drive {app:"Notes", steps:[{op:"click", x:420, y:300}, {op:"scroll", dy:-200, momentum:true}, {op:"wait_until", expr:"!moving"}], end:true}
```

## The steps

| op | fields |
|---|---|
| `move` | `x`, `y`, `ms` (glide duration; 0 = jump) |
| `click` | `x?`, `y?` (default: where the pointer is), `button` left/right, `count` |
| `down` · `up` | a drag is down, move, up |
| `scroll` | `dy`, `dx` (pixels, wheel sign: negative dy = further down the page), `events`, `interval_ms`, `phased` (trackpad phases, default true), `momentum` (coast after the fingers lift), `decay` (0.5–0.99, default 0.94; higher coasts longer) |
| `pinch` | `scale` (2 = spread to double, 0.5 = pinch to half), `ms` (default 300) |
| `rotate` | `degrees` (+ = clockwise), `ms` (default 300) |
| `smart_zoom` | |
| `swipe` | `direction` left/right/up/down (left = back in browsers) |
| `press` | Force Touch. `force`: pressure keyframes spread over `ms` (default 400) and eased between; default `[0, 0.5, 0]` |
| `force_click` | a ready-made curve, `[0, 0.9, 1.5, 1.5, 0.9, 0]` over `ms` (default 700) |
| `wait` | `ms` |
| `wait_until` | `expr`, `timeout_ms` (default 2000) |
| `assert` | `expr`: the sequence stops unless it holds |
| `type` · `key` · `goto` · `reload` | websites only: `guide:"web"` |

Any step may carry `guard` (an expression that must hold BEFORE it runs, else the sequence stops), `note` (a label
for the report) and `on` (aim `move` / `click` / `down` at a probe layer by label or id instead of x,y: its centre,
from the probe's live data; the layer must be moving or named in `probe:{watch:[…]}` when the session opens. In a
website session `on` names a thing in the page).

Coordinates are global points, top-left origin.

## Expressions

`wait_until`, `assert`, `guard` and the wing words `until:` / `check:` take a JavaScript expression over:

| name | what |
|---|---|
| `a` | the top-anchored open extent `{x0, x1, w, h, cx}`, or null |
| `e` | the bounding box of everything that changed |
| `moving` | whether the screen is moving now |
| `fps1` · `gap1` | new frames in the last second · its worst gap in ms |
| `p` | the pointer `{x, y}` |
| `h` | the element under the pointer (role, title, description, identifier, value, frame, …) or null |
| `live` | the whole live state of the recording |
| `pr` · `L('label')` | the probe's layers · one of them by label |

`a` and `e` are pixel differences: translucent glass over a similar background measures smaller than the view. For
true bounds use accessibility frames (`eye_inspect`, `h.frame`) and keep thresholds loose.

## Force Touch

`press {force:[0, 0.4, 0.8, 0], ms}` is a mouse down, a pressure curve, then a mouse up. 0…1 is stage 1 (a normal
click's pressure), crossing 1 is the force click (stage 2), 1…2 is pressure inside stage 2. `behavior` is the
NSPressureBehavior the events claim (default 5, deep click). Apps receive a real `pressureChange(with:)` sequence.
They do not receive `quickLook(with:)` (Look up): a real trackpad's comes from lower in the system.

## Where input may land

- Presses and gestures only land on the session's app: the owner of the element under the point is checked right
  before posting. A press can never be forced.
- A scroll lands only where the app owns the window or the element under the pointer, inside the measured open
  area, or in `scroll_zones` (extra screen rects, kept for the session once given). A refused scroll says who owns
  the place. `force:true` on a scroll step skips the check.
- A session that only watches (`hands:false`) runs `wait`, `wait_until` and `assert` and refuses the rest.

## After each step

The pointer, the element under it (`ax:false` leaves that out, and costs the app nothing) and the visible state.
Then, as after every call: the screen, what a viewer noticed, what the app told accessibility, the settled frame.

For final frame-rate numbers use steps with `ax:false` and `probe:false`, the same way in both runs of an A/B
(`guide:"measure"`).
