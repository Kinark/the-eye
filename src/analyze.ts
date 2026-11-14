// Turns an eye-capture CSV into measurements of what was actually seen on screen.
//
// Row kinds (ScreenCaptureKit frame status):
//   c = complete — the compositor produced a NEW image for the region at `t`.
//   i = idle     — a refresh was observed but the region did NOT change.
// A refresh with no callback at all is "unobserved" (capture did not sample it; unknown).
// So inside an animation, idle refreshes are real visible stalls; unobserved ones are not
// counted against the app.
import { readFileSync, existsSync } from "node:fs";
import { track } from "./track.ts";

export type Row = {
  t: number; s: "c" | "i"; interval: number; diff: number; frac: number; luma: number;
  x0: number; y0: number; x1: number; y1: number; w: number; h: number;
  aw: number; ah: number; acx: number; // top-anchored extent (0 when absent)
  /** What changed since the previous frame: its box and its centre of change (mx1 = 0 when nothing did, or an old run). */
  mx0: number; my0: number; mx1: number; my1: number; mcx: number; mcy: number;
};

export type Meta = { refresh_hz?: number; [k: string]: unknown };

export function loadRun(csv: string): { rows: Row[]; meta: Meta } {
  if (!existsSync(csv)) throw new Error(`no such file: ${csv}`);
  const lines = readFileSync(csv, "utf8").split("\n");
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    if (p.length < 12) continue;
    const n = (k: number) => (p[k] === "" ? 0 : Number(p[k]));
    rows.push({ t: n(0), s: p[1] === "i" ? "i" : "c", interval: n(2), diff: n(3), frac: n(4), luma: n(5),
      x0: n(6), y0: n(7), x1: n(8), y1: n(9), w: n(10), h: n(11),
      aw: p.length > 12 ? n(12) : 0, ah: p.length > 13 ? n(13) : 0, acx: p.length > 14 ? n(14) : 0,
      mx0: p.length > 20 ? n(15) : 0, my0: p.length > 20 ? n(16) : 0, mx1: p.length > 20 ? n(17) : 0, my1: p.length > 20 ? n(18) : 0,
      mcx: p.length > 20 ? n(19) : 0, mcy: p.length > 20 ? n(20) : 0 });
  }
  let meta: Meta = {};
  try { meta = JSON.parse(readFileSync(csv + ".meta.json", "utf8")); } catch {
    // Still recording: the live file carries the clocks and the rect, so steps and events can be placed already.
    try {
      const l = JSON.parse(readFileSync(csv + ".live.json", "utf8"));
      meta = { refresh_hz: l.refresh_hz, rect_points: l.rect_points, t0_mach: l.t0_mach, t0_wall: l.t0_wall };
    } catch { /* missing */ }
  }
  return { rows, meta };
}

export type Options = {
  refresh_hz?: number;
  motion_threshold?: number; // changed-pixel fraction that counts as "visibly moving"
  drift_threshold?: number;  // mean brightness change per frame (0..255) that counts as moving when no pixel steps: a fade
  split_gap_ms?: number;     // a pause longer than this ends an animation segment
  min_frames?: number;
  from_s?: number;
  to_s?: number;
};

const q = (v: number[], p: number) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
};
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r5 = (x: number) => Math.round(x * 1e5) / 1e5; // segment bounds stay exact enough to select their own frames

export type Segment = {
  start_s: number; end_s: number; duration_ms: number;
  new_frames: number; idle_refreshes: number; unobserved_refreshes: number; expected_refreshes: number;
  fps: number; observed_rate_hz: number;
  stalled_refreshes: number; stall_pct: number;
  gap_p50_ms: number; gap_p95_ms: number; gap_max_ms: number;
  hitches: number; long_hitches: number;
  extent: { w_from: number; w_to: number; w_min: number; w_max: number; h_from: number; h_to: number; h_min: number; h_max: number };
  velocity_jumps: number;
};

export type Analysis = {
  extent_source: "top-anchored" | "bbox";
  refresh_hz: number; period_ms: number; span_s: number;
  new_frames: number; idle_refreshes: number;
  segments: Segment[];
  overall: {
    animating_ms: number; fps: number; target_fps: number; pct_of_target: number;
    stalled_refreshes: number; stall_pct: number; unobserved_refreshes: number;
    gap_p50_ms: number; gap_p95_ms: number; gap_p99_ms: number; gap_max_ms: number;
    hitches: number; long_hitches: number; hitches_per_s: number; velocity_jumps: number;
  } | null;
};

export function analyze(rows: Row[], meta: Meta, o: Options = {}): Analysis {
  const hz = o.refresh_hz ?? (typeof meta.refresh_hz === "number" ? meta.refresh_hz : 120);
  const period = 1000 / hz;
  const thr = o.motion_threshold ?? 0.0005;
  const split = (o.split_gap_ms ?? 150) / 1000;
  const minFrames = o.min_frames ?? 6;
  const win = rows.filter(r => (o.from_s === undefined || r.t >= o.from_s) && (o.to_s === undefined || r.t <= o.to_s));
  const complete = win.filter(r => r.s === "c");
  const idleRows = win.filter(r => r.s === "i");

  // Segments = runs of visibly-changing new frames.
  // A fade moves no edge: every pixel drifts by a level or two per frame, under the per-pixel step that `frac`
  // counts, and only the mean difference shows it. A run of such frames is a motion all the same (a lone one is
  // not: runs shorter than min_frames are dropped below).
  const drift = o.drift_threshold ?? 0.004;
  const moving = complete.filter(r => r.frac > thr || r.diff >= drift);
  const groups: Row[][] = [];
  let cur: Row[] = [];
  for (const r of moving) {
    if (cur.length && r.t - cur[cur.length - 1].t > split) { groups.push(cur); cur = []; }
    cur.push(r);
  }
  if (cur.length) groups.push(cur);

  // Prefer the top-anchored extent (robust to unrelated changes in the region) when recorded.
  const anchoredRun = complete.some(r => r.aw > 0);
  const WK = anchoredRun ? "aw" as const : "w" as const, HK = anchoredRun ? "ah" as const : "h" as const;
  const segs: Segment[] = [];
  for (const g of groups) {
    if (g.length < minFrames) continue;
    let a = g[0].t;
    const b = g[g.length - 1].t;
    // What led up to the motion is not the motion: a button lighting up under the press, then a pause, then the
    // animation. Following the thing itself (track.ts) says where it really began; counting from the press would
    // charge the pause to the animation as missing frames.
    {
      const span = complete.filter(r => r.t >= a - 1e-6 && r.t <= b + 1e-6);
      const tr = track(span, Number(meta.sample_step ?? 2) / Number(meta.scale ?? 2), period / 1000);
      if (tr.tracks.length && tr.elsewhere && span.length - tr.onset >= minFrames) a = span[tr.onset].t;
    }
    const durMs = (b - a) * 1000;
    if (durMs <= 0) continue;
    const inSeg = (r: Row) => r.t > a && r.t <= b;
    const newF = complete.filter(inSeg);
    const idle = idleRows.filter(inSeg).length;
    const expected = Math.round(durMs / period);
    const unobserved = Math.max(0, expected - newF.length - idle);
    const gaps = newF.map(r => r.interval).filter(x => x > 0);
    // Every refresh in the segment that did not bring a new image is a visible stall, as long as
    // the capture actually observed it (idle) — the unobserved ones are reported separately.
    const stalled = idle;
    let jumps = 0;
    const seq = [g.find(r => r.t >= a - 1e-6) ?? g[0], ...newF];
    for (let k = 2; k < seq.length; k++) {
      const d1 = Math.max(seq[k - 1].t - seq[k - 2].t, 1e-4) * 1000, d2 = Math.max(seq[k].t - seq[k - 1].t, 1e-4) * 1000;
      for (const key of [WK, HK]) {
        const v1 = (seq[k - 1][key] - seq[k - 2][key]) / d1, v2 = (seq[k][key] - seq[k - 1][key]) / d2;
        const m = Math.max(Math.abs(v1), Math.abs(v2));
        if (m > 0.05 && Math.abs(v2 - v1) > 0.6 * m) { jumps++; break; }
      }
    }
    const ws = seq.map(r => r[WK]), hs = seq.map(r => r[HK]);
    const observed = newF.length + idle;
    segs.push({
      start_s: r5(a), end_s: r5(b), duration_ms: Math.round(durMs),
      new_frames: newF.length, idle_refreshes: idle, unobserved_refreshes: unobserved, expected_refreshes: expected,
      fps: r1(newF.length / (durMs / 1000)), observed_rate_hz: r1(observed / (durMs / 1000)),
      stalled_refreshes: stalled, stall_pct: r1(observed ? (100 * stalled) / observed : 0),
      gap_p50_ms: r1(q(gaps, 0.5)), gap_p95_ms: r1(q(gaps, 0.95)), gap_max_ms: r1(Math.max(0, ...gaps)),
      hitches: gaps.filter(x => x >= 1.5 * period).length, long_hitches: gaps.filter(x => x >= 3 * period).length,
      extent: { w_from: ws[0], w_to: ws[ws.length - 1], w_min: Math.min(...ws), w_max: Math.max(...ws),
        h_from: hs[0], h_to: hs[hs.length - 1], h_min: Math.min(...hs), h_max: Math.max(...hs) },
      velocity_jumps: jumps,
    });
  }

  let overall: Analysis["overall"] = null;
  if (segs.length) {
    const ms = segs.reduce((s, x) => s + x.duration_ms, 0);
    const nf = segs.reduce((s, x) => s + x.new_frames, 0);
    const st = segs.reduce((s, x) => s + x.stalled_refreshes, 0);
    const obs = nf + st;
    const allGaps: number[] = [];
    for (const s of segs) for (const r of complete) if (r.t > s.start_s + 1e-6 && r.t <= s.end_s + 1e-6 && r.interval > 0) allGaps.push(r.interval); // not the wait before its first frame
    const hitches = segs.reduce((s, x) => s + x.hitches, 0);
    overall = {
      animating_ms: ms, fps: r1(nf / (ms / 1000)), target_fps: hz, pct_of_target: r1((100 * nf) / (ms / 1000) / hz),
      stalled_refreshes: st, stall_pct: r1(obs ? (100 * st) / obs : 0),
      unobserved_refreshes: segs.reduce((s, x) => s + x.unobserved_refreshes, 0),
      gap_p50_ms: r1(q(allGaps, 0.5)), gap_p95_ms: r1(q(allGaps, 0.95)), gap_p99_ms: r1(q(allGaps, 0.99)),
      gap_max_ms: r1(Math.max(0, ...allGaps)),
      hitches, long_hitches: segs.reduce((s, x) => s + x.long_hitches, 0), hitches_per_s: r2(hitches / (ms / 1000)),
      velocity_jumps: segs.reduce((s, x) => s + x.velocity_jumps, 0),
    };
  }
  const span = win.length ? win[win.length - 1].t - win[0].t : 0;
  return { extent_source: anchoredRun ? "top-anchored" : "bbox", refresh_hz: hz, period_ms: r2(period), span_s: r2(span), new_frames: complete.length, idle_refreshes: idleRows.length, segments: segs, overall };
}

export function formatAnalysis(a: Analysis, label: string, maxSegments = 25): string {
  const L: string[] = [];
  L.push(`# ${label}`);
  L.push(`display ${a.refresh_hz}Hz (period ${a.period_ms}ms) · span ${a.span_s}s · ${a.new_frames} new frames · ${a.idle_refreshes} idle refreshes · ${a.segments.length} animation segments · extent: ${a.extent_source}`);
  if (!a.overall) return L.join("\n");
  const o = a.overall;
  L.push("");
  L.push(`WHILE ANIMATING (${(o.animating_ms / 1000).toFixed(2)}s): ${o.fps} fps of ${o.target_fps} (${o.pct_of_target}%) · stalled refreshes ${o.stalled_refreshes} (${o.stall_pct}% of observed) · unobserved ${o.unobserved_refreshes}`);
  L.push(`frame gaps p50 ${o.gap_p50_ms} · p95 ${o.gap_p95_ms} · p99 ${o.gap_p99_ms} · max ${o.gap_max_ms} ms · hitches(≥1.5 frames) ${o.hitches} (${o.hitches_per_s}/s) · long(≥3 frames) ${o.long_hitches} · motion velocity jumps ${o.velocity_jumps}`);
  L.push("");
  L.push("  #  start_s  dur_ms  frames    fps  obs_hz  stall%  p50   p95   max  hitch long  jumps   w: from→to [min..max]   h: from→to [min..max]");
  a.segments.slice(0, maxSegments).forEach((s, i) => {
    const e = s.extent;
    L.push(`${String(i).padStart(3)} ${s.start_s.toFixed(2).padStart(8)} ${String(s.duration_ms).padStart(7)} ${String(s.new_frames).padStart(7)} ${s.fps.toFixed(1).padStart(6)} ${s.observed_rate_hz.toFixed(0).padStart(7)} ${s.stall_pct.toFixed(1).padStart(7)} ${s.gap_p50_ms.toFixed(1).padStart(5)} ${s.gap_p95_ms.toFixed(1).padStart(5)} ${s.gap_max_ms.toFixed(1).padStart(5)} ${String(s.hitches).padStart(6)} ${String(s.long_hitches).padStart(4)} ${String(s.velocity_jumps).padStart(6)}   ${e.w_from}→${e.w_to} [${e.w_min}..${e.w_max}]   ${e.h_from}→${e.h_to} [${e.h_min}..${e.h_max}]`);
  });
  if (a.segments.length > maxSegments) L.push(`  … ${a.segments.length - maxSegments} more segments`);
  return L.join("\n");
}

export function timeline(rows: Row[], binMs = 50, from?: number, to?: number): string {
  const win = rows.filter(r => (from === undefined || r.t >= from) && (to === undefined || r.t <= to));
  if (!win.length) return "no rows in window";
  const start = win[0].t, L: string[] = [];
  L.push(" t_s     new idle  maxgap  moved%   luma   anchored w×h @cx        bbox x0..x1 × y0..y1        w      h");
  let i = 0;
  for (let b = start; i < win.length; b += binMs / 1000) {
    const bin: Row[] = [];
    while (i < win.length && win[i].t < b + binMs / 1000) bin.push(win[i++]);
    const c = bin.filter(r => r.s === "c"), last = c[c.length - 1];
    const maxGap = Math.max(0, ...c.map(r => r.interval));
    const moved = c.length ? Math.max(...c.map(r => r.frac)) * 100 : 0;
    L.push(`${b.toFixed(2).padStart(6)} ${String(c.length).padStart(5)} ${String(bin.length - c.length).padStart(4)} ${maxGap.toFixed(1).padStart(7)} ${moved.toFixed(2).padStart(7)} ${last ? last.luma.toFixed(1).padStart(6) : "     -"}   ${(last && last.aw > 0 ? `${last.aw}×${last.ah} @${last.acx}` : "-").padEnd(21)} ${last ? `${last.x0}..${last.x1} × ${last.y0}..${last.y1}`.padEnd(22) : "-".padEnd(22)} ${last ? String(last.w).padStart(6) : "     -"} ${last ? String(last.h).padStart(6) : "     -"}`);
    if (L.length > 2000) { L.push("… truncated (narrow the window or widen bin_ms)"); break; }
  }
  return L.join("\n");
}

export function compare(runs: { label: string; a: Analysis }[]): string {
  const L: string[] = [];
  L.push("label                     anim_s    fps  %target  stall%  hitch/s  long  p95ms  p99ms  maxms  jumps   Δfps vs first  Δstall%");
  const base = runs[0]?.a.overall;
  for (const { label, a } of runs) {
    const o = a.overall;
    if (!o) { L.push(`${label.padEnd(24)}  (no animation detected)`); continue; }
    const dF = base ? (o.fps - base.fps).toFixed(1) : "";
    const dS = base ? (o.stall_pct - base.stall_pct).toFixed(1) : "";
    L.push(`${label.slice(0, 24).padEnd(24)} ${(o.animating_ms / 1000).toFixed(1).padStart(7)} ${o.fps.toFixed(1).padStart(6)} ${o.pct_of_target.toFixed(1).padStart(8)} ${o.stall_pct.toFixed(1).padStart(7)} ${o.hitches_per_s.toFixed(2).padStart(8)} ${String(o.long_hitches).padStart(5)} ${o.gap_p95_ms.toFixed(1).padStart(6)} ${o.gap_p99_ms.toFixed(1).padStart(6)} ${o.gap_max_ms.toFixed(1).padStart(6)} ${String(o.velocity_jumps).padStart(6)} ${dF.padStart(15)} ${dS.padStart(8)}`);
  }
  return L.join("\n");
}
