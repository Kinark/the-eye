// The reflex layer: given how one number moved over time (an edge, a size, a brightness), work out WHAT moved it.
// A person watching a thing settle knows at once whether it is springy, heavy or mechanical without doing any
// maths; this does the maths so the reader of a report gets the same answer for free: the model that produced the
// motion (a spring, a timing curve, a per-frame lerp), its parameters in the units the code was written in
// (SwiftUI duration/bounce, stiffness/damping, cubic-bezier control points), and how sure the data lets us be.
//
// Everything is fitted in normalised form: u = 0 at rest before, u = 1 at the value it settled on.

export type Sample = { t: number; x: number };

export type SpringFit = { kind: "spring"; omega: number; zeta: number; v0: number; duration: number; bounce: number; stiffness: number; damping: number };
export type CurveFit = { kind: "curve"; p: [number, number, number, number]; duration: number; preset?: string };
export type LerpFit = { kind: "lerp"; rate: number; half_life_ms: number; per_frame: number; /** It advanced once per delivered frame rather than with the clock. */ by_frame?: boolean };
/** Dropped and bouncing: `gravity` in travels per second², `restitution` the share of its speed each rebound keeps. */
export type BounceFit = { kind: "bounce"; gravity: number; restitution: number; first_hit_ms: number; rebounds: number };
export type Model = SpringFit | CurveFit | LerpFit | BounceFit;

export type MotionFit = {
  /** Best model, or null when nothing simple reproduces the motion. */
  model: Model | null;
  /** Residual of the best model, as a fraction of the distance travelled. */
  rms: number;
  /** The other family when it explains the frames about as well: the data cannot tell them apart. */
  also?: Model;
  /** What the motion measurably did, whatever produced it. */
  travel: number; overshoot: number; overshoot_pct: number; settle_ms: number; peak_speed: number; peak_at_pct: number; oscillations: number;
  /** How much to trust it: frames used, and why it may be soft. */
  frames: number; caveat?: string;
};

// ---- models ---------------------------------------------------------------------------------------------------------

/** Unit step response of a damped spring (mass 1) started at 0 with velocity v0, heading for 1. */
export function springValue(omega: number, zeta: number, t: number, v0 = 0): number {
  if (t <= 0) return 0;
  if (zeta < 0.9999) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega - v0) / wd) * Math.sin(wd * t));
  }
  if (zeta < 1.0001) return 1 - Math.exp(-omega * t) * (1 + (omega - v0) * t);
  const s = omega * Math.sqrt(zeta * zeta - 1), r1 = -zeta * omega + s, r2 = -zeta * omega - s;
  // u = 1 + A e^{r1 t} + B e^{r2 t}, u(0) = 0, u'(0) = v0
  const B = (v0 + r1) / (r2 - r1), A = -1 - B;
  return 1 + A * Math.exp(r1 * t) + B * Math.exp(r2 * t);
}

/** CSS / CAMediaTimingFunction cubic-bezier: progress p in 0…1 -> eased value. */
export function bezierValue(x1: number, y1: number, x2: number, y2: number, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const bx = (s: number) => 3 * x1 * s * (1 - s) * (1 - s) + 3 * x2 * s * s * (1 - s) + s * s * s;
  let lo = 0, hi = 1, s = p;
  for (let i = 0; i < 8; i++) { // Newton, falling back to bisection when the slope is flat
    const e = bx(s) - p;
    if (Math.abs(e) < 1e-7) break;
    const d = 3 * x1 * (1 - s) * (1 - 3 * s) + 3 * x2 * s * (2 - 3 * s) + 3 * s * s;
    if (e > 0) hi = s; else lo = s;
    const n = Math.abs(d) > 1e-6 ? s - e / d : -1;
    s = n > lo && n < hi ? n : (lo + hi) / 2;
  }
  return 3 * y1 * s * (1 - s) * (1 - s) + 3 * y2 * s * s * (1 - s) + s * s * s;
}

/**
 * A thing let go at 0 that falls to 1 under constant acceleration `g` and rebounds off it, keeping `e` of its speed
 * at each hit: parabolas that never pass the target, each one e² as deep and e as long as the one before.
 */
export function bounceValue(g: number, e: number, t: number): number {
  if (t <= 0) return 0;
  const t1 = Math.sqrt(2 / g);
  if (t < t1) return 0.5 * g * t * t;
  t -= t1;
  for (let v = g * t1 * e, i = 0; i < 40; i++, v *= e) {
    const flight = (2 * v) / g;
    if (flight < 1e-4) break;
    if (t < flight) return 1 - (v * t - 0.5 * g * t * t);
    t -= flight;
  }
  return 1;
}

/** Timing curves people actually ship, so a fitted curve can be called by its name. */
export const CURVES: [string, [number, number, number, number]][] = [
  ["linear", [0, 0, 1, 1]],
  ["easeInOut (SwiftUI .easeInOut, CSS ease-in-out)", [0.42, 0, 0.58, 1]],
  ["easeOut (SwiftUI .easeOut, CSS ease-out)", [0, 0, 0.58, 1]],
  ["easeIn (SwiftUI .easeIn, CSS ease-in)", [0.42, 0, 1, 1]],
  ["CA default / CSS ease", [0.25, 0.1, 0.25, 1]],
  ["quadratic ease-out, 1-(1-t)^2", [1 / 3, 2 / 3, 2 / 3, 1]],
  ["cubic ease-out, 1-(1-t)^3", [1 / 3, 1, 2 / 3, 1]],
  ["quadratic ease-in, t^2", [1 / 3, 0, 2 / 3, 1 / 3]],
  ["cubic ease-in, t^3", [1 / 3, 0, 2 / 3, 0]],
  ["Material standard", [0.2, 0, 0, 1]],
  ["Material emphasized-decelerate", [0.05, 0.7, 0.1, 1]],
];

/** SwiftUI's named springs (Spring.smooth/.snappy/.bouncy: bounce 0 / 0.15 / 0.3; read from the macOS SDK interface). */
const SPRING_NAMES: [string, number][] = [["smooth", 0], ["snappy", 0.15], ["bouncy", 0.3]];

// ---- optimiser ------------------------------------------------------------------------------------------------------

/** Nelder–Mead: small, derivative-free, and good enough for 2–6 smooth parameters started from a sane guess. */
function minimise(f: (p: number[]) => number, start: number[], step: number[], iters = 400): { p: number[]; f: number } {
  const n = start.length;
  let S = [start, ...start.map((_, i) => start.map((v, j) => (i === j ? v + step[j] : v)))].map((p) => ({ p, f: f(p) }));
  for (let it = 0; it < iters; it++) {
    S.sort((a, b) => a.f - b.f);
    if (S[n].f - S[0].f < 1e-12) break;
    const c = start.map((_, j) => S.slice(0, n).reduce((s, v) => s + v.p[j], 0) / n);
    const at = (k: number) => { const p = c.map((v, j) => v + k * (S[n].p[j] - v)); return { p, f: f(p) }; };
    const r = at(-1);
    if (r.f < S[0].f) { const e = at(-2); S[n] = e.f < r.f ? e : r; }
    else if (r.f < S[n - 1].f) S[n] = r;
    else {
      const k = at(r.f < S[n].f ? -0.5 : 0.5);
      if (k.f < Math.min(r.f, S[n].f)) S[n] = k;
      else S = S.map((v, i) => { if (i === 0) return v; const p = v.p.map((x, j) => S[0].p[j] + 0.5 * (x - S[0].p[j])); return { p, f: f(p) }; });
    }
  }
  S.sort((a, b) => a.f - b.f);
  return S[0];
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ---- fitting --------------------------------------------------------------------------------------------------------

/**
 * `samples[0]` is the value at rest just before the motion; the rest are the frames of the motion, in order.
 * `period` is the display's refresh period in seconds (the motion began at most ~1.5 of them before samples[1]).
 * `cut`: the recording ended while it was still moving, so where it was heading is unknown.
 * `res`: the smallest step the measurement can show, in the samples' own unit (default half a point).
 * `minLead`: the measurement shows the motion this much late (seconds, <= 0), e.g. a box that spans two frames.
 */
export function fitMotion(samples: Sample[], period: number, o: { cut?: boolean; res?: number; minLead?: number } = {}): MotionFit | null {
  if (samples.length < 7) return null;
  const x0 = samples[0].x, n = samples.length;
  const target = samples[n - 1].x; // where the picture stopped changing
  const travel = target - x0;
  const res = o.res ?? 0.5;
  if (Math.abs(travel) < 8 * res) return null;
  const T = samples.slice(1).map((s) => s.t - samples[1].t); // seconds since the first moving frame
  const U = samples.slice(1).map((s) => (s.x - x0) / travel);
  const total = T[T.length - 1];
  if (total <= 0) return null;

  // What it measurably did.
  const peakU = Math.max(...U), overshoot = Math.max(0, peakU - 1);
  const tol = Math.max(0.01, (1.5 * res) / Math.abs(travel));
  // Something that got there in a frame or two was not animated: there is no curve to read.
  if (U.filter((u) => u > 0.05 && u < 0.95).length < 5) return null;
  // Close to half the way in a single frame: the in-between positions were never shown (a blocked main thread, a run
  // of dropped frames, a value simply set). A flexible curve can still be threaded through what is left of it, and
  // would mean nothing.
  let leap = Math.abs(U[0]);
  for (let i = 1; i < U.length; i++) leap = Math.max(leap, Math.abs(U[i] - U[i - 1]));
  let settleIdx = 0;
  for (let i = U.length - 1; i >= 0; i--) if (Math.abs(U[i] - 1) > tol) { settleIdx = Math.min(U.length - 1, i + 1); break; }
  let peakSpeed = 0, peakAt = 0, crossings = 0;
  for (let i = 1; i < U.length; i++) {
    const v = Math.abs((U[i] - U[i - 1]) * travel) / Math.max(1e-4, T[i] - T[i - 1]);
    if (v > peakSpeed) { peakSpeed = v; peakAt = (T[i] + T[i - 1]) / 2; }
    if ((U[i] - 1) * (U[i - 1] - 1) < 0 && Math.abs(U[i] - U[i - 1]) * Math.abs(travel) >= 2 * res) crossings++;
  }
  const settled = !o.cut;
  const facts = {
    travel, overshoot: overshoot * Math.abs(travel), overshoot_pct: 100 * overshoot,
    settle_ms: 1000 * (T[settleIdx] + period), peak_speed: peakSpeed, peak_at_pct: 100 * clamp(peakAt / Math.max(1e-6, T[settleIdx] || total), 0, 1),
    oscillations: crossings, frames: n - 1,
  };

  // The motion started somewhere in the refresh before its first visible frame: lead = that head start, in seconds.
  const maxLead = 1.5 * period, minLead = Math.min(0, o.minLead ?? 0);
  const rest = o.cut ? 0 : Math.round(Math.min(0.3, 0.6 * total) / period);
  const cost = (model: (t: number) => number, lead: number) => {
    let s = 0;
    for (let i = 0; i < U.length; i++) { const e = model(T[i] + lead) - U[i]; s += e * e; }
    // It then stayed where it stopped (the motion ended because nothing changed any more): a model that would go
    // on moving after the last frame, an overshoot still to come, is wrong about frames nobody had to record.
    for (let j = 1; j <= rest; j++) { const e = model(total + j * period + lead) - 1; s += e * e; }
    return s / (U.length + rest);
  };
  const big = 1e6;
  // What the measurement itself cannot resolve: half a point of position, and a fraction of a refresh in time.
  const noise = Math.max(0.004, (0.9 * res) / Math.abs(travel));

  // Seeds: a critically damped spring is half way at omega*t ≈ 1.68.
  const half = U.findIndex((u) => u >= 0.5), t50 = Math.max(period, (half < 0 ? total / 2 : T[half]) + period / 2);
  const w0 = 1.68 / t50;

  // Spring: omega, zeta, lead (+ v0 only if it earns its place).
  const springCost = (p: number[], withV: boolean) => {
    const [w, z, lead, v0] = p;
    // (A spring that would need far longer than the motion lasted to do anything is a straight line in disguise.)
    if (w < 1 || w > 400 || w * (total + lead) < 2.5 || z < 0.03 || z > 4 || lead < minLead || lead > maxLead) return big;
    if (withV && Math.abs(v0) > 60) return big;
    // It came to rest inside these frames. A spring whose overshoot would only come after them is tracing the rise
    // with a bounce it keeps out of sight: the thing on screen did not go on to do that.
    if (!withV && settled && z < 1) {
      const tPeak = Math.PI / (w * Math.sqrt(1 - z * z));
      if (tPeak > total + lead && Math.exp(-z * w * tPeak) > overshoot + Math.max(0.03, 2 * noise)) return big;
    }
    return cost((t) => springValue(w, z, t, withV ? v0 : 0), lead);
  };
  let spring = { p: [w0, 1, period / 2, 0], f: big };
  for (const z of [0.25, 0.5, 0.75, 1, 1.5]) for (const k of [0.6, 1, 1.6]) {
    const r = minimise((p) => springCost(p, false), [w0 * k, z, period / 2], [w0 * 0.3, 0.15, period / 3]);
    if (r.f < spring.f) spring = { p: [...r.p, 0], f: r.f };
  }
  {
    const r = minimise((p) => springCost(p, true), spring.p, [spring.p[0] * 0.2, 0.1, period / 3, 2], 600);
    // A velocity it started with (a flick, a retarget) must explain a lot more to be believed.
    if (Math.sqrt(spring.f) > noise && r.f < 0.45 * spring.f && Math.abs(r.p[3]) > 0.2 * r.p[0]) spring = r;
  }

  // Timing curve: the named ones with only duration + lead free, then a free cubic-bezier.
  const dur0 = Math.max(2 * period, T[settleIdx] + period);
  const curveLead = Math.max(maxLead, 0.15 * total); // an ease-in spends its first frames below one point: unseen
  const curveCost = (c: number[], D: number, lead: number) => {
    if (D < 2 * period || D > 20 || lead < minLead || lead > curveLead || c[0] < 0 || c[0] > 1 || c[2] < 0 || c[2] > 1 || Math.abs(c[1] - 0.5) > 1.5 || Math.abs(c[3] - 0.5) > 1.5) return big;
    return cost((t) => bezierValue(c[0], c[1], c[2], c[3], t / D), lead);
  };
  let named = { name: "", c: CURVES[0][1], D: dur0, f: big };
  for (const [name, c] of CURVES) {
    const r = minimise((p) => curveCost(c, p[0], p[1]), [dur0, period / 2], [dur0 * 0.15, period / 3], 200);
    if (r.f < named.f) named = { name, c, D: r.p[0], f: r.f };
  }
  let free = { p: [...named.c, named.D, period / 2], f: named.f };
  for (const seed of [named.c, [0.3, 0.3, 0.6, 1], [0.2, 0, 0.2, 1]]) {
    const r = minimise((p) => curveCost(p, p[4], p[5]), [...seed, named.D, period / 2], [0.1, 0.1, 0.1, 0.1, named.D * 0.1, period / 3], 700);
    if (r.f < free.f) free = r;
  }

  // Per-frame lerp (x += (target - x) * k every frame): an exponential approach, the classic hand-rolled easing.
  const lerp = minimise((p) => (p[0] < 0.5 || p[0] > 400 || p[1] < minLead || p[1] > maxLead ? big : cost((t) => 1 - Math.exp(-p[0] * t), p[1])),
    [Math.LN2 / t50, period / 2], [0.3 * Math.LN2 / t50, period / 3], 200);

  // The same lerp counted in frames instead of seconds. Code that steps once per callback does not know how long
  // a frame took: when frames drop it simply falls behind, which no curve over time reproduces and this one does.
  const lerpN = minimise((p) => {
    if (p[0] < 0.5 || p[0] > 400 || p[1] < minLead || p[1] > maxLead) return big;
    let e2 = 0;
    for (let i = 0; i < U.length; i++) { const e = 1 - Math.exp(-p[0] * (i * period + p[1])) - U[i]; e2 += e * e; }
    return e2 / U.length;
  }, [Math.LN2 / t50, period / 2], [0.3 * Math.LN2 / t50, period / 3], 200);
  const byFrame = lerpN.f < 0.5 * lerp.f && T[T.length - 1] > 1.04 * (U.length - 1) * period;
  if (byFrame) { lerp.p = lerpN.p; lerp.f = lerpN.f; }

  // A bounce: it reaches the target, comes back off it and never passes it. Only tried when the frames show that,
  // because nothing else does it (a spring crosses its target, a curve does not come back).
  // The first landing is where it first turns back (a landing between two frames never shows as "arrived").
  const firstHit = U.findIndex((u, i) => i + 1 < U.length && u > 0.5 && U[i + 1] < u - 2 * noise);
  let deepest = 0, rebounds = 0;
  for (let i = Math.max(1, firstHit + 1), away = false; firstHit >= 0 && i < U.length; i++) {
    const depth = 1 - U[i];
    if (depth > deepest) deepest = depth;
    const off = depth > Math.max(0.02, 3 * noise);
    if (off && !away) rebounds++;
    away = off;
  }
  let bounce = { p: [0, 0, 0], f: big };
  if (firstHit >= 3 && rebounds >= 1 && overshoot <= Math.max(0.01, 2 * noise) && deepest > Math.max(0.04, 4 * noise)) {
    const bounceCost = (p: number[]) => {
      const [t1, e, lead] = p;
      if (t1 < 2 * period || t1 > total || e < 0.05 || e > 0.97 || lead < minLead || lead > maxLead) return big;
      return cost((t) => bounceValue(2 / (t1 * t1), e, t), lead);
    };
    const hit0 = T[firstHit] + period / 2;
    // The first rebound is e² as deep as the fall: a good first guess at e.
    // The cost is full of dips (every later landing has to line up), so start from the best of a grid around the
    // two things the frames show directly: when it first landed, and how deep the first rebound went (e² of the fall).
    const e0 = Math.sqrt(clamp(deepest, 0.01, 0.9));
    let start = { p: [hit0, e0, period / 2], f: big };
    for (let dt = -1.5; dt <= 1.51; dt += 0.25) for (let de = -0.12; de <= 0.121; de += 0.02) for (const lead of [0, period / 2, period]) {
      const p = [hit0 + dt * period, e0 + de, lead], f = bounceCost(p);
      if (f < start.f) start = { p, f };
    }
    if (start.f < big) bounce = minimise(bounceCost, start.p, [period / 4, 0.02, period / 4], 400);
  }

  const rms = (f: number) => Math.sqrt(f);
  const mkBounce = (): BounceFit => ({ kind: "bounce", gravity: 2 / (bounce.p[0] * bounce.p[0]), restitution: bounce.p[1], first_hit_ms: 1000 * bounce.p[0], rebounds });
  const mkSpring = (): SpringFit => {
    const [omega, zeta, , v0] = spring.p;
    return { kind: "spring", omega, zeta, v0, duration: (2 * Math.PI) / omega, bounce: zeta <= 1 ? 1 - zeta : 1 / zeta - 1, stiffness: omega * omega, damping: 2 * zeta * omega };
  };
  // A named curve wins over the free bezier unless the four extra numbers buy a clearly better fit.
  const useNamed = rms(named.f) <= Math.max(1.3 * rms(free.f), noise);
  const mkCurve = (): CurveFit => useNamed ? { kind: "curve", p: named.c, duration: named.D, preset: named.name }
    : { kind: "curve", p: free.p.slice(0, 4).map((v) => Math.round(v * 100) / 100) as [number, number, number, number], duration: free.p[4], preset: nearestCurve(free.p.slice(0, 4)) };
  const mkLerp = (): LerpFit => ({ kind: "lerp", rate: lerp.p[0], half_life_ms: (1000 * Math.LN2) / lerp.p[0], per_frame: 1 - Math.exp(-lerp.p[0] * period), by_frame: byFrame || undefined });

  const curveF = useNamed ? named.f : free.f;
  // Fewest free numbers first: lerp (1), spring (2), curve (named 1 / free 5). A richer model must beat a simpler
  // one by a real margin, or the simpler one is the better explanation.
  const cands: { m: () => Model; f: number; k: number }[] = [
    { m: mkLerp, f: lerp.f, k: 1 }, { m: mkSpring, f: spring.f, k: spring.p[3] ? 3 : 2 }, { m: mkCurve, f: curveF, k: useNamed ? 1 : 5 },
  ];
  if (bounce.f < big) cands.push({ m: mkBounce, f: bounce.f, k: 2 });
  const floor = (f: number) => Math.max(rms(f), noise);
  cands.sort((a, b) => floor(a.f) * (1 + 0.06 * a.k) - floor(b.f) * (1 + 0.06 * b.k));
  const best = cands[0];
  const caveat = !settled ? "it had not come to rest when the motion ended, so the target (and with it the fit) is a guess"
    : n - 1 < 12 ? `only ${n - 1} frames: the parameters are rough`
    : noise > 0.02 ? `it travelled only ${Math.round(Math.abs(travel) / res)}× the smallest step this reading can show: the numbers are rough` : undefined;
  if (leap > 0.4) {
    return { model: null, rms: rms(best.f), ...facts, caveat: `${Math.round(100 * leap)}% of the way went in a single frame, so the in-between positions were never shown and what drove it cannot be told (frames lost to a blocked main thread, or the value was simply set)` };
  }
  if (rms(best.f) > Math.max(0.035, 3 * noise)) {
    return { model: null, rms: rms(best.f), ...facts, caveat: caveat ?? "no single spring or timing curve reproduces it: driven by hand, retargeted mid-flight, or several animations overlapping" };
  }
  // The runner-up from another family, if the frames cannot separate them.
  const sameThing = (m: Model, n: Model) => (m.kind === "lerp" && n.kind === "spring" && n.zeta > 1.5) || (n.kind === "lerp" && m.kind === "spring" && m.zeta > 1.5);
  // (When the winner misses by far less than the measurement was assumed able to resolve, the measurement is that
  // much better than assumed, and a rival has to come that close too.)
  const shown = Math.min(noise, Math.max(0.004, 2.5 * rms(best.f)));
  const near = (f: number) => Math.max(rms(f), shown);
  // (It went clearly past its target and came back: nothing that only ever approaches can be the other story.)
  const approachesOnly = (m: Model) => m.kind === "lerp" || (m.kind === "curve" && m.p[1] <= 1.02 && m.p[3] <= 1.02);
  const wentPast = overshoot > Math.max(0.05, 3 * noise);
  const rival = cands.slice(1).find((c) => near(c.f) <= Math.max(1.6 * near(best.f), 1.2 * shown) && !sameThing(best.m(), c.m()) && !(wentPast && approachesOnly(c.m())));
  // An overshoot that rings is a spring, whatever a flexible bezier manages to trace through it.
  let bestModel = best.m(), other = rival?.m();
  // A timing curve has to leave 0…1 to trace an overshoot, and hardly anything ships one that does: when a spring
  // explains the same frames, the spring is the likelier story and the curve the footnote.
  if (bestModel.kind === "curve" && other?.kind === "spring" && overshoot > Math.max(0.015, 2 * noise) && (bestModel.p[1] > 1.02 || bestModel.p[3] > 1.02)) [bestModel, other] = [other, bestModel];
  return { model: bestModel, rms: rms(best.f), also: other && !(bestModel.kind === "spring" && crossings >= 2) ? other : undefined, ...facts, caveat };
}

function nearestCurve(c: number[]): string | undefined {
  let bestName: string | undefined, bestD = 0.0012; // mean squared difference between the two curves' shapes
  for (const [name, q] of CURVES) {
    let d = 0;
    for (let i = 1; i < 20; i++) { const e = bezierValue(c[0], c[1], c[2], c[3], i / 20) - bezierValue(q[0], q[1], q[2], q[3], i / 20); d += e * e; }
    if (d / 19 < bestD) { bestD = d / 19; bestName = name; }
  }
  return bestName;
}

// ---- telling it ---------------------------------------------------------------------------------------------------

const n2 = (x: number) => (Math.round(x * 100) / 100).toString();
const msr = (s: number) => `${Math.round(s * 1000)}ms`;

/** What a hand would say this is made of: the damping ratio is the whole feel of a spring. */
export function feel(zeta: number): string {
  return zeta < 0.3 ? "rings like a struck steel rule: several visible bounces"
    : zeta < 0.55 ? "rubbery: it bounces back and forth before settling"
    : zeta < 0.8 ? "lively: one clear overshoot, then home"
    : zeta < 0.95 ? "snappy: a whisper of overshoot"
    : zeta < 1.08 ? "smooth: arrives without overshoot, like a soft-close drawer"
    : "heavy: overdamped, it creeps the last stretch as if through oil";
}

export function describeModel(m: Model, travel?: number): string {
  if (m.kind === "bounce") {
    const g = travel ? `${Math.round(m.gravity * Math.abs(travel))}pt/s²` : `${n2(m.gravity)}× its travel per s²`;
    return `a BOUNCE: let go, it falls at constant acceleration (${g}), lands after ${Math.round(m.first_hit_ms)}ms and rebounds off its target without ever passing it, keeping ${n2(m.restitution)} of its speed each time (${m.rebounds} rebound${m.rebounds === 1 ? "" : "s"} seen)${Math.abs(m.restitution - 0.5) < 0.06 ? "; the stock easeOutBounce easing is this with 0.5" : ""}; gravity and a floor, not a spring: it lands hard instead of easing in`;
  }
  if (m.kind === "spring") {
    const name = SPRING_NAMES.find(([, b]) => Math.abs(b - m.bounce) <= 0.04);
    const swiftui = name ? `.${name[0]}(duration: ${n2(m.duration)})` : `.spring(duration: ${n2(m.duration)}, bounce: ${n2(m.bounce)})`;
    return `a SPRING, damping ratio ${n2(m.zeta)}, response ${n2(m.duration)}s — ${swiftui} · stiffness ${Math.round(m.stiffness)} damping ${n2(m.damping)}${Math.abs(m.v0) > 0.5 ? `, launched already moving (${n2(m.v0)}× its travel per second)` : ""}; ${feel(m.zeta).split(":")[0]}`;
  }
  if (m.kind === "curve") {
    const bez = `cubic-bezier(${m.p.map(n2).join(", ")})`;
    return `a TIMING CURVE over ${msr(m.duration)}: ${m.preset ? `${m.preset}${m.preset === "linear" ? "" : ` = ${bez}`}` : bez}${m.preset === "linear" ? "; constant speed, no easing" : ""}`;
  }
  // Friction on a thing let go at speed (scroll momentum, a flick that coasts) draws exactly this curve: the
  // distance left shrinks by a fixed factor per unit of time.
  const perMs = Math.exp(-m.rate / 1000);
  return `a PER-FRAME LERP (exponential approach, x += (target − x) × ${n2(m.per_frame)} each frame; half-life ${Math.round(m.half_life_ms)}ms): fast off the mark, never overshoots, crawls in at the end; a momentum decay draws the same curve (speed × ${perMs.toFixed(perMs > 0.99 ? 4 : 3)} every millisecond)${m.by_frame ? "; it stepped once per delivered frame, not with the clock, so it ran slower wherever frames dropped (frame-rate dependent)" : ""}`;
}

/** One or two lines for a report: what moved it, how well that explains the frames, and what it did. */
export function formatFit(f: MotionFit, o: { unit?: string; what?: string; from?: string } = {}): string[] {
  const unit = o.unit ?? "pt", abs = unit === "pt"; // only points mean something as an absolute size
  const did = `settled in ${Math.round(f.settle_ms)}ms${f.overshoot_pct >= 1 ? `, overshot ${abs ? `${f.overshoot.toFixed(1)}pt (${f.overshoot_pct.toFixed(0)}%)` : `${f.overshoot_pct.toFixed(0)}% past its target`}` : ", no overshoot"}, fastest ${abs ? `${Math.round(f.peak_speed)}pt/s ` : ""}at ${Math.round(f.peak_at_pct)}%`;
  if (!f.model) return [`moved by: nothing simple (best model off by ${(100 * f.rms).toFixed(1)}%) — ${f.caveat}`, `  ${did}${o.from ? ` · from ${o.from}` : ""}`];
  const L = [`moved by: ${describeModel(f.model, abs ? f.travel : undefined)}`];
  if (f.also) L.push(`  or equally: ${describeModel(f.also, abs ? f.travel : undefined)}`);
  L.push(`  ${did} · fit off by ${(100 * f.rms).toFixed(1)}% over ${f.frames} frames${o.from ? ` · from ${o.from}` : ""}${f.caveat ? ` · ${f.caveat}` : ""}`);
  return L;
}
