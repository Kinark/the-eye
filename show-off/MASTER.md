# show-off: design system

The page that shows what the-eye does, by doing it to itself. `npm run show-off` serves it; nothing is built.

## Theses

**Visual.** A display-black page. Every demo sits on the mid grey the-eye records apps on (`#808080`, its capture
backdrop). The lock overlay's orange is the only accent and is reserved for moments the page caught something: a late
frame, a freeze, a stall, a corner read as continuous. Type is the Mac's own faces, heavy and tight for display, system
mono with tabular figures for anything measured. Airy sections around dense instruments. Plates are flat, with
continuous corners and no shadows.

**Interaction.** Everything touchable runs on a real spring integrator, tracks the pointer 1:1 while held and keeps its
velocity on release. Hover lifts 1.02 and tilts 2 degrees toward the cursor; press goes to 0.97. Scroll reveals nothing.

**Delight.** The page notices its visitor the way the-eye notices an app, in the same voice and off the same clock.
Every line it says is a measurement; none is a greeting. See "The witness".

Forbidden: fixed-duration easing on physical things, fade-up on scroll, crossfades between states, more than one
ambient loop (the iris breathing is the one), a second accent colour, shadows, glass, gradients. The eye never blinks
for show: its lids move only when the page truly stops seeing.

## Tokens (`style.css :root`)

| Token | Value | Use |
|---|---|---|
| `--black` | `#0B0B0C` | page |
| `--panel` | `#161618` | inset plates, the motion window on the timeline |
| `--line` | `#2C2C30` | hairlines, slider tracks |
| `--stage` | `#808080` | every demo surface |
| `--ink` | `#0B0B0C` | text and marks on the stage, on white, on orange |
| `--white` | `#F4F4F2` | text, pucks, primary buttons |
| `--dim` | `#A6A6A6` | secondary text |
| `--orange` | `#FF8C1A` | caught something |

Quiet buttons use `#242427` (hover `#2F2F33`, active `#1C1C1F`).

Type: `--sans` system-ui stack, `--mono` ui-monospace stack. `--t-display` clamp(64px, 9.4vw, 168px), `--t-h2`
clamp(40px, 5.4vw, 80px), `--t-big` clamp(22px, 2.3vw, 30px), `--t-lead` 21px, `--t-body` 18px, `--t-small` 15px.
Nothing below 14px.

Space: `--s1`..`--s10` = 4, 8, 12, 16, 24, 32, 48, 72, 112, 176px. `--gutter` clamp(20px, 5vw, 72px).

Radii: `--r-plate` 40, `--r-inset` 28, `--r-puck` 22, `--r-ctl` 14, `--r-seg` 12. An inset's radius is its plate's
minus the padding between them.

## The tools section

Read, not played: nothing in it moves or answers the pointer. `eye_drive` gets the one plate (`--panel`, radius 40)
with its calls on a `--black` inset (radius 28); the four that only look sit under hairlines. `.say` (`--t-big`, 700)
is the one-line claim of each tool; inside the plate it grows to clamp(28px, 3.1vw, 44px). No orange here: nothing was
caught. Every claim in the copy is a behaviour README "Tools" states.

## The witness (`js/witness.js`)

- **The lids.** Both eyes (the hero iris and the mark in the bar) are one line while the page sees nothing: the first
  0.8s that is not judged, and while the tab is hidden. They open on `PLAYFUL` at the first judged frame and on
  return, with the pupil wide (1.3) for a moment. On return the bar and the verdict say `THE EYE WAS SHUT for <n>s`,
  and the footer counts it. While hidden the tab's title says it is shut.
- **The gaze.** Eyes follow the thing in motion (`gaze.at`: the puck in the hand or in flight, the playhead while the
  recording plays), else the pointer; 3s after the pointer last moved they look straight at the visitor.
- **The bar's label is a slot.** What the page noticed rolls in from below on `QUICK` and out again after 4.2s: a
  scroll once it rests (distance, time, late frames; under 800pt or 150ms is not said), a freeze caught anywhere on
  the page, 20s without a move ("it has not blinked"), a copy, Esc ×3 and ×6 (the real release rule: each within 1s
  of the one before). Under 900px the notice takes the number's place while it is said. Orange only for a late frame,
  a freeze, or the eye having been shut.
- **The tab.** After a freeze the favicon's iris is orange and the title reads `froze <n>ms` for 8s.
- **The puck** rises 6% into the hand and stretches up to 14% along its travel with its speed, about its own centre,
  so the position the fitter reads is unchanged. A frame that came late during a flight leaves an orange, taller tick.
- **Keys.** A `<kbd data-key>` goes down when the real key does.
- **The console.** `eye.freeze(ms)` and `eye.report()`: the same button and the same words.
- The footer adds how long the visitor watched, how far they scrolled, and how long the eye was shut.

## Corners

`corner-shape` is Chromium-only, so corners are cut the same way in every engine: `js/squircle.js` builds a
superellipse outline (exponent 5, reaching 1.5× the nominal radius) and applies it as a `clip-path` to anything marked
`data-squircle="<radius>"`. Because a clip-path clips outlines, buttons draw their focus ring as an inset box-shadow;
ranges, selects and canvases use a real outline.

## Motion

`js/spring.js`: `QUICK` (stiffness 420, damping 32) for direct feedback, `PLAYFUL` (180, 14) for the puck. Springs are
integrated per frame from the measured frame time, so they are interruptible and carry velocity. Transitions with a
duration exist only for colour.

Reduce Motion: tilt, breathing, the pupil following anything, the lids, the label's roll (it swaps), the puck's
stretch and lift, and the keycap dip are off. The puck and the replay still move, because
the visitor starts them and they are the content.

## Contrast (computed)

White on black 17:1 · dim on black 7.8:1 · orange on black 8.5:1 · ink on orange 8.5:1 · ink on stage 4.99:1 · white
puck on stage 3.8:1 (a graphic, not text).

## Honesty rules

- The page times its own `requestAnimationFrame` callbacks, from inside. the-eye reads the display from outside. The
  page says so.
- The first 800ms after load are not judged (`js/meter.js`).
- The fit shown is `src/physics.ts` itself, served with its types stripped. The corner read is `src/still.ts` itself.
- The replay is one real run, reduced by `data/extract.mjs`. Its report is quoted as returned, minus two stack-trace
  lines per stall.

## Files

`serve.mjs` server · `index.html` · `style.css` · `js/meter.js` frame log · `js/spring.js` · `js/squircle.js` ·
`js/iris.js` hero eye · `js/witness.js` what the page notices about the visitor · `js/hero.js` freeze and verdict · `js/puck.js` + `js/fit-worker.js` fling and fit ·
`js/replay.js` + `js/replay-draw.js` recording · `js/corner.js` corner reader · `data/` the recording.
