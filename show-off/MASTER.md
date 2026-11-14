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

Forbidden: fixed-duration easing on physical things, fade-up on scroll, crossfades between states, more than one
ambient loop (the iris breathing is the one), a second accent colour, shadows, glass, gradients.

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

## Corners

`corner-shape` is Chromium-only, so corners are cut the same way in every engine: `js/squircle.js` builds a
superellipse outline (exponent 5, reaching 1.5× the nominal radius) and applies it as a `clip-path` to anything marked
`data-squircle="<radius>"`. Because a clip-path clips outlines, buttons draw their focus ring as an inset box-shadow;
ranges, selects and canvases use a real outline.

## Motion

`js/spring.js`: `QUICK` (stiffness 420, damping 32) for direct feedback, `PLAYFUL` (180, 14) for the puck. Springs are
integrated per frame from the measured frame time, so they are interruptible and carry velocity. Transitions with a
duration exist only for colour.

Reduce Motion: tilt, breathing and the pupil following the cursor are off. The puck and the replay still move, because
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
`js/iris.js` hero eye · `js/hero.js` freeze and verdict · `js/puck.js` + `js/fit-worker.js` fling and fit ·
`js/replay.js` + `js/replay-draw.js` recording · `js/corner.js` corner reader · `data/` the recording.
