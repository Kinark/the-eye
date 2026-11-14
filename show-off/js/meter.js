// The page's one clock. Every frame the browser lets this page draw passes through here, is timed, and is then handed
// to whatever wants to draw. What the-eye does from outside with ScreenCaptureKit, this does from inside with
// requestAnimationFrame: one entry per frame, the wait before it, and whether that wait was a freeze.

const KEEP = 4096; // frames remembered (a ring): 34 seconds at 120Hz
export const frames = { t: new Float64Array(KEEP), dt: new Float32Array(KEEP), n: 0 };
export const totals = { frames: 0, late: 0, worst: 0, since: performance.now() };
/** Every wait long enough to see: when it ended, how long nothing was drawn, and what was known to hold the thread. */
export const freezes = [];

const watchers = new Set();
const blocks = []; // [from, to, name] of main-thread blocks this page caused on purpose
let last = 0, skip = true, cadence = 1000 / 60;

/** Call `fn(now, dt_ms)` on every frame. Returns the function that stops it. */
export function onFrame(fn) { watchers.add(fn); return () => watchers.delete(fn); }

/** The display's refresh period as this page sees it, in ms: the median of recent waits. */
export const period = () => cadence;
export const refreshHz = () => {
  const hz = 1000 / cadence;
  // Displays come in a few rates; a median of 8.34ms is a 120Hz display, not a 119.9Hz one.
  for (const known of [240, 165, 144, 120, 90, 75, 60, 50, 30]) if (Math.abs(hz - known) / known < 0.04) return known;
  return Math.round(hz);
};

/** Tell the meter this page is about to hold the main thread itself, so a freeze can be given its cause. */
export function declareBlock(from, to, name) { blocks.push([from, to, name]); if (blocks.length > 32) blocks.shift(); }

/** Frames per second over the last `ms` milliseconds, and the longest wait in them. */
export function recent(ms, now = last) {
  let count = 0, longest = 0, late = 0, first = now;
  for (let i = 1; i <= Math.min(frames.n, KEEP); i++) {
    const k = (frames.n - i) % KEEP;
    if (now - frames.t[k] > ms) break;
    count++; first = frames.t[k] - frames.dt[k];
    if (frames.dt[k] > longest) longest = frames.dt[k];
    if (frames.dt[k] >= 1.5 * cadence) late++;
  }
  const span = now - first;
  return { fps: span > 0 ? (count * 1000) / span : 0, longest, late, count };
}

const sorted = new Float32Array(121);
function retime() {
  const n = Math.min(frames.n, 121);
  if (n < 12) return;
  for (let i = 0; i < n; i++) sorted[i] = frames.dt[(frames.n - 1 - i) % KEEP];
  const s = sorted.subarray(0, n).sort();
  cadence = s[n >> 1];
}

const SETTLE = 800;
let born;
function tick(now) {
  requestAnimationFrame(tick);
  if (skip) { skip = false; last = now; born ??= now; return; } // the first frame, or the first after the tab was hidden: no wait to time
  const dt = now - last;
  // The page's own start (modules arriving, first layout, canvases sized) is not something a visitor watched go wrong:
  // nothing is logged or judged until the page has been up for SETTLE ms. Watchers still run, so things move.
  if (now - born < SETTLE) { last = now; for (const fn of watchers) fn(now, dt); return; }
  last = now;
  const k = frames.n % KEEP;
  frames.t[k] = now; frames.dt[k] = dt; frames.n++;
  totals.frames++;
  if (dt > totals.worst) totals.worst = dt;
  if (frames.n % 30 === 0) retime();
  if (dt >= 1.5 * cadence) {
    totals.late++;
    // A freeze is a wait a person sees: three refreshes or 50ms, whichever is longer.
    if (dt >= Math.max(50, 3 * cadence)) {
      const from = now - dt, why = blocks.find(([a, b]) => b > from - 4 && a < now);
      freezes.push({ at: now, ms: dt, why: why ? { name: why[2], ms: why[1] - why[0] } : null });
    }
  }
  for (const fn of watchers) fn(now, dt);
}

document.addEventListener("visibilitychange", () => { skip = true; });
requestAnimationFrame(tick);
