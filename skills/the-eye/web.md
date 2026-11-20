# web: a website instead of an app

```
eye_drive {url:"localhost:3000", wing:'el:"Sign in" tap type:"igor@example.com" key:"Enter" settle', end:true}
```

`url` opens the page in the eye's own Chromium-family browser (Chrome for Testing, Chromium, Chrome, Brave or Edge;
its own profile, kept between sessions, so a login stays) and records that window. Everything that works on an app
works on it: the hand presses what accessibility names, wings, steps, fingers, the reply. `url` may be
`localhost:3000`, a file path or any URL. Given again in an open website session it loads in the same tab.

The dev server must be running first: "did not load: net::ERR_CONNECTION_REFUSED (is the dev server running?)"
means it is not.

| argument | |
|---|---|
| `viewport: {w, h}` | size the window so the page's viewport is exactly w×h CSS px (390×844 for a phone layout) |
| `reload: true` | load it afresh even when the tab already shows it |
| `browser` | "chrome", "chromium", "brave", "edge" or a path to the .app. Default `THE_EYE_BROWSER`, else the first one installed |
| `quit: true` with `url` | quits the eye's browser |

## Finding things IN THE PAGE

A thing is named by CSS selector, accessible name, label or text. It is waited for (`timeout_ms`, default 5000)
until it is visible, enabled, uncovered and at rest, scrolled into view if needed, and only then pressed.

| in a wing | in steps | |
|---|---|---|
| `el:"selector or name"` then `tap` | `{op:"click", on:"…"}` (also `move`, `down`) | go to that thing in the page |
| `type:"text"` | `{op:"type", text, on?}` | typed key by key into what has focus (or into `on`, focused first); `\n` presses Enter |
| `key:"Enter"` · `key:"Meta+a"` | `{op:"key", key}` | one key with modifiers: "Escape", "Shift+Tab"; Meta+a/c/x/v/z run the macOS editing commands |
| `goto:"url"` | `{op:"goto", url}` | load it in the session's tab; waits for its load event |
| `reload` | `{op:"reload"}` | |
| `js:"expression" [ms]` | `{op:"wait_until", js}` · `{op:"assert", js}` | an expression run IN THE PAGE, truthy = holds (promises are awaited; default 2000ms): `document.querySelector('#toast')?.textContent.includes('Saved')` |

A plain `"Name"` in a wing still works: that is the accessibility name, as in an app. `el:` looks in the page
itself, which also finds things by selector and waits for them.

`eye_inspect {page:true}` lists what can be pressed or read in the page: CSS selector, name, state, value and screen
rect (needs an open website session).

## What the page said

Each reply adds it: console errors and warnings, uncaught exceptions, failed loads, slow answers to input (Event
Timing ≥ 40ms), layout shifts.

## The page probe

It goes in by itself.

- "why:" under a freeze names the script function and its file:line, from the browser's long-animation-frame
  timing.
- FROM INSIDE THE PAGE gives each moving element's declared CSS transition, animation or Web Animation next to the
  fit on its exact per-frame geometry, and "✓ it ran as declared" or "≠ …".

## Not covered

Safari and Firefox cannot be driven this way. Things inside iframes and shadow DOM are not found by `el:` / `on`
(the accessibility name may still reach them). Page zoom other than 100% puts rects off.
