// Following the thing itself. The capture reports, for every frame, the box around what changed since the frame
// before. That box is the moving object: a slide shows as the union of where it was and where it is, a shape that
// grows or shrinks shows as the larger of its two outlines, and anything that changed once and stayed (a pressed
// button, a title bar going active) is simply not in it. From those boxes this reads one clean trajectory, the
// centre for something that travelled, the size for something that grew, ready for physics.ts to fit.
import type { Row } from "./analyze.ts";
import type { Sample } from "./physics.ts";

export type Track = {
  kind: "position" | "size";
  axis: 0 | 1;
  /** samples[0] is the value at rest before the motion (see fitMotion). */
  samples: Sample[];
  /** The motion may appear up to this much later than it happened (a box spans two frames): seconds, <= 0. */
  minLead: number;
  travel: number;
  /** In words, for the report: what moved and how far. */
  shape: string;
  from: string;
};
export type Tracked = {
  /** Most travelled first. Empty when the boxes do not follow one thing. */
  tracks: Track[];
  /** Both dimensions changed size: the changed AREA (and with it the brightness) is not one curve. */
  twoD: boolean;
  /** Frames whose box was believed, of those given. */
  trusted: number;
  /** Index of the first frame of the motion itself: what came before was something else (the press landing). */
  onset: number;
  /** Everything before `onset` changed somewhere the thing never went: a prelude, not part of the motion. */
  elsewhere: boolean;
};

const pt = (x: number) => `${Math.round(x)}pt`;

/**
 * `fr`: the frames of one motion, in order, with whatever led up to it. `cell`: the capture's grid in points.
 * `period`: refresh period, seconds.
 */
export function track(fr: Row[], cell: number, period: number): Tracked {
  const none: Tracked = { tracks: [], twoD: false, trusted: 0, onset: 0, elsewhere: false };
  let m = fr, n = m.length;
  let E = m.map((r) => (r.mx1 > r.mx0 && r.my1 > r.my0 ? [r.mx0, r.mx1, r.my0, r.my1] : null));
  const present = E.map((e, i) => (e ? i : -1)).filter((i) => i >= 0);
  if (present.length < 6) return none;

  // Believe a box only if it continues the ones around it. The first frames of a press are the usual liars: the
  // button's highlight comes off in the same frame the animation starts, and the box swallows both.
  let ok = new Array<boolean>(n).fill(false);
  let p = 0;
  for (let drops = 0; drops < 4 && p + 2 < present.length; drops++) {
    const a = E[present[p]]!, b = E[present[p + 1]]!, c = E[present[p + 2]]!;
    if (a.every((v, k) => Math.abs(v - b[k]) <= 6 * cell + 4 * Math.abs(b[k] - c[k]) && Math.abs(b[k] - c[k]) <= 6 * cell + 4 * Math.abs(v - b[k]))) break;
    p++;
  }
  // (The opening check has already vouched for the step from the first box to the second. A box that was refused
  // leaves the thing moving on unseen, so the next one is allowed to be that much further away.)
  let last = E[present[p]]!, lastT = m[present[p]].t, rejected = 0, trusted = 1;
  // Each edge's speed, in points per refresh and with its sign: a real thing changes speed smoothly (and turns
  // round slowly), so the next box is expected where the last step would carry it, give or take.
  const gap = (i: number) => Math.max(1, Math.round((m[i].t - lastT) / period));
  let vel = present.length > p + 1 ? E[present[p + 1]]!.map((v, k) => (v - last[k]) / gap(present[p + 1])) : [0, 0, 0, 0];
  ok[present[p]] = true;
  for (const i of present.slice(p + 1)) {
    const e = E[i]!, g = gap(i);
    // (Judged against the speed of the whole thing: a frame the capture missed makes one edge of the box wait
    // and the other leap, since the box spans the frame before and this one.)
    const speed = Math.max(...vel.map(Math.abs));
    if (e.every((v, k) => Math.abs((v - last[k]) / g - vel[k]) <= (6 * cell + 1.5 * speed) * (1 + rejected))) {
      vel = e.map((v, k) => (v - last[k]) / g);
      last = e; lastT = m[i].t; ok[i] = true; rejected = 0; trusted++;
    } else if (++rejected >= 6 && trusted < 0.5 * present.length) return none; // it never settles into one thing
  }
  if (trusted < 6 || trusted < 0.6 * (present.length - p)) return none; // boxes that mostly do not follow on from each other are not one thing

  // The motion begins with the first believed box, or just before it with a box that swallowed it together with
  // something else. Anything earlier happened somewhere else on screen.
  let onset = ok.indexOf(true);
  {
    const f = E[onset]!;
    for (let back = 0; back < 3 && onset > 0; back++) {
      const e = E[onset - 1];
      if (!e || e[1] < f[0] || e[0] > f[1] || e[3] < f[2] || e[2] > f[3]) break;
      onset--;
    }
  }
  // Was what came before it somewhere else altogether (a button lighting up under the press), or the same thing
  // caught at a bad moment (the leap after a freeze)? Only the first is not part of the motion.
  const env = E.reduce<number[] | null>((u, e, i) => (!ok[i] || !e ? u : !u ? [...e] : [Math.min(u[0], e[0]), Math.max(u[1], e[1]), Math.min(u[2], e[2]), Math.max(u[3], e[3])]), null)!;
  const elsewhere = onset > 0 && E.slice(0, onset).every((e) => !e || e[1] <= env[0] || e[0] >= env[1] || e[3] <= env[2] || e[2] >= env[3]);
  m = m.slice(onset); E = E.slice(onset); ok = ok.slice(onset); n = m.length;
  const size = (e: number[], ax: number) => e[2 * ax + 1] - e[2 * ax], mid = (e: number[], ax: number) => (e[2 * ax] + e[2 * ax + 1]) / 2;
  // A rigid thing that has all but stopped changes only along one edge: the box shrinks to a sliver there, and its
  // centre would jump from the thing's middle to that edge. Such a box says the thing is still where it was, nothing
  // more. Rigid = the box, less the step it took, is one size throughout, and above all while it is fastest: the box
  // of a travelling thing is the thing plus its step. (A thing that grows is at its fastest while still small; the
  // strip behind a moving edge is all step and no thing. Both are left alone.)
  {
    const idx = ok.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    // Only along the way it travels: across it, a box loses rows to the threshold as it slows and still sits right.
    const reach = [0, 1].map((ax) => { const c = idx.map((i) => mid(E[i]!, ax)); return Math.max(...c) - Math.min(...c); });
    const ax = reach[1] > reach[0] ? 1 : 0;
    const steps = idx.slice(1).map((i, k) => ({ i, step: Math.abs(mid(E[i]!, ax) - mid(E[idx[k]]!, ax)), body: 0 })).filter((x, k) => x.i === idx[k] + 1);
    for (const x of steps) x.body = size(E[x.i]!, ax) - x.step;
    if (steps.length >= 6) {
      const bodies = steps.map((x) => x.body).sort((p, q) => p - q), S = bodies[bodies.length >> 1];
      const same = (v: number) => Math.abs(v - S) <= Math.max(3 * cell, 0.25 * S);
      const fastest = [...steps].sort((p, q) => q.step - p.step).slice(0, 3);
      if (S >= 4 * cell && bodies.filter(same).length >= 0.6 * bodies.length && fastest.every((x) => same(x.body))) {
        const keep = ok.map((v, i) => v && size(E[i]!, ax) >= 0.6 * S);
        if (keep.filter(Boolean).length >= 6) ok = keep;
      }
    }
  }
  const first = ok.indexOf(true), end = ok.lastIndexOf(true);
  const dSize = [0, 1].map((ax) => size(E[end]!, ax) - size(E[first]!, ax));
  const dMid = [0, 1].map((ax) => mid(E[end]!, ax) - mid(E[first]!, ax));
  // Two-dimensional only if both sizes changed while it was still properly moving: in the slow tail a box loses
  // rows and columns to the threshold, and the sliver left by a single moving edge thins out with its speed.
  const peak = Math.max(...m.map((r) => r.diff));
  let fast = first;
  for (let i = first; i <= end; i++) if (ok[i] && m[i].diff >= 0.1 * peak) fast = i;
  const dFast = [0, 1].map((ax) => Math.abs(size(E[fast]!, ax) - size(E[first]!, ax)));
  const twoD = Math.min(dFast[0], dFast[1]) >= Math.max(6 * cell, 0.15 * Math.max(dFast[0], dFast[1]));

  const d = m.map((r) => r.diff);
  /** Fill what the trusted boxes leave open: reckon back to rest from the amount of change, hold through gaps. */
  const build = (kind: Track["kind"], ax: 0 | 1): Track | null => {
    const y: number[] = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (ok[i]) y[i] = kind === "size" ? size(E[i]!, ax) : mid(E[i]!, ax);
    const net = y[end] - y[first], dir = Math.sign(net);
    if (Math.abs(net) < 8 * cell) return null;
    // Points travelled per unit of frame-to-frame change, from the first trusted stretch.
    let num = 0, den = 0;
    for (let i = first + 1, pairs = 0; i < n && pairs < 4; i++) {
      if (!ok[i] || !ok[i - 1]) continue;
      num += Math.abs(y[i] - y[i - 1]);
      den += kind === "position" ? (d[i - 1] + d[i]) / 2 : d[i];
      pairs++;
    }
    const k = den > 0 ? num / den : 0;
    let vals: number[], times: number[], rest: number;
    if (kind === "position") {
      // The box's centre is the thing's centre half way between the two frames it spans.
      for (let i = first - 1; i >= 0; i--) y[i] = y[i + 1] - dir * k * (d[i] + d[i + 1]) / 2;
      rest = y[0] - dir * k * d[0] / 2;
      for (let i = 1; i < n; i++) if (Number.isNaN(y[i])) y[i] = y[i - 1];
      vals = y; times = m.map((r) => r.t);
    } else if (dir > 0) {
      // Growing: the box is the outline it has now.
      for (let i = first - 1; i >= 0; i--) y[i] = y[i + 1] - k * d[i + 1];
      rest = y[0] - k * d[0];
      for (let i = 1; i < n; i++) if (Number.isNaN(y[i])) y[i] = y[i - 1];
      vals = y; times = m.map((r) => r.t);
    } else {
      // Shrinking: the box is the outline it had one frame ago, so the first box is the thing at rest.
      for (let i = first - 1; i >= 0; i--) y[i] = y[i + 1] + k * d[i];
      for (let i = 1; i < n; i++) if (Number.isNaN(y[i])) y[i] = y[i - 1];
      rest = y[0];
      vals = [...y.slice(1), y[n - 1]]; times = m.map((r) => r.t);
    }
    const samples = [{ t: times[0] - period, x: rest }, ...vals.map((x, i) => ({ t: times[i], x }))];
    const settled = vals[vals.length - 1];
    let shape: string;
    if (kind === "position") {
      const way = ax === 0 ? (dir > 0 ? "right" : "left") : dir > 0 ? "down" : "up";
      shape = `travelled ${pt(Math.abs(settled - rest))} ${way}`;
    } else {
      const o = 1 - ax, e0 = E[first]!, e1 = E[end]!;
      // The other dimension, as far as the boxes show it (it changed too only when the motion is two-dimensional).
      const other = twoD ? [size(e0, o), size(e1, o)] : null;
      const wh = (a: number, b: number) => (ax === 0 ? `${pt(a)}×${pt(b)}` : `${pt(b)}×${pt(a)}`);
      shape = other ? `${dir > 0 ? "grew" : "shrank"} ${wh(rest, other[0])} → ${wh(settled, other[1])}`
        : `${ax === 0 ? "width" : "height"} ${pt(rest)}→${pt(settled)}`;
    }
    return { kind, axis: ax, samples, minLead: kind === "position" ? -period / 2 : 0, travel: Math.abs(settled - rest), shape,
      from: kind === "position" ? "the position of what moved, frame by frame" : `the ${ax === 0 ? "width" : "height"} of what moved, frame by frame` };
  };

  const tracks = [
    build("size", Math.abs(dSize[1]) > Math.abs(dSize[0]) ? 1 : 0),
    build("position", Math.abs(dMid[1]) > Math.abs(dMid[0]) ? 1 : 0),
  ].filter((t): t is Track => !!t).sort((a, b) => b.travel - a.travel);
  return { tracks, twoD, trusted, onset, elsewhere };
}

/** Pearson correlation of two equally long series (0 when either is flat). */
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n, mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}
