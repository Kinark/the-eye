# fingers: two fingers on the trackpad

For a thing that FOLLOWS the fingers and answers back: a notch pulled open, a sheet that rubber-bands, a scrubber,
anything that stretches or wobbles. `fingers` are words of a wing (`guide:"wing"`).

Two ways to scroll, and they point opposite ways:

- `scroll down 300` names where the PAGE goes (further down a list). It lands, travels exactly that far and lifts.
- `fingers down 60` names where two FINGERS go on the trackpad (points, y down). They land and STAY DOWN: what is
  under them follows as under a drag. The events are the ones this machine's trackpad would send under its Natural
  scrolling setting.

Put the pointer on the thing first (`"Name"` or `x,y`), then the fingers.

## Strokes

Fingers move in TWO dimensions: do not drive them along one axis unless the thing under them only has one.

| words | what the fingers do |
|---|---|
| `fingers up\|down\|left\|right\|<compass> <pt>` | a line |
| `fingers <dx>,<dy> <dx>,<dy> …` | ONE curved stroke through those offsets (y down). It never stops at a point, so corners are turns: `fingers 30,18 -22,30 -35,-8 12,-34` |
| `fingers orbit <r> [turns]` | a circle back to where it began; negative turns = the other way round |
| `fingers wander <r> [ms]` | roams within r of where it is, differently every time, and comes back (default 1500ms) |
| `flick` | right after a stroke: it leaves at speed along its last direction, the fingers lift and the thing coasts with momentum (`fingers down 120 flick`). Not after a wander or anything kept up |
| `lift` | the fingers let go |

They land with the first stroke; every further stroke is the same touch (began once, ended once), exact to the pixel.
Strokes written one after another are flown as ONE movement: the fingers slow into bends and run on the straights, as
a hand does. `rest`, `settle`, `until:` and `check:` between strokes keep the fingers where they are; any other move
lifts them first.

## Kept up until the next word

For a moment, not to fill time (a held wave is a tremor):

| words | |
|---|---|
| `fingers wave <±pt> [times a second] [way]` | back and forth; the way is up/down/left/right or a compass word |
| `fingers stir <r> [turns a second]` | circles; a negative rate turns the other way |
| `fingers roam <r>` | anywhere within r |
| `fingers go <way>` | on and on that way at the pace |
| `… along <dx>,<dy> [ms]` | added to a wave, stir or roam: the place itself travels meanwhile |
| `fingers calm` | whatever they kept up dies away; they stay down |

## Let them play

To PLAY with something, do not compose it stroke by stroke. Put the pointer on it and say
`fingers play [gentle|lively|wild] [size in points] [up|down|left|right to begin]`, then rest for as long as you
want to watch:

```
eye_drive {app:"NOOTCH!-Dev", wing:'756,14 rest 600 fingers play rest 12000'}
```

The hand sees the screen twenty times a second and plays in phrases, as a person does: a pull to see what the thing
does and further while it grows, a wave where it answers, a shake, a slow slide across, further than it has been,
held stretched and let go, thrown with a flick. It lifts to watch the thing settle and lands again by itself; where
the screen jumped without the fingers doing anything new (a POP) it goes slowly back over that place.

They go on while you think. Steer with the next call: a stroke you write sends them that way and they play on from
there, `fingers play wild 90` changes how, `fingers calm` stops the play with the fingers still down, `lift` ends
the touch.

## The reply while fingers are down

It is short and does not wait for the screen to stop (it will not, the fingers keep going): where they are and what
they keep doing, how far the thing went, what they did (pull, further, wave, shake, slide, far, flick then THROWN,
LIFT, POP), where the screen gave most, and a FILM STRIP of the frames since the last reply with the trackpad drawn
beside each frame. Look at it, then answer with the next fingers word. `brief:false` gives the full reply instead.

How long they stay down after a reply:

- left down at the end of a stroke: `hold_ms` (default 20000), then they lift by themselves; the reply says so either
  way. So you can answer what you saw with the next stroke without the app seeing a lift.
- `hold_ms` is kept for the session once given (up to 60000).
- A wing with anything kept up or `fingers play` has no end, so the session shows the full 3·2·1 lock warning.

The user's Esc ×6 stops the fingers as well as the lock.

## Learn how the user moves

Watch them: `eye_drive {app, hands:false, seconds:20}` while they play. Every recording listens to the trackpad, and
the report ends with YOUR FINGERS: each two-finger touch they made (when, how long, travel, speed, how often it
turned back, whether it left with a flick).

`fingers like:"last" [n]` in a later wing plays touch n back exactly as they made it, on its own clock ("last" or a
run folder; default the longest touch). One that left at speed is thrown again: the fingers lift and the thing
coasts. One that came to a stop leaves the fingers down.
