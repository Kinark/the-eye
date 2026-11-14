// Drawing for the replayed recording: the stage (what changed on screen) and the timeline (what the system did).
/** The part of the recorded region shown, in the recording's points. */
export const VIEW = { x: 257, y: -14, w: 1000, h: 250 };
/** The motion as the report bounds it; counts over this window equal the report's own. */
export const MOTION = [2.455, 4.275];
const ROW = 40, WHITE = "244, 244, 242", ORANGE = "255, 140, 26";

/** Size a canvas's backing store to its CSS box and the display's density; returns a context in CSS pixels. */
export function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  const c = canvas.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  return { c, w, h };
}

/** The measured extent of what changed, for one frame `f` = [t, x, y, w, h], with the resting extent ghosted. */
export function drawStage(canvas, f, rest) {
  const { c, w, h } = fit(canvas);
  const s = w / VIEW.w, oy = (h - VIEW.h * s) / 2;
  const box = (b) => [(b[1] - VIEW.x) * s, (b[2] - VIEW.y) * s + oy, b[3] * s, b[4] * s];
  c.strokeStyle = "rgba(11, 11, 12, 0.28)";
  c.lineWidth = 1;
  c.setLineDash([4, 5]);
  const g = box(rest);
  c.strokeRect(Math.round(g[0]) + 0.5, Math.round(g[1]) + 0.5, Math.round(g[2]), Math.round(g[3]));
  c.setLineDash([]);
  if (f[3] > 0) { c.fillStyle = `rgb(${WHITE})`; c.fillRect(...box(f)); }
}

/** Four rows of ticks (commits, frames, frames that carried the app's change, update cycles) and the playhead. */
export function drawTimeline(canvas, data, t) {
  const { c, w, h } = fit(canvas);
  const X = (time) => ((time - data.from) / (data.to - data.from)) * w;
  c.fillStyle = "#161618";
  c.fillRect(X(MOTION[0]), 0, X(MOTION[1]) - X(MOTION[0]), h);
  const tick = (row, time, len, rgb) => {
    c.fillStyle = `rgba(${rgb}, ${time <= t ? 1 : 0.24})`;
    c.fillRect(Math.round(X(time)), row * ROW + (ROW - len) / 2, 1, len);
  };
  const tall = (ms) => 8 + Math.min(24, ms * 0.45);
  for (const [time, ms] of data.commits) tick(0, time, tall(ms), WHITE);
  for (const time of data.swaps) tick(1, time, 14, WHITE);
  for (const i of data.carried) tick(2, data.swaps[i], 14, WHITE);
  for (const [time, ms, stall] of data.cycles) tick(3, time, tall(ms), stall ? ORANGE : WHITE);
  c.fillStyle = `rgb(${WHITE})`;
  c.fillRect(Math.min(w - 2, Math.max(0, Math.round(X(t)) - 1)), 0, 2, h);
}
