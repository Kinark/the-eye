// What one frame that holds still says about itself, measured: how big the text is and how well it stands off its
// background, what almost lines up and does not, which gaps are almost equal, what overlaps, what is cut off by the
// window, and whether a corner is a circular arc or a continuous curve. Inputs are the frame's pixels (raw sRGB RGBA
// from the capture helper) and the accessibility frames of what is in it. Pure functions; no I/O.
//
// Everything here is approximate and says so: accessibility frames are whole points, text size is read off glyph
// height through typical font proportions, a corner is fitted on a few dozen edge pixels. The numbers are for
// noticing; whether a thing is wrong stays with whoever reads them.

/** A captured frame. `x`,`y`: global points of its top-left pixel; `scale`: pixels per point. */
export type Img = { w: number; h: number; data: Uint8Array; scale: number; x: number; y: number };
/** A node of the accessibility tree JSON (`tree` op of the capture helper). */
export type AXNode = { enabled?: boolean; role?: string; subrole?: string; title?: string; description?: string; value?: unknown; identifier?: string; frame?: number[]; children?: AXNode[] };
export type AXWindow = { app?: string; cg_bounds?: number[]; tree?: AXNode | null };

export type El = {
  name: string; role: string; label: string; isText: boolean; leaf: boolean;
  x: number; y: number; w: number; h: number;
  /** Index of the nearest ancestor with a frame, -1 for a window root. */
  parent: number; win: number;
  /** Inside something that scrolls: its frame may run past what is shown, and that is normal. */
  scrolled: boolean;
  /** False only when accessibility says the control is disabled. */
  enabled: boolean;
};
export type RGB = [number, number, number];
/** size_pt is NaN when the label has nothing to stand a size on (dashes, dots, symbols). */
export type TextRead = { el: El; size_pt: number; contrast: number; fg: RGB; bg: RGB; lines: number };
export type CornerRead = { el: El; kind: "square" | "circular" | "continuous" | "capsule"; radius_pt: number; n: number; reach_pt: number };
export type Finding = { kind: "small" | "contrast" | "align" | "gaps" | "overlap" | "cut"; text: string };
export type Still = { elements: number; texts: TextRead[]; corners: CornerRead[]; findings: Finding[]; text: string };

const SCROLL_ROLES = new Set(["AXScrollArea", "AXTable", "AXOutline", "AXList", "AXBrowser", "AXWebArea", "AXCollection", "AXGrid"]);
const TEXT_ROLES = new Set(["AXStaticText", "AXTextField", "AXTextArea", "AXHeading"]);
const short = (s: string, n = 28) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const r1 = (v: number) => Math.round(v * 10) / 10;
const fmt = (v: number) => String(r1(v)).replace(/\.0$/, "");

/** Every node that has a real frame, depth first, with its nearest framed ancestor. */
export function elements(windows: AXWindow[]): El[] {
  const out: El[] = [];
  const walk = (n: AXNode, parent: number, win: number, scrolled: boolean) => {
    let me = parent;
    const f = n.frame;
    if (f && f.length === 4 && f[2] > 0 && f[3] > 0) {
      const role = n.role ?? "?";
      const label = [n.title, n.description, typeof n.value === "string" ? n.value : undefined, n.identifier].find((s) => s && s.length) ?? "";
      const kind = (n.subrole ?? role).replace(/^AX/, "");
      out.push({
        name: label ? `"${short(label)}"` : kind, role, label, isText: TEXT_ROLES.has(role),
        leaf: true, x: f[0], y: f[1], w: f[2], h: f[3], parent, win: win < 0 ? out.length : win,
        scrolled, enabled: n.enabled !== false,
      });
      me = out.length - 1;
      if (parent >= 0) out[parent].leaf = false;
    }
    const inScroll = scrolled || SCROLL_ROLES.has(n.role ?? "");
    for (const c of n.children ?? []) walk(c, me, me < 0 ? -1 : out[me].win, inScroll);
  };
  for (const w of windows) if (w.tree) walk(w.tree, -1, -1, false);
  return out;
}

// ---- pixels

const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export const luminance = (c: RGB) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
/** WCAG 2 contrast ratio, 1 to 21. */
export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
export const hex = (c: RGB) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

type PxRect = { x0: number; y0: number; x1: number; y1: number };
/** The element's frame in image pixels, clipped to the image; `seen` is the share of it that is inside. */
function pxRect(img: Img, e: { x: number; y: number; w: number; h: number }): PxRect & { seen: number } {
  const s = img.scale;
  const X0 = Math.round((e.x - img.x) * s), Y0 = Math.round((e.y - img.y) * s);
  const X1 = Math.round((e.x + e.w - img.x) * s), Y1 = Math.round((e.y + e.h - img.y) * s);
  const x0 = Math.max(0, X0), y0 = Math.max(0, Y0), x1 = Math.min(img.w, X1), y1 = Math.min(img.h, Y1);
  const full = Math.max(1, (X1 - X0) * (Y1 - Y0));
  return { x0, y0, x1, y1, seen: Math.max(0, x1 - x0) * Math.max(0, y1 - y0) / full };
}
const at = (img: Img, x: number, y: number): RGB => { const i = (y * img.w + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
const far = (a: RGB, b: RGB) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/** The colour most of a rect is painted in, and the share of the rect it covers. */
function dominant(img: Img, r: PxRect): { c: RGB; share: number } {
  const bins = new Map<number, [number, number, number, number]>();
  let n = 0;
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) {
    const i = (y * img.w + x) * 4, d = img.data;
    const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
    const b = bins.get(k);
    if (b) { b[0] += d[i]; b[1] += d[i + 1]; b[2] += d[i + 2]; b[3]++; } else bins.set(k, [d[i], d[i + 1], d[i + 2], 1]);
    n++;
  }
  let best: [number, number, number, number] = [0, 0, 0, 0];
  for (const b of bins.values()) if (b[3] > best[3]) best = b;
  return best[3] ? { c: [best[0] / best[3], best[1] / best[3], best[2] / best[3]], share: best[3] / n } : { c: [0, 0, 0], share: 0 };
}

/** Share of the em that the tallest glyphs of a label stand above the baseline (typical UI sans: SF, Helvetica, Inter). */
function glyphRise(label: string): number {
  if (/[A-Z0-9bdfhklt]/.test(label)) return 0.72; // capitals and digits ~0.70, ascenders ~0.74
  return 0.53;                                    // lowercase without ascenders: x-height
}

/** Size and contrast of a piece of text, read off its pixels. Undefined when there is no ink to read. */
export function readText(img: Img, el: El): TextRead | undefined {
  const r = pxRect(img, el);
  if (r.seen < 0.98 || r.x1 - r.x0 < 4 || r.y1 - r.y0 < 4) return undefined;
  const { c: bg, share } = dominant(img, r);
  if (share < 0.3) return undefined; // a picture or a gradient behind it: no single background to measure against
  const W = r.x1 - r.x0, H = r.y1 - r.y0;
  const dist = new Uint8Array(W * H);
  const hist = new Uint32Array(256);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.round(far(at(img, r.x0 + x, r.y0 + y), bg));
    dist[y * W + x] = d; hist[d]++;
  }
  // The stroke cores: the 2% of the rect farthest from the background (antialiased edges are nearer to it).
  let top = 255, acc = 0;
  while (top > 0 && (acc += hist[top]) < W * H * 0.02) top--;
  if (top < 10) return undefined;
  const fgSum = [0, 0, 0]; let fgN = 0;
  const rows = new Uint32Array(H), rowMax = new Uint8Array(H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = dist[y * W + x];
    if (d > rowMax[y]) rowMax[y] = d;
    if (d >= top * 0.5) rows[y]++;
    if (d >= top * 0.9) { const c = at(img, r.x0 + x, r.y0 + y); fgSum[0] += c[0]; fgSum[1] += c[1]; fgSum[2] += c[2]; fgN++; }
  }
  if (!fgN) return undefined;
  const fg: RGB = [fgSum[0] / fgN, fgSum[1] / fgN, fgSum[2] / fgN];
  // Lines of text: runs of rows that hold ink.
  const runs: [number, number][] = [];
  for (let y = 0, s = -1; y <= H; y++) {
    const ink = y < H && rows[y] > 0;
    if (ink && s < 0) s = y;
    if (!ink && s >= 0) { if (y - s >= 3) runs.push([s, y]); s = -1; }
  }
  if (!runs.length) return undefined;
  // Per line: from the top of the tallest glyph down to the baseline, the row after which the ink falls away most
  // (below it only descenders are left).
  const rises = runs.map(([a, b]) => {
    let base = b - 1, drop = -1;
    for (let y = a + Math.floor((b - a) * 0.4); y < b; y++) {
      const d = rows[y] - (y + 1 < b ? rows[y + 1] : 0);
      if (d > drop) { drop = d; base = y; }
    }
    // Sub-pixel ends: how much of the row above the top and of the row below the baseline the ink still covers.
    const part = (y: number) => (y >= 0 && y < H ? Math.min(1, rowMax[y] / top) : 0);
    const topEdge = a + 1 - Math.min(1, part(a - 1) + part(a));
    // With descenders under the baseline the rows there are theirs: no sub-pixel reading of it.
    const bottomEdge = base + 1 < b ? base + 1 : base + Math.min(1, part(base) + part(base + 1));
    return bottomEdge - topEdge;
  }).sort((p, q) => p - q);
  const rise = rises[rises.length >> 1] / img.scale;
  // A size needs letters or digits to stand on: dashes, dots and symbols have no cap height.
  const sized = (el.label.match(/[A-Za-z0-9]/g)?.length ?? 0) >= 2;
  return { el, size_pt: sized ? rise / glyphRise(el.label) : NaN, contrast: contrast(fg, bg), fg, bg, lines: runs.length };
}

/**
 * The shape of an element's top-left corner. Walks the edge of the fill inside the corner at sub-pixel precision
 * and fits a superellipse |x|^n + |y|^n = a^n to it: n = 2 is a circular arc, a continuous (squircle) corner
 * fits n well above 2 and reaches farther along the sides than its nominal radius.
 */
export function readCorner(img: Img, el: { x: number; y: number; w: number; h: number }): Omit<CornerRead, "el"> | undefined {
  // All four corners, because any one of them can have something else drawn across it; what most of them say wins.
  const got = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([fx, fy]) => readOneCorner(img, el, !!fx, !!fy)).filter((c) => !!c);
  if (!got.length) return undefined;
  const kinds = new Map<string, typeof got>();
  for (const c of got) (kinds.get(c.kind) ?? kinds.set(c.kind, []).get(c.kind)!).push(c);
  const most = [...kinds.values()].sort((a, b) => b.length - a.length)[0];
  if (most.length * 2 <= got.length && got.length > 1) return undefined; // corners that disagree: not one shape to name
  const mid = <K extends "radius_pt" | "n" | "reach_pt">(k: K) => most.map((c) => c[k]).sort((a, b) => a - b)[(most.length - 1) >> 1];
  return { kind: most[0].kind, radius_pt: mid("radius_pt"), n: mid("n"), reach_pt: mid("reach_pt") };
}

/** One corner of a frame; fx/fy pick the right/bottom one (the frame is read mirrored so the maths is always top-left). */
function readOneCorner(img: Img, el: { x: number; y: number; w: number; h: number }, fx: boolean, fy: boolean): Omit<CornerRead, "el"> | undefined {
  const r = pxRect(img, el);
  const px = (x: number, y: number): RGB => at(img, fx ? r.x1 - 1 - x : r.x0 + x, fy ? r.y1 - 1 - y : r.y0 + y);
  if (r.seen < 0.98) return undefined;
  const W = r.x1 - r.x0, H = r.y1 - r.y0, R = Math.min(Math.floor(Math.min(W, H) / 2), Math.round(MAX_CORNER_PT * img.scale));
  if (R < 6) return undefined;
  // The fill: what the middle of the corner's half is painted in.
  const m = Math.max(2, Math.floor(R / 4));
  const cx = fx ? r.x1 - R : r.x0 + R, cy = fy ? r.y1 - R : r.y0 + R;
  const fill = dominant(img, { x0: cx - m, y0: cy - m, x1: cx + m, y1: cy + m });
  if (fill.share < 0.6) return undefined;
  const out = px(0, 0);
  const axis = [fill.c[0] - out[0], fill.c[1] - out[1], fill.c[2] - out[2]];
  const len2 = axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2;
  if (len2 < 30 * 30) {
    // The corner pixel is already the fill: a square corner, if the fill really ends at this frame.
    if (r.x0 < 2 || r.y0 < 2 || r.x1 > img.w - 2 || r.y1 > img.h - 2) return undefined;
    return far(px(-2, -2), fill.c) > 30 ? { kind: "square", radius_pt: 0, n: Infinity, reach_pt: 0 } : undefined;
  }
  /** How much of the pixel is fill, 0 to 1. */
  const cover = (x: number, y: number) => {
    const c = px(x, y);
    const t = ((c[0] - out[0]) * axis[0] + (c[1] - out[1]) * axis[1] + (c[2] - out[2]) * axis[2]) / len2;
    return t < 0 ? 0 : t > 1 ? 1 : t;
  };
  // Edge position along a scan line: the outside area before the fill takes over.
  const edge = (get: (i: number) => number, lim: number) => {
    let e = 0;
    for (let i = 0, solid = 0; i < lim; i++) {
      const c = get(i);
      e += 1 - c;
      solid = c > 0.95 ? solid + 1 : 0;
      if (solid >= 2) return e;
    }
    return NaN; // never became fill: not a filled shape, or something else is drawn in the corner
  };
  const pts: [number, number][] = [];
  let reach = 0;
  for (let i = 0; i < R; i++) {
    // A scan may run to the middle of the side: a big corner in a short box takes the whole half.
    const ex = edge((x) => cover(x, i), W >> 1), ey = edge((y) => cover(i, y), H >> 1);
    // Rows read the steep half of the curve, columns the shallow half.
    if (ex <= i + 0.5) pts.push([ex, i + 0.5]);
    if (ey <= i + 0.5) pts.push([i + 0.5, ey]);
    if (ex > 0.35 || ey > 0.35) reach = i + 1; // NaN (never reached the fill) counts as not there
  }
  // The fill has to meet the frame's own sides past the curve: otherwise this is something drawn further in
  // (a child seen from its container's corner), not this frame's corner.
  const sideX = edge((x) => cover(x, R - 1), W >> 1), sideY = edge((y) => cover(R - 1, y), H >> 1);
  if (!(sideX < 1.5 && sideY < 1.5)) return undefined;
  if (pts.length < 6) return undefined;
  if (reach <= 1.5) return { kind: "square", radius_pt: 0, n: Infinity, reach_pt: 0 };
  let best = { a: 0, n: 2, err: Infinity };
  const amax = Math.min(Math.max(W, H) >> 1, 2 * R); // a big corner in a short box reaches past the short half
  const few = pts.filter((_, i) => i % Math.ceil(pts.length / 80) === 0); // enough to find the neighbourhood
  const score = (a: number, n: number, of = pts) => {
    let s = 0;
    for (const [x, y] of of) {
      const u = a - x, v = a - y;
      const d = u <= 0 || v <= 0 ? Math.min(x, y) : a * ((u / a) ** n + (v / a) ** n) ** (1 / n) - a;
      s += d * d;
    }
    return s / of.length;
  };
  // Coarse to fine: the error surface is smooth in both.
  // For each exponent the best size is one dip: bracket it on a grid, close in by golden section, keep the best pair.
  const G = (Math.sqrt(5) - 1) / 2;
  const bestSize = (n: number, of: [number, number][]) => {
    let at = 1, low = Infinity;
    const step = Math.max(0.5, amax / 64);
    for (let a = 1; a <= amax; a += step) { const e = score(a, n, of); if (e < low) { low = e; at = a; } }
    let lo = Math.max(1, at - step), hi = Math.min(amax, at + step);
    for (let i = 0; i < 16; i++) {
      const m1 = hi - G * (hi - lo), m2 = lo + G * (hi - lo);
      if (score(m1, n, of) < score(m2, n, of)) hi = m2; else lo = m1;
    }
    const a = (lo + hi) / 2;
    return { a, n, err: score(a, n, of) };
  };
  for (let n = 1.6; n <= 6.01; n += 0.1) { const b = bestSize(n, few); if (b.err < best.err) best = b; }
  const n0 = best.n;
  best.err = Infinity;
  for (let n = Math.max(1.6, n0 - 0.1); n <= n0 + 0.1001; n += 0.02) { const b = bestSize(n, pts); if (b.err < best.err) best = b; }
  if (Math.sqrt(best.err) > Math.max(0.6, best.a * 0.05)) return undefined; // not a corner of this family (a notch, a bevel, an icon)
  const s = img.scale, a = best.a / s, half = Math.min(el.w, el.h) / 2;
  const base = { n: Math.round(best.n * 100) / 100, reach_pt: reach / s };
  if (best.n < CONTINUOUS_N) {
    return Math.abs(a - half) <= Math.max(0.75, half * 0.04) ? { kind: "capsule", radius_pt: half, ...base } : { kind: "circular", radius_pt: a, ...base };
  }
  return { kind: "continuous", radius_pt: a / CONTINUOUS_REACH, ...base };
}
/** Corners are looked for within this many points of the frame's corner. */
const MAX_CORNER_PT = 64;
/** Fitted exponent above which a corner is a continuous curve, not an arc (arcs fit 2.0 ± 0.1). */
const CONTINUOUS_N = 2.25;
/** Fitted superellipse size of an Apple continuous corner, in units of its nominal cornerRadius (calibrated on the fixture). */
const CONTINUOUS_REACH = 1.35;

// ---- layout, from frames alone

const NEAR = 3;    // points: farther apart than this is a different position, not a miss
const SAME = 0.5;  // points: closer than this is the same position (frames are rounded to 0.1)
const inside = (a: El, b: El) => a.x >= b.x - SAME && a.y >= b.y - SAME && a.x + a.w <= b.x + b.w + SAME && a.y + a.h <= b.y + b.h + SAME;

export function readLayout(els: El[]): Finding[] {
  const out: Finding[] = [];
  const win = (e: El) => els[e.win];
  // What can be judged: leaves that are at least partly inside their window.
  const shown = els.filter((e) => e.leaf && e.parent >= 0 && e.x < win(e).x + win(e).w && e.x + e.w > win(e).x && e.y < win(e).y + win(e).h && e.y + e.h > win(e).y);

  for (const e of shown) {
    const w = win(e);
    const over = [
      [w.x - e.x, "left"], [e.x + e.w - (w.x + w.w), "right"], [w.y - e.y, "top"], [e.y + e.h - (w.y + w.h), "bottom"],
    ].filter(([d]) => (d as number) >= 2) as [number, string][];
    // More of it outside than in, by a long way: content that scrolls inside a view of the app's own making
    // (a picker wheel, a pager), which accessibility does not mark as scrolling. Clipped on purpose, not cut off.
    const hidden = (side: string, d: number) => d > 40 && d > 0.5 * (side === "left" || side === "right" ? Math.min(e.w, w.w) : Math.min(e.h, w.h));
    if (over.some(([d, side]) => hidden(side, d))) continue;
    if (over.length && !e.scrolled) out.push({ kind: "cut", text: `${e.name} runs ${over.map(([d, side]) => `${fmt(d)}pt past the window's ${side} edge`).join(" and ")}` });
  }

  const used = new Set<El>();
  type Miss = { odd: El; other: El; axis: "x" | "y"; edge: string; off: number; same: boolean };
  const misses: Miss[] = [];
  /** How many shown things start exactly where this one does: the one with fewer is the one that is off. */
  const peers = (e: El, p: "x" | "y") => shown.filter((o) => o.win === e.win && Math.abs(o[p] - e[p]) < SAME).length;
  // Uneven gaps: peers of one size on a shared line whose spacing is almost, but not quite, regular.
  for (const axis of ["x", "y"] as const) {
    const [p, s, q, t] = axis === "x" ? (["x", "w", "y", "h"] as const) : (["y", "h", "x", "w"] as const);
    const lines = new Map<string, El[]>();
    for (const e of shown) {
      const k = `${e.win}|${Math.round(e[q] * 2)}|${Math.round(e[t] * 2)}|${Math.round(e[s] * 2)}`;
      (lines.get(k) ?? lines.set(k, []).get(k)!).push(e);
    }
    for (const row of lines.values()) {
      if (row.length < 3) continue;
      row.sort((a, b) => a[p] - b[p]);
      const gaps = row.slice(1).map((e, i) => e[p] - (row[i][p] + row[i][s]));
      if (gaps.some((g) => g < 0)) continue;
      const lo = Math.min(...gaps), hi = Math.max(...gaps);
      if (hi - lo >= 0.75 && hi - lo <= Math.max(NEAR + 1, lo * 0.35)) {
        out.push({ kind: "gaps", text: `${row.map((e) => e.name).join(" · ")} (a ${axis === "x" ? "row" : "column"}): gaps ${gaps.map(fmt).join(", ")}pt` });
        row.forEach((e) => used.add(e));
      }
    }
  }

  for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
    const a = shown[i], b = shown[j];
    if (a.win !== b.win || inside(a, b) || inside(b, a)) continue;
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ox >= 1 && oy >= 1) {
      // Only a corner of one over a corner of the other, between siblings: a pane laid over another, a badge
      // or a scrolled row covers a whole side and is meant.
      const partial = ox < Math.min(a.w, b.w) - 1 && oy < Math.min(a.h, b.h) - 1;
      // (An unnamed group draws nothing of its own: an empty box over a button is not two things colliding.)
      const bare = (e: El) => !e.isText && !e.label && /group|hostingview|layout|unknown/i.test(`${e.role} ${e.name}`);
      if (partial && ox >= 3 && oy >= 3 && a.parent === b.parent && !a.scrolled && !b.scrolled && !bare(a) && !bare(b)) {
        out.push({ kind: "overlap", text: `${a.name} and ${b.name} share ${fmt(ox)}×${fmt(oy)}pt` });
      }
      continue;
    }
    if (used.has(a) && used.has(b)) continue;
    // Near misses. Stacked things are compared on x, things side by side on y; only neighbours count.
    for (const axis of ["x", "y"] as const) {
      const [p, s, apart] = axis === "x" ? (["x", "w", -oy] as const) : (["y", "h", -ox] as const);
      const overlapOnAxis = axis === "x" ? ox : oy;
      if (overlapOnAxis <= 0 || apart > Math.max(40, 2 * Math.min(a.h, b.h, a.w, b.w))) continue;
      const lead = b[p] - a[p], trail = b[p] + b[s] - (a[p] + a[s]), mid = (lead + trail) / 2;
      const off = [Math.abs(lead), Math.abs(trail), Math.abs(mid)];
      if (Math.min(...off) < SAME) continue; // lined up on something
      if (off[0] > NEAR) continue;
      // Only the leading edge is judged (centres and trailing edges of things of different sizes coincide by
      // chance all over a real app), and only where the intent is plain: twins, or one thing just off a line
      // that several others hold.
      const same = Math.abs(b[s] - a[s]) < SAME && a.role === b.role;
      const pa = peers(a, p), pb = peers(b, p);
      const [odd, other] = pa < pb ? [a, b] : [b, a];
      if (same || (Math.min(pa, pb) === 1 && Math.max(pa, pb) >= 3)) {
        misses.push({ odd, other, axis, edge: axis === "x" ? "left" : "top", off: off[0], same });
      }
    }
  }
  // One line per thing that is off, however many neighbours it is off from.
  const by = new Map<string, Miss[]>();
  for (const m of misses) { const k = `${els.indexOf(m.odd)}|${m.axis}`; (by.get(k) ?? by.set(k, []).get(k)!).push(m); }
  for (const g of by.values()) {
    const m = g[0], offs = [...new Set(g.map((x) => fmt(x.off)))];
    const twin = g.find((x) => x.same);
    out.push({ kind: "align", text: `${m.odd.name} ${m.edge} edge at ${m.axis} ${fmt(m.odd[m.axis])}, ${offs.join("/")}pt off ${g.slice(0, 3).map((x) => x.other.name).join(", ")}${g.length > 3 ? ` +${g.length - 3}` : ""}${twin ? ` (same ${m.axis === "x" ? "width" : "height"} as ${twin.other.name})` : ""}` });
  }
  return out;
}

// ---- the whole reading

const SMALL_PT = 10.5; // below the smallest text style macOS itself uses for reading (11pt)
const lowContrast = (t: TextRead) => t.contrast < (t.size_pt >= 18 ? 3 : 4.5);

/** Everything one still frame says, as findings and as the few lines a reply carries. */
export function still(img: Img, windows: AXWindow[], o: { maxCorners?: number; maxLines?: number } = {}): Still {
  const els = elements(windows);
  const texts = els.filter((e) => e.isText && e.label).map((e) => readText(img, e)).filter((t): t is TextRead => !!t);
  const corners: CornerRead[] = [];
  for (const e of els) {
    if (corners.length >= (o.maxCorners ?? 40)) break;
    if (e.isText || (!e.leaf && e.parent >= 0) || e.w < 12 || e.h < 12) continue;
    const c = readCorner(img, e);
    if (c) corners.push({ el: e, ...c });
  }
  const findings: Finding[] = [];
  // One finding per size and per colour pair, however many pieces of text share it.
  const names = (ts: TextRead[]) => `${ts.slice(0, 3).map((t) => t.el.name).join(", ")}${ts.length > 3 ? ` +${ts.length - 3}` : ""}`;
  const grouped = (ts: TextRead[], key: (t: TextRead) => string) => {
    const g = new Map<string, TextRead[]>();
    for (const t of ts) (g.get(key(t)) ?? g.set(key(t), []).get(key(t))!).push(t);
    return [...g.values()];
  };
  const half = (v: number) => fmt(Math.round(v * 2) / 2);
  const small = texts.filter((t) => t.size_pt < SMALL_PT).sort((a, b) => a.size_pt - b.size_pt);
  for (const g of grouped(small, (t) => half(t.size_pt))) findings.push({ kind: "small", text: `≈${half(g[0].size_pt)}pt ${names(g)}` });
  // Disabled controls are meant to be faint.
  const faint = texts.filter((t) => t.el.enabled && lowContrast(t)).sort((a, b) => a.contrast - b.contrast);
  for (const g of grouped(faint, (t) => [...t.fg, ...t.bg].map((v) => Math.round(v / 12)).join())) {
    findings.push({ kind: "contrast", text: `${fmt(g[0].contrast)}:1 ${hex(g[0].fg)} on ${hex(g[0].bg)} ${names(g)}` });
  }
  findings.push(...readLayout(els));

  const L: string[] = [];
  if (texts.length) {
    const sizes = texts.map((t) => Math.round(t.size_pt)).filter(Number.isFinite).sort((a, b) => a - b);
    const weakest = texts.reduce((a, b) => (b.contrast < a.contrast ? b : a));
    const range = !sizes.length ? "" : `, ≈${sizes[0]}${sizes[sizes.length - 1] !== sizes[0] ? `–${sizes[sizes.length - 1]}` : ""}pt`;
    L.push(`text: ${texts.length} read${range} · weakest contrast ${fmt(weakest.contrast)}:1 (${weakest.el.name})`);
  }
  const title: Record<Finding["kind"], string> = { small: "small text", contrast: "low contrast", align: "almost aligned", gaps: "uneven gaps", overlap: "overlapping", cut: "cut off" };
  const cap = o.maxLines ?? 3;
  for (const k of Object.keys(title) as Finding["kind"][]) {
    const f = findings.filter((x) => x.kind === k);
    if (!f.length) continue;
    L.push(`${title[k]}: ${f.slice(0, cap).map((x) => x.text).join(" · ")}${f.length > cap ? ` · and ${f.length - cap} more` : ""}`);
  }
  if (corners.length) {
    const say = (c: CornerRead) => c.kind === "square" ? "square" : c.kind === "capsule" ? "capsule" : `r≈${fmt(Math.round(c.radius_pt * 2) / 2)} ${c.kind === "circular" ? "circular arc" : "continuous"}`;
    const groups = new Map<string, string[]>();
    for (const c of corners) (groups.get(say(c)) ?? groups.set(say(c), []).get(say(c))!).push(c.el.name);
    const shapes = [...groups];
    L.push(`corners: ${shapes.slice(0, 6).map(([k, who]) => `${k} — ${who.slice(0, 3).join(", ")}${who.length > 3 ? ` +${who.length - 3}` : ""}`).join(" · ")}${shapes.length > 6 ? ` · and ${shapes.length - 6} more shapes` : ""}`);
  }
  const text = L.length ? `## at rest (measured off this one frame: its pixels and accessibility frames; approximate)\n${L.join("\n")}` : "";
  return { elements: els.length, texts, corners, findings, text };
}
