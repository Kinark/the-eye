// node test/track.mjs — following the thing itself from the box of what changed between frames (src/track.ts).
// Synthetic rows, no screen: a 50pt puck sliding on a spring, a tile growing and shrinking in both dimensions, the
// sliver left by one moving edge, each with the lies a real press adds (a highlighted button somewhere else, a first
// box that swallows both, a slow tail that loses rows to the threshold).
import { springValue, fitMotion } from "../src/physics.ts";
import { track } from "../src/track.ts";

let failed = 0, checks = 0;
const want = (what, ok) => { checks++; console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
const P = 1 / 120, CELL = 1.5, q = (x) => Math.round(x / CELL) * CELL;
const row = (t, box, diff) => ({ t, s: "c", interval: 1000 * P, diff, frac: 0.01, luma: 10, x0: 0, y0: 0, x1: 0, y1: 0, w: 0, h: 0, aw: 0, ah: 0, acx: 0,
  mx0: box ? q(box[0]) : 0, mx1: box ? q(box[1]) : 0, my0: box ? q(box[2]) : 0, my1: box ? q(box[3]) : 0, mcx: 0, mcy: 0 });
const BUTTON = [300, 370, 370, 395];
const union = (a, b) => [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3])];
/** Frames of a press: the button lights up, nothing for a while, then `boxAt(i)` for every frame of the motion. */
function press(n, boxAt, diffAt, { swallow = true } = {}) {
  const rows = [row(0, BUTTON, 0.15), row(5 * P, null, 0)];
  for (let i = 1; i <= n; i++) {
    const b = boxAt(i);
    rows.push(row((6 + i) * P, b && i === 1 && swallow ? union(b, BUTTON) : b, diffAt(i) + (i === 1 && swallow ? 0.15 : 0)));
  }
  return rows;
}
const fit = (tr) => fitMotion(tr.tracks[0].samples, P, { res: CELL, minLead: tr.tracks[0].minLead });

{ // A slide: the box is where it was plus where it is.
  const w = (2 * Math.PI) / 0.45, pos = (i) => 20 + 400 * springValue(w, 0.6, (i - 0.4) * P);
  const rows = press(110, (i) => { const a = pos(i - 1), b = pos(i); return Math.abs(b - a) < 0.4 ? null : [Math.min(a, b), Math.max(a, b) + 50, 160, 210]; },
    (i) => Math.abs(pos(i) - pos(i - 1)) / 10);
  const tr = track(rows, CELL, P), f = tr.tracks.length ? fit(tr) : null;
  want("slide: followed as a position", tr.tracks[0]?.kind === "position" && !tr.twoD);
  want(`slide: starts at the first motion frame, not at the press (onset ${tr.onset})`, tr.onset === 2);
  want(`slide: ${tr.tracks[0]?.shape}`, /travelled (39\d|40\d)pt right/.test(tr.tracks[0]?.shape ?? ""));
  want(`slide: a spring, ratio ${f?.model?.zeta?.toFixed(2)} response ${f?.model?.duration?.toFixed(2)}s`,
    f?.model?.kind === "spring" && Math.abs(f.model.zeta - 0.6) < 0.06 && Math.abs(f.model.duration - 0.45) < 0.04);
}
for (const grow of [true, false]) { // A tile scaling about its centre: the box is the larger of its two outlines.
  const w = (2 * Math.PI) / 0.4, u = (i) => springValue(w, 0.7, (i - 0.4) * P);
  const sz = (i) => { const k = grow ? u(i) : 1 - u(i); return [60 + 240 * k, 40 + 100 * k]; };
  const rows = press(100, (i) => {
    const a = sz(i - 1), b = sz(i), W = Math.max(a[0], b[0]), H = Math.max(a[1], b[1]);
    return Math.abs(b[0] - a[0]) < 0.3 ? null : [260 - W / 2, 260 + W / 2, 120 - H / 2, 120 + H / 2];
  }, (i) => Math.abs(sz(i)[0] * sz(i)[1] - sz(i - 1)[0] * sz(i - 1)[1]) / 4000);
  const tr = track(rows, CELL, P), f = tr.tracks.length ? fit(tr) : null, name = grow ? "grow" : "shrink";
  want(`${name}: two-dimensional, followed as a size`, tr.twoD && tr.tracks[0]?.kind === "size");
  want(`${name}: ${tr.tracks[0]?.shape}`, (grow ? /grew (5\d|6\d)pt×(3\d|4\d)pt → (29\d|30\d)pt×1(39|4\d)pt/ : /shrank (29\d|30\d)pt×1(39|4\d)pt → (5\d|6\d)pt×(3\d|4\d)pt/).test(tr.tracks[0]?.shape ?? ""));
  want(`${name}: a spring, ratio ${f?.model?.zeta?.toFixed(2)} response ${f?.model?.duration?.toFixed(2)}s`,
    f?.model?.kind === "spring" && Math.abs(f.model.zeta - 0.7) < 0.08 && Math.abs(f.model.duration - 0.4) < 0.04);
}
{ // One moving edge (a bar closing on a lerp): the box is a sliver that thins with its speed and loses rows at the end.
  const wd = (i) => 40 + 300 * Math.pow(0.88, Math.max(0, i));
  const rows = press(70, (i) => { const a = wd(i - 1), b = wd(i), slow = a - b < 1.5; return a - b < 0.3 ? null : [20 + b, 20 + a, 282 + (slow ? 14 : 0), 342 - (slow ? 14 : 0)]; },
    (i) => (wd(i - 1) - wd(i)) / 20, { swallow: false });
  const tr = track(rows, CELL, P), f = tr.tracks.length ? fit(tr) : null;
  want("edge: one dimension, however thin the sliver gets", !tr.twoD && tr.tracks[0]?.kind === "position");
  want(`edge: a lerp, factor ${f?.model?.per_frame?.toFixed(3)}`, f?.model?.kind === "lerp" && Math.abs(f.model.per_frame - 0.12) < 0.02);
}
{ // Boxes that never follow one thing (unrelated elements changing all over): no trajectory is invented.
  const rows = press(40, (i) => { const x = (i * 97) % 400, y = (i * 53) % 300; return [x, x + 30, y, y + 20]; }, () => 0.3, { swallow: false });
  want("scattered changes: nothing followed", track(rows, CELL, P).tracks.length === 0);
  want("an old run without the columns: nothing followed", track(press(40, () => null, () => 0.3), CELL, P).tracks.length === 0);
}
{ // A dropped ball: on its last, tiny rebounds only a sliver at its upper edge still changes. It has not moved there.
  const g = 3125, e = 0.6, fall = 250, top = 60, size = 30;
  const yAt = (t) => { // distance fallen: free fall, then rebounds that each keep 0.6 of the speed
    let t0 = Math.sqrt((2 * fall) / g), v = g * t0 * e;
    if (t <= t0) return (g * t * t) / 2;
    for (let k = 0; k < 12; k++) { const T = (2 * v) / g; if (t <= t0 + T) { const u = t - t0; return fall - (v * u - (g * u * u) / 2); } t0 += T; v *= e; }
    return fall;
  };
  const rows = press(190, (i) => {
    const a = top + yAt((i - 1) * P), b = top + yAt(i * P), d = Math.abs(b - a);
    if (d < 0.05) return null;
    return d < 0.6 ? [468, 490, Math.min(a, b), Math.min(a, b) + 1.5] : [465, 495, Math.min(a, b), Math.max(a, b) + size];
  }, (i) => Math.abs(yAt(i * P) - yAt((i - 1) * P)) / 20, { swallow: false });
  const tr = track(rows, CELL, P), pos = tr.tracks.find((x) => x.kind === "position"), f = pos ? fitMotion(pos.samples, P, { res: CELL, minLead: pos.minLead }) : null;
  want(`drop: the slivers at the end do not move it (${pos?.shape})`, /travelled (24\d|25\d)pt down/.test(pos?.shape ?? ""));
  want("drop: followed as a position first", tr.tracks[0]?.kind === "position");
  want(`drop: a bounce keeping ${f?.model?.restitution?.toFixed(2)}`, f?.model?.kind === "bounce" && Math.abs(f.model.restitution - 0.6) < 0.06);
}
console.log(failed ? `\n${failed} of ${checks} FAILED` : `\nall ${checks} checks pass`);
process.exit(failed ? 1 : 0);
