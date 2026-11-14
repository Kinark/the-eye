// The eye in the hero. It is a plot, not an ornament: every tick around it is one frame this page drew, placed by
// the time it was drawn (one turn every four seconds) and as long as the wait before it. A frame that came late
// stands out in orange, and the stretch where nothing was drawn is left empty with an orange arc across it.
import { frames, freezes, onFrame, period } from "./meter.js";
import { Spring, QUICK, PLAYFUL, reduceMotion } from "./spring.js";

const KEEP = frames.t.length, TURN = 4000, TAU = Math.PI * 2;
const GREY = [128, 128, 128], ORANGE = [255, 140, 26];
const BUCKETS = 6;

export function iris(canvas) {
  const ctx = canvas.getContext("2d");
  let w = 0, h = 0, dpr = 1, visible = true;
  const size = () => {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = r.width; h = r.height;
    canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr));
  };
  new ResizeObserver(size).observe(canvas);
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; }).observe(canvas);
  size();

  // The pupil looks at the pointer, sinks and rises with the scroll, and tightens when the page is caught.
  const px = new Spring(QUICK, 0), py = new Spring(QUICK, 0), open = new Spring(PLAYFUL, 1);
  let lookX = 0, lookY = 0, scrollPush = 0, lastScroll = window.scrollY, caughtAt = -1e9, seen = 0;
  window.addEventListener("pointermove", (e) => {
    if (reduceMotion.matches) return;
    const r = canvas.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy) || 1, pull = Math.min(1, d / 420);
    lookX = (dx / d) * pull; lookY = (dy / d) * pull;
  }, { passive: true });

  const angle = (t) => ((t % TURN) / TURN) * TAU - Math.PI / 2;

  onFrame((now, dt) => {
    if (freezes.length > seen) {
      seen = freezes.length; caughtAt = now;
      if (!reduceMotion.matches) { open.x = 0.62; open.aim(1); }
    }
    if (!reduceMotion.matches) {
      // Scroll speed, in points per second, leans the gaze; it decays on its own when the scrolling stops.
      const sy = window.scrollY, speed = ((sy - lastScroll) / Math.max(dt, 1)) * 1000;
      lastScroll = sy;
      scrollPush += (Math.max(-0.7, Math.min(0.7, speed / 2600)) - scrollPush) * Math.min(1, dt / 120);
      px.aim(lookX); py.aim(Math.max(-1, Math.min(1, lookY + scrollPush)));
    }
    if (!visible || w === 0) return;

    const cad = period(), cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.27;
    const r0 = R * 1.1, base = R * 0.07, unit = R * 0.045, most = Math.min(w, h) / 2 - r0 - 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // The iris: the grey the-eye records on, washed orange for a moment when a freeze is caught.
    const wash = Math.exp(-(now - caughtAt) / 520);
    ctx.fillStyle = `rgb(${Math.round(GREY[0] + (ORANGE[0] - GREY[0]) * wash)},${Math.round(GREY[1] + (ORANGE[1] - GREY[1]) * wash)},${Math.round(GREY[2] + (ORANGE[2] - GREY[2]) * wash)})`;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();

    // The ticks, newest brightest. On-time frames are drawn in a few batches by age; late ones one by one.
    const count = Math.min(frames.n, KEEP);
    ctx.lineCap = "butt";
    for (let b = 0; b < BUCKETS; b++) {
      ctx.beginPath();
      for (let i = 1; i <= count; i++) {
        const k = (frames.n - i) % KEEP, age = now - frames.t[k];
        if (age > TURN) break;
        if (frames.dt[k] >= 1.5 * cad || Math.min(BUCKETS - 1, Math.floor((age / TURN) * BUCKETS)) !== b) continue;
        const a = angle(frames.t[k]), ca = Math.cos(a), sa = Math.sin(a);
        ctx.moveTo(cx + ca * r0, cy + sa * r0); ctx.lineTo(cx + ca * (r0 + base), cy + sa * (r0 + base));
      }
      ctx.strokeStyle = `rgba(244,244,242,${(1 - (b / BUCKETS) * 0.86).toFixed(3)})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.strokeStyle = "#FF8C1A";
    for (let i = 1; i <= count; i++) {
      const k = (frames.n - i) % KEEP, age = now - frames.t[k], wait = frames.dt[k];
      if (age > TURN) break;
      if (wait < 1.5 * cad) continue;
      const a = angle(frames.t[k]), ca = Math.cos(a), sa = Math.sin(a), len = Math.min(most, base + unit * (wait / cad));
      ctx.globalAlpha = 1 - (age / TURN) * 0.7;
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(cx + ca * r0, cy + sa * r0); ctx.lineTo(cx + ca * (r0 + len), cy + sa * (r0 + len)); ctx.stroke();
      // Nothing was drawn for this long: an arc across the empty stretch (at most one turn of it).
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, r0, a - Math.min(1, wait / TURN) * TAU, a); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // The pupil. It breathes two percent over five seconds: the one thing on the page that moves unasked.
    const breath = reduceMotion.matches ? 1 : 1 + 0.02 * Math.sin((now / 5000) * TAU);
    const pr = R * 0.4 * breath * open.x, ox = px.x * R * 0.3, oy = py.x * R * 0.3;
    ctx.fillStyle = "#0B0B0C";
    ctx.beginPath(); ctx.arc(cx + ox, cy + oy, pr, 0, TAU); ctx.fill();
    ctx.fillStyle = "#F4F4F2";
    ctx.beginPath(); ctx.arc(cx + ox - pr * 0.34, cy + oy - pr * 0.34, pr * 0.13, 0, TAU); ctx.fill();
  });
}
