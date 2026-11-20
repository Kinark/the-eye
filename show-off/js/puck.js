// Fling it: a puck moved by an engine you choose, logged once per frame, then read back by the-eye's own fitter.
// /lib/physics.js is src/physics.ts with its types stripped: the same springValue() draws the motion here that the
// fitter uses to recognise it, and the fit itself runs in a worker so it cannot cost this page a frame.
import { onFrame, period } from "./meter.js";
import { springValue, bezierValue } from "/lib/physics.js";
import { Spring, QUICK, reduceMotion } from "./spring.js";
import { gaze } from "./witness.js";

const $ = (id) => document.getElementById(id);
const PAD = 36, SIZE = 88, REST_FRAMES = 10;

export function puck() {
  const stage = document.querySelector(".fit-stage"), el = $("puck"), trail = $("trail"), note = $("fit-note");
  const form = $("engine"), declared = $("declared"), fitted = $("fitted"), send = $("send");
  const ctx = trail.getContext("2d");
  const worker = new Worker("/js/fit-worker.js", { type: "module" });

  let lo = PAD, hi = 600, x = PAD, w = 0, h = 0, dpr = 1;
  let held = null;   // { dx, pts: [[t, x] …] } while a pointer has it
  let flight = null; // { from, to, t0, v0, eng, samples, rest, cur, ticks }
  let asked = 0;

  // The puck has some give: it rises 6% into the hand and stretches along its travel with its speed, about its own
  // centre, so the place the ticks and the fitter read is not moved by it.
  let sx = 1, sy = 1, wasX = PAD;
  const place = () => { el.style.transform = `translate3d(${x.toFixed(2)}px,0,0) scale(${sx.toFixed(4)},${sy.toFixed(4)})`; };
  const shape = () => { sx = lift.x * (1 + stretch.x); sy = lift.x * (1 - stretch.x * 0.5); place(); };
  const lift = new Spring(QUICK, 1, shape), stretch = new Spring(QUICK, 0, shape);
  onFrame((_, dt) => {
    const want = reduceMotion.matches ? 0 : Math.min(0.14, (Math.abs(x - wasX) / Math.max(dt, 1)) * 1000 / 16000);
    wasX = x;
    if (Math.abs(want - stretch.to) > 0.002 || (want === 0 && stretch.to !== 0)) stretch.aim(want);
  });
  // While the puck is in the hand or in flight, it is what the eyes watch.
  const eyeOn = () => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const watched = (on) => { if (on) gaze.at = eyeOn; else if (gaze.at === eyeOn) gaze.at = null; };
  const wipe = () => ctx.clearRect(0, 0, w, h);
  const size = () => {
    const atHi = Math.abs(x - hi) < 1;
    w = stage.clientWidth; h = stage.clientHeight; dpr = Math.min(devicePixelRatio || 1, 2);
    trail.width = Math.round(w * dpr); trail.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hi = Math.max(lo + 60, w - PAD - SIZE);
    if (!flight && !held) { x = atHi ? hi : Math.min(x, hi); place(); }
  };
  new ResizeObserver(size).observe(stage);
  size();
  note.textContent = "Drag the puck, then let go.";

  // ---- what the code declares -----------------------------------------------------------------------------------
  const num = (id) => Number($(id).value);
  const engine = () => {
    const kind = new FormData(form).get("engine");
    if (kind === "spring") return { kind, k: num("p-k"), c: num("p-c") };
    if (kind === "curve") return { kind, d: num("p-d"), p: $("p-curve").value.split(",").map(Number), name: $("p-curve").selectedOptions[0].textContent };
    return { kind, f: num("p-f") };
  };
  const describe = (e, v0 = 0) => {
    if (e.kind === "spring") {
      const zeta = e.c / (2 * Math.sqrt(e.k));
      return `a spring: stiffness ${e.k}, damping ${e.c} at mass 1 (damping ratio ${zeta.toFixed(2)})${Math.abs(v0) > 40 ? `, let go at ${Math.round(Math.abs(v0))}pt/s` : ""}`;
    }
    if (e.kind === "curve") return `a timing curve: ${e.name} = cubic-bezier(${e.p.join(", ")}) over ${e.d.toFixed(2)}s`;
    return `a per-frame lerp: x += (target - x) × ${e.f.toFixed(2)} each frame`;
  };
  const refresh = () => {
    const e = engine();
    for (const box of form.querySelectorAll(".params")) box.hidden = box.dataset.for !== e.kind;
    for (const out of form.querySelectorAll("output")) {
      const input = $(out.htmlFor[0]);
      out.textContent = input.id === "p-d" ? `${Number(input.value).toFixed(2)}s` : input.value;
    }
    if (!flight) declared.textContent = describe(e);
  };
  form.addEventListener("input", refresh);
  form.addEventListener("submit", (e) => e.preventDefault());
  refresh();

  // ---- flying ----------------------------------------------------------------------------------------------------
  function launch(to, v0) {
    if (Math.abs(to - x) < 12) { note.textContent = "Too short a trip to read. Fling it across."; flight = null; watched(false); return; }
    watched(true);
    const eng = engine(), now = performance.now();
    flight = { from: x, to, t0: now, v0, eng, samples: [{ t: now / 1000, x }], rest: 0, cur: x, done: false };
    declared.textContent = describe(eng, eng.kind === "spring" ? v0 : 0);
    wipe();
    note.textContent = "";
  }

  function land() {
    const f = flight;
    flight = null;
    watched(false);
    x = f.to; place();
    note.textContent = `${f.samples.length - 1} frames. Each tick is where the puck was on one of them${f.late ? `; the ${f.late === 1 ? "orange one came" : `${f.late} orange ones came`} late` : ""}.`;
    fitted.replaceChildren(Object.assign(document.createElement("p"), { className: "dim", textContent: "reading the frames" }));
    worker.postMessage({ id: ++asked, samples: f.samples, period: period() / 1000 });
  }

  worker.onmessage = ({ data }) => {
    if (data.id !== asked) return; // an older flight: a newer one is already being read
    const p = (text, cls) => Object.assign(document.createElement("p"), { textContent: text, className: cls ?? "" });
    const out = data.lines
      ? data.lines.map((l, i) => p(l, i === 0 ? "head" : ""))
      : [p("nothing to read: the trip was over in a frame or two, so there is no curve in it", "head")];
    out.push(p(`  fitted off the main thread in ${data.ms < 10 ? data.ms.toFixed(1) : Math.round(data.ms)}ms, from ${data.frames} frames`, "dim"));
    fitted.replaceChildren(...out);
  };
  worker.onerror = () => { fitted.textContent = "The fitter did not load. Is the page served by bun run show-off?"; };

  onFrame((now, dt) => {
    const f = flight;
    if (!f) return;
    const t = (now - f.t0) / 1000, travel = f.to - f.from, e = f.eng;
    if (!f.done) {
      if (e.kind === "spring") {
        const omega = Math.sqrt(e.k), zeta = e.c / (2 * omega), u = springValue(omega, zeta, t, f.v0 / travel);
        const before = f.cur;
        f.cur = f.from + travel * u;
        // Settled: within a quarter point of home and no longer moving a tenth of a point per frame.
        if (t > 0.1 && Math.abs(f.cur - f.to) < 0.25 && Math.abs(f.cur - before) < 0.1) f.done = true;
      } else if (e.kind === "curve") {
        const p = Math.min(1, t / e.d);
        f.cur = f.from + travel * bezierValue(e.p[0], e.p[1], e.p[2], e.p[3], p);
        if (p >= 1) f.done = true;
      } else {
        f.cur += (f.to - f.cur) * e.f;
        if (Math.abs(f.to - f.cur) < 0.25) f.done = true;
      }
      if (f.done) f.cur = f.to;
      // One tick per frame, under the puck's centre: their spacing is its speed.
      // A frame that came late is caught here too: its tick is orange and taller, after the gap it left.
      const late = dt >= 1.5 * period();
      if (late) f.late = (f.late ?? 0) + 1;
      ctx.fillStyle = late ? "#FF8C1A" : "rgba(11, 11, 12, 0.6)";
      ctx.fillRect(Math.round(f.cur + SIZE / 2) - 1, h / 2 + SIZE / 2 + 14, late ? 3 : 2, late ? 24 : 14);
    } else if (++f.rest >= REST_FRAMES) {
      f.samples.push({ t: now / 1000, x: f.cur });
      land();
      return;
    }
    x = f.cur; place();
    f.samples.push({ t: now / 1000, x: f.cur });
  });

  // ---- in the hand -----------------------------------------------------------------------------------------------
  const rubber = (raw) => (raw < lo ? lo - (lo - raw) * 0.35 : raw > hi ? hi + (raw - hi) * 0.35 : raw);
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    flight = null; // grabbed mid-flight: it stops being the engine's and becomes the hand's, from where it is
    held = { dx: e.clientX - el.getBoundingClientRect().left, pts: [[e.timeStamp, x]] };
    el.classList.add("held");
    watched(true);
    if (!reduceMotion.matches) lift.aim(1.06);
    wipe();
    note.textContent = "";
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (!held) return;
    x = rubber(e.clientX - stage.getBoundingClientRect().left - held.dx);
    place();
    held.pts.push([e.timeStamp, x]);
    if (held.pts.length > 12) held.pts.shift();
  });
  const release = (e) => {
    if (!held) return;
    // Speed over the last 80ms of the drag, in points per second: the hand's, handed to the engine.
    const pts = held.pts, lastT = pts[pts.length - 1][0], first = pts.find(([t]) => lastT - t <= 80) ?? pts[0];
    const span = (lastT - first[0]) / 1000, still = e.timeStamp - lastT > 60;
    const v = span > 0.008 && !still ? (pts[pts.length - 1][1] - first[1]) / span : 0;
    held = null;
    el.classList.remove("held");
    lift.aim(1);
    const mid = (lo + hi) / 2, to = v > 300 ? hi : v < -300 ? lo : x > mid ? hi : lo;
    x = Math.min(Math.max(x, lo - 200), hi + 200);
    launch(to, v);
    if (!flight) { // too close to its dock to be a trip: just put it back
      launch(to === hi ? lo : hi, v);
    }
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);

  send.addEventListener("click", () => {
    if (held) return;
    let v = 0;
    if (flight) { // sent again mid-flight: it turns round from where it is, at the speed it has
      const s = flight.samples, n = s.length;
      if (n >= 3) v = (s[n - 1].x - s[n - 2].x) / Math.max(1e-3, s[n - 1].t - s[n - 2].t);
      x = flight.cur;
      const to = flight.to === hi ? lo : hi;
      flight = null;
      launch(to, v);
      return;
    }
    launch(x > (lo + hi) / 2 ? lo : hi, 0);
  });
}
