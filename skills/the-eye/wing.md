# wing: a line of words, one unbroken motion

`eye_drive {wing:'…'}` flies the hand through every word without a stop between its points. Words are separated by
spaces. Wings and exact `steps` mix freely in one session; when a call carries both, the wing runs first.

```
eye_drive {app:"Calculator", wing:'"7" tap "Add" tap "3" tap "Equals" tap settle', end:true}   the whole loop in one call
eye_drive {app:"Music", wing:'"Volume" down E 80 rest 200 W 30 up'}    opens a session; a drag, steered
eye_drive {wing:'slow E'}                                    keep going east…
eye_drive {wing:'S'}                                         …now bend south, from the speed it has
eye_drive {end:true}                                         let go, free the input, the verdict for the whole session
```

## The words

| word | what the hand does |
|---|---|
| `"Name"` · `Button:"Name"` · `#identifier` | fly to that thing, found in the app's accessibility tree as it is right now. Exact name beats prefix beats substring; things that can be pressed win ties. `Button:` says which kind, `#` goes by accessibility identifier |
| `x,y` | fly to a point (global points, top-left origin) |
| `N NE E SE S SW W NW` or `↑↗→↘↓↙←↖` | with a distance in points: that far that way. Without: keep flying that way until the next wing, the window's edge, or `coast_ms` after the reply (default 1500) |
| `tap` `tap2` `tap3` `rtap` | click, double, triple, right click what is under the hand |
| `down` `up` | press and release: a drag is `down`, some moves, `up` |
| `scroll up\|down\|left\|right <px>` | a two-finger scroll at the pointer, named by where the PAGE goes (`scroll down` = further down a list, whatever the Natural scrolling setting). Exactly that many pixels; it lands and lifts by itself |
| `fling up\|down\|left\|right <px>` | the same with momentum after the fingers lift |
| `fingers …` · `flick` · `lift` | two fingers that land on the trackpad and STAY DOWN, named by where the FINGERS go: the opposite sense of `scroll`. Its own chapter: `guide:"fingers"` |
| `pinch <scale> [ms]` · `rotate <degrees> [ms]` · `zoom` · `swipe left\|right\|up\|down` | trackpad gestures where the hand is (pinch 2 = spread to double, 0.5 = pinch to half; rotate + = clockwise; `zoom` = smart zoom; swipe left = back in browsers) |
| `press [ms]` · `force [ms]` | Force Touch: stage 1 · a force click |
| `rest <ms>` | let time pass (default 200); a heading keeps flying meanwhile |
| `settle` | wait until the screen is still (up to 2000ms, or the number after it) |
| `halt` | brake where it is |
| `slow` `walk` `brisk` `fast` `<n>/s` | pace from here on: 220 / 450 / 700 / 1200 points a second, or a number. Default 700 (the `speed` argument sets it too) |
| `until:"expr" [ms]` | wait until the expression holds (default 2000ms). Expressions: `guide:"steps"` |
| `check:"expr"` | stop the wing unless it holds |
| `layer:"label"` | fly to that probe layer, where it is right now |
| `el:"…"` `type:"…"` `key:"…"` `goto:"…"` `reload` `js:"…" [ms]` | websites only: `guide:"web"` |

## How it moves

The hand has mass: position and velocity are integrated 120 times a second and velocity eases toward what was asked.
A target followed by another target is passed through, not stopped at, so a change of direction is an arc. A target
followed by a press is landed on. A named thing is looked at again every 30ms while the hand flies, and the aim moves
with it.

A hand left on a heading (`E` with no distance) keeps flying after the reply for `coast_ms`, then brakes by itself.
The next wing turns it from the speed it has.

## What it will not do

- Reach for a thing that is not in sight. A name that matches nothing ends the wing with the list of what IS there;
  a thing with something else over it is not flown to ("Button "7" is there but not in sight: Finder's sidebar is
  over it").
- Press something else. A `tap` after a named thing is only sent if that thing is what is under the hand at that
  moment.
- Act unseen. Nothing is sent to a window that is minimized, hidden, on another Space or on a sleeping display, and
  the hand brakes where it is if the capture goes blind.
- Leave the app. Presses and gestures land only on the session's app.

## What comes back

Every element the pointer passed over, in order, with the stretch it covered and for how long; each press, where it
happened and on what; where the hand is now; if it is still flying, what lies ahead on its line and in how many
milliseconds. Then, as after every call: the screen (moving or still), what a viewer noticed during this call, what
the app told accessibility, and the frame it settled on. The element tree is shown when a session with a hand opens
(`look:true` shows it again): take the names for the next wing from it.

A wing that cannot be read is not flown at all: the reply names the word and nothing is sent.
