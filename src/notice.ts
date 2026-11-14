// What a person watching would have NOTICED, in words, worst first. analyze.ts measures; this file perceives:
// it turns the same rows into "froze 58ms at 0.42s", "flashed for one frame", "responded 180ms after the click",
// so the reader of a report starts from a verdict instead of a table. Pure: reads the run's files, decides nothing.
//
// Severity: 3 = anyone would see it (hang) · 2 = clearly visible · 1 = visible if you look for it · 0 = a fact
// about the motion (what moved, how, how fast it answered), not a defect.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Analysis, Meta, Options, Row } from "./analyze.ts";
import { fitMotion, formatFit } from "./physics.ts";
import { correlation, track } from "./track.ts";

export type Percept = { t: number; sev: 0 | 1 | 2 | 3; kind: string; text: string; from?: number; to?: number; why?: string[]; more?: string[] };
export type Seen = { grade: "still" | "smooth" | "minor" | "rough" | "broken"; verdict: string; percepts: Percept[];
  /** What the app told accessibility meanwhile, in order, each placed against the steps and the motion. */
  said?: { from: number; lines: string[]; silent?: string };
  /** Root readings (dtrace, powermetrics) told against the motions. */
  under?: string[] };

/** One thing the app told accessibility while it was recorded (run clock; `n` changes between `t` and `last`). */
export type Said = { t: number; last: number; n: number; event: string; text: string; el?: number; value?: string; head?: string };
export type Heard = { from: number; app: string; events: Said[] };

/** One main-thread stall measured inside the app by the probe's watchdog (mach seconds). */
import { loadUnder, underLines, whoWasLate } from "./under.ts";

export type Stall = { t: number; ms: number; n: number; ongoing?: boolean; app: [string, number][]; leaf: [string, number][]; stack: string[] };
export type Stalls = { name: string; pid: number; from: number; to: number; threshold_ms: number; stacks: boolean; stalls: Stall[] };
type Action = { t0: number; t1: number; op: string; note?: string; ok?: boolean };

export function loadActions(dir: string, t0Wall: number): Action[] {
  const p = join(dir, "actions.jsonl");
  if (!existsSync(p) || !t0Wall) return [];
  const out: Action[] = [];
  for (const l of readFileSync(p, "utf8").split("\n")) {
    if (!l) continue;
    try { const a = JSON.parse(l); out.push({ ...a, t0: a.wall0 - t0Wall, t1: a.wall1 - t0Wall }); } catch { /* torn line */ }
  }
  return out;
}
/**
 * events.jsonl: what `eye-capture watch --exact` heard from the recorded app, each line stamped when its
 * notification arrived. A value that kept changing (a counter, a progress bar) arrives as several lines for one
 * element: they are told as one, first value → last.
 */
export function loadSaid(dir: string, t0Wall: number): Heard | null {
  const p = join(dir, "events.jsonl");
  if (!existsSync(p) || !t0Wall) return null;
  let from: number | null = null, app = "";
  const all: Said[] = [];
  for (const l of readFileSync(p, "utf8").split("\n")) {
    if (!l) continue;
    let o: any;
    try { o = JSON.parse(l); } catch { continue; /* torn line */ }
    if (o.event === "ready") { from = o.t - t0Wall; app = o.apps?.[0] ?? ""; continue; }
    if (typeof o.t !== "number" || o.event === "timeout" || String(o.event).startsWith("already-")) continue;
    const text = String(o.text ?? o.event).replace(`${o.event} ${o.app} `, `${o.event} `).replace(new RegExp(` ${o.app}$`), "");
    const cut = text.indexOf(' = "');
    all.push({ t: o.t - t0Wall, last: (o.t_last ?? o.t) - t0Wall, n: o.n ?? 1, event: o.event, text, el: o.el,
      value: typeof o.value === "string" ? o.value : undefined, head: cut >= 0 ? text.slice(0, cut) : undefined });
  }
  if (from === null) return null;
  all.sort((a, b) => a.t - b.t);
  const events: Said[] = [], open = new Map<number, Said>();
  for (const e of all) {
    const prev = e.event === "value-changed" && e.el !== undefined ? open.get(e.el) : undefined;
    if (prev && e.t - prev.last < 0.5 && prev.head !== undefined && e.value !== undefined) {
      const first = prev.text.match(/ = "(.*?)"(?: →| \(|$)/)?.[1] ?? prev.value ?? "";
      prev.n += e.n; prev.last = e.last; prev.value = e.value;
      prev.text = `${prev.head} = "${first}" → "${e.value}" (${prev.n} changes in ${ms((prev.last - prev.t) * 1000)})`;
      continue;
    }
    events.push(e);
    if (e.event === "value-changed" && e.el !== undefined) open.set(e.el, e);
  }
  return { from, app, events };
}

/** Where one of the app's words falls: against the step that came before it, and against what was moving. */
export function placeSaid(e: Said, segs: { start_s: number; end_s: number }[], actions: Action[]): string {
  const out: string[] = [];
  const act = [...actions].reverse().find((x) => RESPONSIVE.has(x.op) && x.t0 <= e.t + 0.004 && e.t - x.t0 < 2);
  if (act) out.push(`${ms(Math.max(0, e.t - act.t0) * 1000)} after ${act.op}${act.note ? ` "${act.note}"` : ""}`);
  const name = (i: number) => (segs.length > 1 ? `motion ${i + 1}` : "the motion");
  const si = segs.findIndex((s) => e.t >= s.start_s - 1e-6 && e.t <= s.end_s + 1e-6);
  if (si >= 0) {
    const s = segs[si], dur = Math.max(1e-3, s.end_s - s.start_s);
    out.push(`${Math.round((100 * (e.t - s.start_s)) / dur)}% into ${name(si)} (${ms(dur * 1000)} long)`);
  } else {
    const next = segs.findIndex((s) => s.start_s > e.t), prev = next < 0 ? segs.length - 1 : next - 1;
    if (next >= 0 && segs[next].start_s - e.t <= 0.5) out.push(`${ms((segs[next].start_s - e.t) * 1000)} before ${name(next)} began`);
    else if (prev >= 0 && e.t - segs[prev].end_s <= 1) out.push(`${ms((e.t - segs[prev].end_s) * 1000)} after ${name(prev)} came to rest`);
    else if (segs.length) out.push("while nothing was moving");
  }
  return out.join(" · ");
}

export function loadStalls(dir: string): Stalls | null {
  try { return JSON.parse(readFileSync(join(dir, "stalls.json"), "utf8")); } catch { return null; }
}

const median = (v: number[]) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };
const ms = (x: number) => `${x >= 100 ? x.toFixed(0) : x.toFixed(1)}ms`;
const at = (t: number) => `${t.toFixed(2)}s`;
const pt = (x: number) => `${Math.round(x)}pt`;
/** Things that answer on screen when they land (a move or a wait is not expected to). */
const RESPONSIVE = new Set(["click", "down", "up", "scroll", "pinch", "rotate", "smart_zoom", "swipe", "press", "force_click"]);

/** Why the screen stood still between `from` and `to` (run clock), from the probe's main-thread watchdog. */
export function whyGap(st: Stalls | null, t0Mach: number, from: number, to: number): string[] {
  if (!st || !t0Mach) return [];
  const a = from + t0Mach, b = to + t0Mach;
  if (a < st.from || b > st.to) return [];
  const hits = st.stalls.filter((s) => s.t < b + 0.004 && s.t + s.ms / 1000 > a - 0.004);
  if (!hits.length) {
    return [`${st.name}'s main thread was free the whole time (no run-loop turn over ${st.threshold_ms}ms): the frames were lost after the app handed them over — render server, GPU or window server — or this motion is not driven by the app's main thread`];
  }
  return hits.flatMap((s) => {
    const head = `${st.name}'s main thread was ${s.ongoing ? "STILL blocked after" : "blocked"} ${ms(s.ms)} from ${at(s.t - t0Mach)}`;
    if (!s.n) return [`${head} (too short to sample${st.stacks ? "" : "; stack sampling needs arm64"})`];
    const share = (c: number) => `${Math.round((100 * c) / s.n)}%`;
    const out = [`${head} · ${s.n} stack sample${s.n > 1 ? "s" : ""}`];
    if (s.app.length) out.push(`  in app code: ${s.app.slice(0, 3).map(([f, c]) => `${f} (${share(c)})`).join(" · ")}`);
    if (s.leaf.length) out.push(`  executing: ${s.leaf.slice(0, 3).map(([f, c]) => `${f} (${share(c)})`).join(" · ")}`);
    if (s.stack.length) out.push(`  commonest stack: ${s.stack.slice(0, 10).join(" ← ")}`);
    return out;
  });
}

export function notice(rows: Row[], meta: Meta, a: Analysis, o: Options & { dir?: string; still_recording?: boolean } = {}): Seen {
  const period = a.period_ms;
  const thr = o.motion_threshold ?? 0.0005;
  const split = (o.split_gap_ms ?? 150) / 1000;
  const inWin = (r: Row) => (o.from_s === undefined || r.t >= o.from_s) && (o.to_s === undefined || r.t <= o.to_s);
  const complete = rows.filter((r) => r.s === "c" && inWin(r));
  const t0Mach = Number(meta.t0_mach ?? 0), t0Wall = Number(meta.t0_wall ?? 0);
  const stalls = o.dir ? loadStalls(o.dir) : null;
  const actions = o.dir ? loadActions(o.dir, t0Wall).filter((x) => inWin({ t: x.t0 } as Row)) : [];
  const heard = o.dir ? loadSaid(o.dir, t0Wall) : null;
  const said = heard ? heard.events.filter((e) => inWin({ t: e.t } as Row)) : [];
  const under = o.dir ? loadUnder(o.dir, t0Wall) : null;
  /** The probe says what held the main thread; the root readings say whether it was the app or the window server. */
  const whyFroze = (from: number, to: number) => { const w = whyGap(stalls, t0Mach, from, to), late = under ? whoWasLate(under, from, to, period) : undefined; return late ? [...w, late] : w; };
  const P: Percept[] = [];
  const key = a.extent_source === "top-anchored" ? (["aw", "ah"] as const) : (["w", "h"] as const);
  const dimName = ["width", "height"];

  const sevOf = (gapMs: number) => (gapMs >= 100 ? 3 : gapMs >= 50 ? 2 : 1) as 1 | 2 | 3;
  const word = (sev: number) => (sev === 3 ? "HUNG" : sev === 2 ? "FROZE" : "hiccup:");
  /** How the previous motion ended: still at speed (and which way), or eased to rest. */
  let prevEnd: { atSpeed: boolean; dir: number; d: number; value: number; end: number } | null = null;
  let fits = 0;
  const lastRowT = rows.filter(inWin).pop()?.t ?? 0;

  a.segments.forEach((s, si) => {
    const fr = complete.filter((r) => r.t >= s.start_s - 1e-6 && r.t <= s.end_s + 1e-6);
    if (fr.length < 3) { prevEnd = null; return; }
    const gaps = fr.slice(1).map((r) => r.interval).filter((x) => x > 0);
    const cadence = Math.max(period, median(gaps));
    /** A frame this late is a stall, not pacing: 3+ refreshes, and well beyond the motion's own cadence. */
    const slow = Math.max(2.9 * period, 2.2 * cadence);
    const name = a.segments.length > 1 ? `motion ${si + 1}` : "the motion";

    // The dimension that travelled furthest tells the story of this motion. It starts from what was on screen
    // just before (nothing = 0: the extent is measured against the first frame of the recording).
    const before = [...complete].reverse().find((r) => r.t < s.start_s - 1e-6);
    const range = key.map((k) => { const all = [before?.[k] ?? 0, ...fr.map((r) => r[k])]; return Math.max(...all) - Math.min(...all); });
    const d = range[1] > range[0] ? 1 : 0, k = key[d];
    const v = [before?.[k] ?? 0, ...fr.map((r) => r[k])]; // v[i + 1] belongs to fr[i]
    const steps = v.slice(1).map((x, i) => Math.abs(x - v[i]));
    const typical = median(steps.filter((x) => x > 0.05));
    /** The motion right around step i: a jump is judged against its neighbours, not against the whole curve. */
    const around = (i: number) => Math.max(steps[i - 1] ?? 0, steps[i + 1] ?? 0);

    // 1a. A freeze so long it split the motion in two: the last one stopped dead at speed, this one carries on.
    // Told apart from one motion easing out before the next begins by how frames ARRIVED in between: a slow tail
    // still delivers an image every refresh; a freeze delivers none, or a few stragglers many refreshes apart.
    const gapMs = prevEnd ? (s.start_s - prevEnd.end) * 1000 : 0, startDir = Math.sign(v[Math.min(2, v.length - 1)] - v[0]);
    const starved = prevEnd !== null && fr[0].interval >= 2.9 * period
      && complete.every((r) => r.t <= prevEnd!.end + 1e-6 || r.t >= s.start_s - 1e-6 || r.interval >= 2.9 * period);
    if (prevEnd && prevEnd.atSpeed && starved && gapMs <= 1500
      && (prevEnd.dir === 0 || (prevEnd.d === d && prevEnd.dir === startDir))) {
      const why = whyFroze(prevEnd.end, s.start_s);
      // Certain when the edge carried on the same way, or when the app's own main thread was blocked right then.
      const sev = prevEnd.dir !== 0 || why.some((w) => /blocked/.test(w)) ? sevOf(gapMs) : 1;
      P.push({ t: prevEnd.end, from: prevEnd.end, to: s.start_s, sev, kind: "freeze",
        text: `${word(sev)} ${ms(gapMs)} (${Math.round(gapMs / period)} refreshes with no new image) at ${at(prevEnd.end)}: motion ${si} stopped dead${prevEnd.dir ? ` at ${pt(prevEnd.value)}` : ""} and motion ${si + 1} carried on from there — one motion, torn in two`,
        why });
    }

    // 1b. Freezes inside the motion: the picture stood still for 3+ refreshes (and well beyond its own cadence).
    const frozeAt = new Set<number>();
    for (let i = 1; i < fr.length; i++) {
      if (fr[i].interval < slow) continue;
      // One freeze can arrive in pieces: the capture hands over "new" images identical to the last one in the
      // middle of it. Late frames that changed nothing, each followed by another late frame, are the same freeze.
      const first = i;
      let total = fr[i].interval;
      while (i + 1 < fr.length && fr[i].frac <= thr && fr[i + 1].interval >= slow) total += fr[++i].interval;
      if (i < 3) continue; // the first frames are start-up, not motion yet
      for (let j = first; j <= i; j++) frozeAt.add(j);
      const sev = sevOf(total), r = fr[i];
      const jump = steps[i];
      const caught = jump >= 6 && jump > 3 * Math.max(steps[first - 1] ?? 0, steps[i + 1] ?? 0) ? `, then ${dimName[d]} jumped ${pt(jump)} to catch up (${pt(v[i])}→${pt(v[i + 1])})` : "";
      const from = r.t - total / 1000;
      P.push({ t: from, from, to: r.t, sev, kind: "freeze",
        text: `${word(sev)} ${ms(total)} (${Math.round(total / period)} refreshes with no new image) at ${at(from)}, ${Math.round((100 * (from - s.start_s)) / Math.max(1e-3, s.end_s - s.start_s))}% into ${name}${caught}`,
        why: whyFroze(from, r.t) });
    }
    {
      const tail = steps.slice(-3), fracs = fr.map((r) => r.frac);
      const moved = range[d] >= 2 && typical > 0;
      prevEnd = { end: s.end_s, d, value: v[v.length - 1], dir: moved ? Math.sign(v[v.length - 1] - v[Math.max(0, v.length - 4)]) : 0,
        atSpeed: (moved && Math.min(...tail) >= Math.max(1, 0.25 * typical)) || fracs[fracs.length - 1] >= 0.5 * median(fracs) };
      if (!(moved && Math.min(...tail) >= 1)) prevEnd.dir = 0; // the edge was at rest: only the picture inside was changing
    }

    // 2. Pacing: a steady lower rate is a choice (or a throttle); an uneven one is judder.
    const p95 = [...gaps].sort((x, y) => x - y)[Math.min(gaps.length - 1, Math.round(0.95 * (gaps.length - 1)))] ?? 0;
    const late = gaps.filter((g) => g >= 1.5 * cadence).length - frozeAt.size;
    if (cadence >= 1.7 * period && p95 <= 1.35 * cadence && gaps.length >= 8) {
      P.push({ t: s.start_s, sev: 1, kind: "low-rate",
        text: `${name} ran at a steady ${Math.round(1000 / cadence)} fps on a ${a.refresh_hz}Hz display (evenly every ${(cadence / period).toFixed(1)} refreshes): something drives it at that rate — a timer, a 60Hz display link, video, or ProMotion throttling — rather than frames being dropped` });
    } else if (gaps.length >= 12 && late / gaps.length > 0.1) {
      const sev = late / gaps.length > 0.25 ? 2 : 1;
      P.push({ t: s.start_s, sev, kind: "judder",
        text: `${sev === 2 ? "JUDDER" : "uneven:"} ${late} of ${gaps.length} frames of ${name} arrived late (${s.fps} fps average of ${a.refresh_hz}; pacing irregular, not one freeze)` });
    } else if (s.fps < 0.75 * a.refresh_hz && frozeAt.size === 0) {
      P.push({ t: s.start_s, sev: 1, kind: "sparse",
        text: `sparse: ${name} showed ${s.new_frames} new images in ${s.duration_ms}ms (${s.fps} fps of ${a.refresh_hz}) — a choppy animation, or something that simply updates now and then (a counter, a caret, a progress bar)` });
    }

    // What moved it: the physics behind the frames (spring, timing curve, per-frame lerp), fitted without being asked.
    // A size that changed tells it best; a fade or recolour in place is read from the region's brightness instead.
    let more: string[] | undefined, boxless = false, trackedShape = "", fade = "";
    if (fits < 12) {
      fits++;
      const cut = si === a.segments.length - 1 && lastRowT - s.end_s < (3 * period) / 1000;
      // The motion proper starts after the last pause among the segment's first frames (the press highlighting the
      // button, the window coming forward: a change, a wait, and only then the animation).
      let on = 0;
      for (let i = 1; i < Math.min(fr.length - 6, 10); i++) if (fr[i].interval >= 2.4 * period) on = i;
      const cell = Number(meta.sample_step ?? 2) / Number(meta.scale ?? 2);
      // The thing itself, followed from frame to frame (see track.ts). It knows where the motion really starts, and
      // it decides which of the other readings can be believed: brightness only where it moves in step with the thing
      // (an edge uncovering area), never when two dimensions change at once (area is then the product of two curves)
      // and never for a slide (nothing gets brighter).
      // A motion "ends" for the tables when it stops changing visibly, but a spring or a lerp creeps on below that
      // for a while: the frames up to the next motion belong to it, or the fit would aim at a place it had not reached.
      const until = Math.min(a.segments[si + 1]?.start_s ?? Infinity, s.end_s + 0.6) - 1e-6;
      const fx = [...fr, ...complete.filter((r) => r.t > s.end_s + 1e-6 && r.t < until)];
      const tr = track(fx, cell, period / 1000);
      if (tr.tracks.length) on = tr.onset;
      const m = fx.slice(on), t = [m[0].t - period / 1000, ...m.map((r) => r.t)];
      const series = (rest: number, vals: number[]) => [rest, ...vals].map((x, i) => ({ t: t[i], x }));
      type Cand = { samples: { t: number; x: number }[]; res: number; unit: string; from: string; minLead?: number; shape?: string };
      // Three ways to read one motion off the pixels, most trustworthy first: an extent aimed at it (top-anchored),
      // the region's brightness (sub-pixel exact, follows the changing AREA), the box around what changed, and the
      // running total of change between frames (distance covered, the only one that sees a pure slide).
      const ext: Cand = { samples: series(before?.[k] ?? 0, m.map((r) => r[k])), res: cell, unit: "pt", from: `the ${dimName[d]} of the changed area` };
      let run = 0;
      // Where the brightness rested: before anything happened, or, if the press itself lit something that stayed lit,
      // right before the motion. Both are tried; the one a model explains is the one that was true.
      const lumFrom = "the region's brightness, which follows the area that changed";
      const lum: Cand = { samples: series(before?.luma ?? m[0].luma, m.map((r) => r.luma)), res: 0.05, unit: "/255", from: lumFrom };
      const lumLit: Cand[] = on > 0 && Math.abs(fr[on - 1].luma - (before?.luma ?? fr[on - 1].luma)) > 0.05
        ? [{ samples: series(fr[on - 1].luma, m.map((r) => r.luma)), res: 0.05, unit: "/255", from: lumFrom }] : [];
      const dist: Cand = { samples: series(0, m.map((r) => (run += r.diff))), res: 0.02, unit: " (change)", from: "the amount of change from frame to frame: distance covered, so an overshoot shows as extra distance, not as a reversal" };
      const followed: Cand[] = tr.tracks.map((x) => ({ samples: x.samples, res: cell, unit: "pt", from: x.from, minLead: x.minLead, shape: x.shape }));
      const inStep = followed.length > 0 && !tr.twoD
        && Math.abs(correlation(tr.tracks[0].samples.slice(1).map((p) => p.x), m.map((r) => r.luma))) >= 0.985;
      const cands: Cand[] = a.extent_source === "top-anchored" ? [ext, lum, ...followed, dist]
        : !followed.length ? [lum, ...lumLit, ext, dist]
        : tr.twoD ? followed
        : inStep ? [lum, ...lumLit, ...followed, ext, dist] : [...followed, dist];
      if (followed.length) trackedShape = followed[0].shape!;
      let best: { fit: NonNullable<ReturnType<typeof fitMotion>>; c: Cand } | undefined;
      for (const c of cands) {
        const fit = fitMotion(c.samples, period / 1000, { cut, res: c.res, minLead: c.minLead });
        if (!fit) continue;
        // (The two brightness readings are one reading with two possible starting levels: the better-explained wins.)
        const twin = best?.fit.model && fit.model && lumLit.includes(c) && best.c === lum && fit.rms < best.fit.rms;
        if (!best || twin || (fit.model && !best.fit.model) || (!fit.model && !best.fit.model && fit.rms < best.fit.rms)) best = { fit, c };
        if (fit.model && !(c === lum && lumLit.length)) break;
      }
      if (best) more = formatFit(best.fit, { unit: best.c.unit, from: best.c.from });
      // Nothing travelled and no pixel stepped, yet one curve explains the brightness: it faded where it stood.
      if (best?.fit.model && !followed.length && (best.c === lum || lumLit.includes(best.c)) && m.filter((r) => r.frac <= 0.0005).length >= 0.7 * m.length) {
        fade = best.fit.travel < 0 ? "dimmed" : "brightened";
      }
      // One curve explains every frame, and it was not read off the box: whatever the box did, the motion did not jump.
      boxless = !!best?.fit.model && best.c !== ext && a.extent_source === "bbox";
    }

    // 3. Jumps: the moving edge leapt far more than the motion around it, without a freeze to explain it.
    if (!boxless && steps.filter((x) => x > 0.05).length >= 6) {
      let n = 0;
      steps.forEach((x, i) => {
        // (The first frames are the thing appearing, not the motion yet.)
        if (i < 3 || frozeAt.has(i) || x < Math.max(12, 4 * around(i)) || n >= 3) return;
        n++;
        P.push({ t: fr[i].t, sev: a.extent_source === "top-anchored" ? 2 : 1, kind: "jump",
          text: `${a.extent_source === "top-anchored" ? "SNAPPED" : "jump:"} ${dimName[d]} went ${pt(v[i])}→${pt(v[i + 1])} in one frame at ${at(fr[i].t)} (the frames around it move ~${around(i).toFixed(1)}pt each${a.extent_source === "top-anchored" ? "" : "; the extent is the box around everything that changed, so another element appearing or vanishing in the region reads the same"})` });
      });
    }

    // 4. The shape of the motion: where it went, whether it overshot or wobbled.
    let reversals = 0, dir = 0;
    for (let i = 1; i < v.length; i++) {
      const dv = v[i] - v[i - 1];
      if (Math.abs(dv) < 1) continue;
      const sg = Math.sign(dv);
      if (dir && sg !== dir) reversals++;
      dir = sg;
    }
    const first = v[0], last = v[v.length - 1], travel = Math.abs(last - first);
    const over = last >= first ? Math.max(...v) - last : last - Math.min(...v);
    const e = s.extent;
    const shape = fade ? `nothing moved: it ${fade} in place, a fade (the area that changed is ${pt(s.extent.w_to)}×${pt(s.extent.h_to)})`
      : trackedShape && a.extent_source === "bbox" ? `what moved ${trackedShape}`
      : boxless ? `the changed area ends ${pt(e.w_to)}×${pt(e.h_to)}`
      : range[d] < 2 ? "changed in place (no size change measured)"
      : `${dimName[d]} ${pt(first)}→${pt(last)}${over > Math.max(2, 0.02 * travel) && reversals <= 3 ? `, overshot by ${pt(over)} and settled` : ""}`;
    P.push({ t: s.start_s, sev: 0, kind: "motion", more,
      text: `${name}: ${at(s.start_s)}–${at(s.end_s)} (${s.duration_ms}ms) · ${shape} · ${s.fps} fps of ${a.refresh_hz}` });
    if (reversals >= 4 && !boxless) P.push({ t: s.start_s, sev: 1, kind: "wobble", text: `wobble: ${dimName[d]} changed direction ${reversals}× during ${name} (${pt(Math.min(...v))}..${pt(Math.max(...v))})` });
  });

  // 5. Flashes: the whole region's brightness leaves for one or two frames and comes straight back.
  let flashes = 0;
  for (let i = 1; i + 1 < complete.length && flashes < 4; i++) {
    const p0 = complete[i - 1], c = complete[i];
    const dev = c.luma - p0.luma;
    if (Math.abs(dev) < 8) continue;
    for (const j of [i + 1, i + 2]) {
      const back = complete[j];
      if (!back || back.t - c.t > 4 * period / 1000) break;
      if (Math.abs(back.luma - p0.luma) < 0.3 * Math.abs(dev)) {
        flashes++;
        P.push({ t: c.t, sev: 2, kind: "flash", text: `FLASH: the region went ${dev > 0 ? "brighter" : "darker"} for ${j - i} frame${j - i > 1 ? "s" : ""} at ${at(c.t)} and came straight back (mean luma ${p0.luma.toFixed(0)}→${c.luma.toFixed(0)}→${back.luma.toFixed(0)} of 255)` });
        i = j;
        break;
      }
    }
  }

  // 6. Pops: a visible change that took one or two frames — no transition at all.
  const moving = complete.filter((r) => r.frac > thr);
  let pops = 0;
  for (let i = 0; i < moving.length && pops < 5;) {
    let j = i;
    while (j + 1 < moving.length && moving[j + 1].t - moving[j].t <= split) j++;
    const n = j - i + 1, big = Math.max(...moving.slice(i, j + 1).map((r) => r.frac));
    if (n <= 2 && big >= 0.02) {
      pops++;
      P.push({ t: moving[i].t, sev: 0, kind: "pop", text: `pop: ${(100 * big).toFixed(0)}% of the region changed at ${at(moving[i].t)} in ${n} frame${n > 1 ? "s" : ""} — instant, no transition` });
    }
    i = j + 1;
  }

  // 7. Response: how long the screen took to answer each press / scroll / gesture.
  let answered = 0;
  for (const act of actions) {
    if (!RESPONSIVE.has(act.op) || act.ok === false) continue;
    const hit = moving.find((r) => r.t >= act.t0);
    const lat = hit ? (hit.t - act.t0) * 1000 : Infinity;
    const what = `${act.op}${act.note ? ` "${act.note}"` : ""} at ${at(act.t0)}`;
    // The app's own word on it: the first thing it told accessibility after the step, before the next step.
    // Whether it knew before the screen showed it says where a slow answer was lost: in deciding, or in drawing.
    const nextAct = actions.find((x) => RESPONSIVE.has(x.op) && x.t0 > act.t0 + 1e-6)?.t0 ?? Infinity;
    const word = heard && act.t0 >= heard.from ? said.find((e) => e.t >= act.t0 - 0.004 && e.t < Math.min(nextAct, act.t0 + 1.5)) : undefined;
    let more: string[] | undefined;
    if (word) {
      const told = ms(Math.max(0, word.t - act.t0) * 1000), lead = hit ? (hit.t - word.t) * 1000 : 0;
      more = [lat > 1000 ? `yet the app reported a change ${told} after the step (${word.text}): it happened, and nothing in the recorded region showed it`
        : lead > 1.5 * period ? `the app knew first: it told accessibility ${told} after the step (${word.text}), ${ms(lead)} before the screen began to change`
        : lead < -1.5 * period ? `the screen changed first: the app told accessibility ${told} after the step (${word.text}), ${ms(-lead)} after the first visible change`
        : `the app told accessibility at the same moment the screen began to change, ${told} after the step (${word.text})`];
    }
    if (lat <= 1000) answered++;
    if (lat > 1000) P.push({ t: act.t0, sev: 0, kind: "no-response", more, text: `nothing visible changed within 1s of ${what}` });
    else P.push({ t: act.t0, sev: lat > 300 ? 2 : lat > 150 ? 1 : 0, kind: "response", more,
      text: `${lat > 150 ? `${lat > 300 ? "LAGGED" : "slow:"} first visible change ${ms(lat)} after` : `answered ${ms(lat)} after`} ${what} (from the moment the step was sent)` });
  }

  // 8. Main-thread stalls during a motion that no visible gap above accounts for: the cause, seen from inside.
  if (stalls && t0Mach) {
    const claimed = P.filter((p) => p.from !== undefined);
    let n = 0;
    for (const st of stalls.stalls) {
      const from = st.t - t0Mach, to = from + st.ms / 1000;
      if (st.ms < 2.9 * period || n >= 3 || !inWin({ t: from } as Row)) continue;
      const si = a.segments.findIndex((s) => from < s.end_s + 0.05 && to > s.start_s - 0.05);
      if (si < 0 || claimed.some((p) => from < p.to! + 0.004 && to > p.from! - 0.004)) continue;
      n++;
      P.push({ t: from, from, to, sev: 1, kind: "stall", text: `the main thread stalled ${ms(st.ms)} at ${at(from)}, around ${a.segments.length > 1 ? `motion ${si + 1}` : "the motion"}, without a matching gap on screen`, why: whyGap(stalls, t0Mach, from, to) });
    }
  }

  const lastSeg = a.segments[a.segments.length - 1], lastRow = rows.filter(inWin).pop();
  if (lastSeg && lastRow && !o.still_recording && lastRow.t - lastSeg.end_s < 3 * period / 1000 && o.to_s === undefined) {
    P.push({ t: lastSeg.end_s, sev: 0, kind: "cut", text: "still moving when the recording ended (the last motion may be cut short)" });
  }

  P.sort((x, y) => y.sev - x.sev || x.t - y.t);
  const worst = P[0]?.sev ?? 0;
  const bad = P.filter((p) => p.sev >= 1);
  const count = (kind: string, one: string, many: string) => { const n = bad.filter((p) => p.kind === kind).length; return n ? `${n} ${n > 1 ? many : one}` : ""; };
  const tally = [count("freeze", "freeze", "freezes"), count("judder", "juddering motion", "juddering motions"), count("jump", "jump", "jumps"),
    count("flash", "flash", "flashes"), count("response", "slow response", "slow responses"), count("low-rate", "low-rate motion", "low-rate motions"),
    count("wobble", "wobble", "wobbles"), count("sparse", "sparse motion", "sparse motions"), count("stall", "main-thread stall", "main-thread stalls")].filter(Boolean).join(", ");
  const o2 = a.overall;
  const grade: Seen["grade"] = !o2 && !P.length ? "still" : worst === 3 ? "broken" : worst === 2 ? "rough" : worst === 1 ? "minor" : "smooth";
  const verdict = grade === "still" ? "NOTHING MOVED in the region."
    : !o2 ? `NO ANIMATION, only instant changes (${P.filter((p) => p.kind === "pop").length} pop${P.filter((p) => p.kind === "pop").length === 1 ? "" : "s"}).${tally ? ` Also: ${tally}.` : ""}`
    : grade === "smooth" ? `LOOKED SMOOTH: ${a.segments.length} motion${a.segments.length > 1 ? "s" : ""} at ${o2.fps} fps of ${o2.target_fps}, nothing a viewer would notice${o2.pct_of_target < 90 ? " (the missing frames are spread too thin to see; the table below has them)" : ""}.`
    : `LOOKED ${grade === "broken" ? "BROKEN" : grade === "rough" ? "ROUGH" : "MOSTLY SMOOTH"}: ${tally}${grade === "minor" ? " (visible only if you look for it)" : ""} · ${o2.fps} fps of ${o2.target_fps} while moving.`;
  const toldOf = heard ? {
    from: heard.from,
    lines: said.map((e) => { const where = placeSaid(e, a.segments, actions); return `${at(e.t)} ${e.text}${where ? ` · ${where}` : ""}`; }),
    silent: !said.length && answered > 0 && actions.some((x) => x.t0 >= heard.from)
      ? `${heard.app || "the app"} told accessibility nothing while this happened (no value, focus, window, sheet, menu or announcement event): whatever the steps changed, assistive technology was not told` : undefined,
  } : undefined;
  const told = under ? underLines(under, a.segments, period) : [];
  return { grade, verdict, percepts: P, said: toldOf, under: told.length ? told : undefined };
}

/** Verdict, then what was noticed (worst first, causes indented under each), then the plain facts. */
export function formatSeen(s: Seen, max = 10): string {
  const L = [s.verdict];
  const bad = s.percepts.filter((p) => p.sev > 0), facts = s.percepts.filter((p) => p.sev === 0).sort((x, y) => x.t - y.t);
  for (const p of bad.slice(0, max)) {
    L.push(`${p.sev >= 2 ? "✗" : "~"} ${p.text}`);
    for (const w of p.why ?? []) L.push(`    ${w.startsWith(" ") ? w : `why: ${w}`}`);
    for (const m of p.more ?? []) L.push(`    ${m}`);
  }
  if (bad.length > max) L.push(`  … ${bad.length - max} more`);
  if (bad.some((p) => p.kind === "freeze" && !p.why?.length)) L.push("  (cause not measured: eye_probe {process} before recording makes the report name what held the main thread — Debug builds)");
  for (const p of facts.slice(0, max)) { L.push(`· ${p.text}`); for (const m of p.more ?? []) L.push(`    ${m}`); }
  if (facts.length > max) L.push(`  … ${facts.length - max} more`);
  if (s.said?.lines.length) {
    const n = Math.max(3, Math.min(max, 8));
    L.push(`what the app told accessibility (same clock):`);
    for (const l of s.said.lines.slice(0, n)) L.push(`  ${l}`);
    if (s.said.lines.length > n) L.push(`  … ${s.said.lines.length - n} more (events.jsonl in the run folder; eye_report view:"explain" lists them all)`);
  } else if (s.said?.silent) L.push(`· ${s.said.silent}`);
  if (s.under?.length) { L.push("under the pixels (as root: dtrace, powermetrics):"); for (const l of s.under) L.push(`  ${l}`); }
  return L.join("\n");
}
