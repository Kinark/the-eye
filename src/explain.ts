// eye_report view:"explain": joins, on ONE clock (seconds since the first captured frame), what was SEEN (frames.csv),
// where the cursor was and what it was over (cursor.csv), what the agent was doing (actions.jsonl), and
// what the app's main thread was doing (profile.json from Instruments).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { analyze, loadRun, type Row } from "./analyze.ts";
import { loadActions as noticeActions, loadSaid, loadStalls, placeSaid, whyGap } from "./notice.ts";

type Cursor = { t: number; x: number; y: number; buttons: number; pid: number; role: string; label: string };
type Action = { t0: number; t1: number; op: string; note?: string; x?: number; y?: number };
type Profile = { start_wall: number; frames: [string, string][]; samples: [number, number[]][]; hitches: [number, number, string][] };

export type ExplainOptions = { top?: number; gap_frames?: number; app_binary?: string; from_s?: number; to_s?: number };

function loadCursor(dir: string, t0Mach: number): Cursor[] {
  const p = join(dir, "cursor.csv");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").slice(1).filter(Boolean).map((l) => {
    const c = l.split(",");
    return { t: Number(c[0]) - t0Mach, x: Number(c[1]), y: Number(c[2]), buttons: Number(c[3]), pid: Number(c[4]), role: c[5] ?? "", label: c[6] ?? "" };
  });
}
function loadActions(dir: string, t0Wall: number): Action[] {
  const p = join(dir, "actions.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
    const a = JSON.parse(l);
    return { ...a, t0: a.wall0 - t0Wall, t1: a.wall1 - t0Wall };
  });
}
function loadProfile(dir: string): Profile | null {
  const p = join(dir, "profile.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

/** Binary-search helpers over sorted time arrays. */
function lowerBound(a: number[], t: number) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < t) lo = m + 1; else hi = m; } return lo; }

const describeCursor = (c: Cursor | undefined, appPid?: number) => {
  if (!c) return "cursor ?";
  const over = c.role ? `${c.pid === appPid ? "app" : `pid ${c.pid}`} ${c.role}${c.label ? ` "${c.label}"` : ""}` : "nothing (no AX element)";
  return `cursor (${c.x.toFixed(0)},${c.y.toFixed(0)})${c.buttons ? " [button down]" : ""} over ${over}`;
};
const cursorKey = (c: Cursor | undefined) => (!c ? "?" : c.role ? `${c.role}${c.label ? ` "${c.label}"` : ""}` : "(no element)");

export function explain(csv: string, o: ExplainOptions = {}): string {
  const dir = dirname(csv);
  const { rows, meta } = loadRun(csv);
  const t0Mach = Number(meta.t0_mach ?? 0), t0Wall = Number(meta.t0_wall ?? 0);
  const hz = Number(meta.refresh_hz ?? 120), period = 1000 / hz;
  const cursor = loadCursor(dir, t0Mach);
  const actions = loadActions(dir, t0Wall);
  const prof = loadProfile(dir);
  const cT = cursor.map((c) => c.t);
  const at = (t: number) => cursor.length ? cursor[Math.max(0, Math.min(cursor.length - 1, lowerBound(cT, t) - 1))] : undefined;
  const actAt = (t: number) => actions.find((a) => t >= a.t0 - 0.004 && t <= a.t1 + 0.004);
  const appPid = cursor.find((c) => c.pid && c.label === "" && c.role)?.pid; // refined below
  const L: string[] = [];

  const a = analyze(rows, meta, { from_s: o.from_s, to_s: o.to_s });
  L.push(`# explain ${dir}`);
  L.push(a.overall
    ? `while animating: ${a.overall.fps} fps of ${hz} · hitches ${a.overall.hitches} (long ${a.overall.long_hitches}) · p95 gap ${a.overall.gap_p95_ms}ms · max ${a.overall.gap_max_ms}ms · ${a.segments.length} segments`
    : "no animation detected");
  const stalls = loadStalls(dir);
  const heard = loadSaid(dir, t0Wall);
  L.push(`sources: frames ${rows.length} · cursor samples ${cursor.length} · agent actions ${actions.length} · accessibility events ${heard ? heard.events.length : "— (recorded by process: the app's own words go on this clock)"} · main-thread stalls ${stalls ? `${stalls.stalls.length} (probe watchdog in ${stalls.name})` : "— (eye_probe {process} before recording: it times and samples every stall)"} · Instruments samples ${prof?.samples.length ?? "— (profile: {process})"}`);
  const stallLines: string[] = [];
  if (stalls?.stalls.length) {
    // Every long stall gets listed, whether or not the screen showed it as one gap: the capture can deliver
    // identical "new" frames in the middle of a freeze, which splits the gap below the threshold.
    const rel = stalls.stalls.filter((s) => { const t = s.t - t0Mach; return (o.from_s === undefined || t >= o.from_s) && (o.to_s === undefined || t <= o.to_s); });
    L.push(`main thread: ${rel.length} stall${rel.length === 1 ? "" : "s"} in this window, ${rel.reduce((x, s) => x + s.ms, 0).toFixed(0)}ms in total, worst ${Math.max(0, ...rel.map((s) => s.ms)).toFixed(1)}ms`);
    const worst = [...rel].sort((x, y) => y.ms - x.ms).filter((s) => s.ms >= 2.9 * period).slice(0, o.top ?? 5);
    if (worst.length) {
      stallLines.push("", `## longest main-thread stalls (probe watchdog in ${stalls.name})`);
      for (const s of worst) {
        const from = s.t - t0Mach;
        stallLines.push(...whyGap({ ...stalls, stalls: [s], from: -Infinity, to: Infinity }, t0Mach, from, from + s.ms / 1000).map((l) => (l.startsWith(" ") ? `  ${l}` : `- ${l}`)));
      }
    }
  }

  // Profile on the same clock.
  const samp = prof ? prof.samples.map(([w, st]) => ({ t: w - t0Wall, st })) : [];
  const sT = samp.map((s) => s.t);
  const appBin = o.app_binary ?? (prof ? guessAppBinary(prof) : "");
  const frameName = (i: number) => prof!.frames[i]?.[0] ?? "?";
  const frameBin = (i: number) => prof!.frames[i]?.[1] ?? "?";
  const sampleInterval = samp.length > 1 ? Math.max(0.0005, median(samp.slice(1, 2000).map((s, i) => s.t - samp[i].t))) : 0.001;
  function mainThread(from: number, to: number) {
    if (!prof) return null;
    const i0 = lowerBound(sT, from), i1 = lowerBound(sT, to);
    const n = i1 - i0;
    const app = new Map<string, number>(), leafBin = new Map<string, number>();
    let ax = 0;
    for (let i = i0; i < i1; i++) {
      const st = samp[i].st;
      const leaf = st[0];
      if (leaf !== undefined) leafBin.set(frameBin(leaf), (leafBin.get(frameBin(leaf)) ?? 0) + 1);
      // Deepest frame in the app's own binary = "our code that was running" (not main/stubs).
      const own = st.find((f) => frameBin(f) === appBin && !BORING.test(frameName(f)));
      if (own !== undefined) app.set(frameName(own), (app.get(frameName(own)) ?? 0) + 1);
      if (st.some((f) => /Accessibility/.test(frameName(f)))) ax++;
    }
    const busy = Math.min(100, (100 * n * sampleInterval) / Math.max(1e-6, to - from));
    return { n, busy, app: [...app].sort((x, y) => y[1] - x[1]), leafBin: [...leafBin].sort((x, y) => y[1] - x[1]), ax };
  }

  // 1. Worst on-screen gaps during animation, each fully attributed.
  const gapMin = (o.gap_frames ?? 3) * period * 0.97;
  const inSeg = (t: number) => a.segments.some((s) => t > s.start_s + 1e-6 && t <= s.end_s + 1e-6); // a segment's first frame ends the wait before it, not a gap in it
  const gaps = rows.filter((r) => r.s === "c" && r.interval >= gapMin && inSeg(r.t)).sort((x, y) => y.interval - x.interval).slice(0, o.top ?? 12);
  L.push("");
  L.push(`## worst on-screen gaps (≥${o.gap_frames ?? 3} frames) during animation`);
  if (!gaps.length) L.push("none");
  for (const g of gaps) {
    const from = g.t - g.interval / 1000;
    const act = actAt(from) ?? actAt(g.t);
    L.push(`- t=${g.t.toFixed(3)}s · ${g.interval.toFixed(1)}ms (${Math.round(g.interval / period)} frames) · ${describeCursor(at(from))}${act ? ` · during ${act.op}${act.note ? ` "${act.note}"` : ""}` : ""}`);
    for (const w of whyGap(stalls, t0Mach, from, g.t)) L.push(`    ${w}`);
    const mt = mainThread(from, g.t);
    if (mt) {
      L.push(`    main thread ${mt.busy.toFixed(0)}% busy (${mt.n} samples)${mt.ax ? ` · ${Math.round((100 * mt.ax) / Math.max(1, mt.n))}% in Accessibility` : ""} · leaf: ${mt.leafBin.slice(0, 3).map(([b, n]) => `${b} ${n}`).join(", ")}`);
      if (mt.app.length) L.push(`    ${appBin} frames: ${mt.app.slice(0, 4).map(([f, n]) => `${short(f)} ×${n}`).join(" · ")}`);
    }
    const hs = prof?.hitches.filter(([w, d]) => { const t = w - t0Wall; return t < g.t + 0.002 && t + d / 1000 > from - 0.002; }) ?? [];
    if (hs.length) L.push(`    Instruments hitches: ${hs.map(([, d, s]) => `${d}ms${s ? ` "${s}"` : ""}`).join(", ")}`);
  }

  L.push(...stallLines);

  // What the app itself said, on the same clock: each word against the step before it and the motion around it.
  if (heard) {
    const said = heard.events.filter((e) => (o.from_s === undefined || e.t >= o.from_s) && (o.to_s === undefined || e.t <= o.to_s));
    const acts = noticeActions(dir, t0Wall);
    L.push("", `## what ${heard.app || "the app"} told accessibility (listening from ${heard.from.toFixed(3)}s)`);
    if (!said.length) L.push("nothing");
    for (const e of said.slice(0, 60)) {
      const where = placeSaid(e, a.segments, acts);
      L.push(`- t=${e.t.toFixed(3)}s · ${e.text}${where ? ` · ${where}` : ""} · ${describeCursor(at(e.t))}`);
    }
    if (said.length > 60) L.push(`  … ${said.length - 60} more (events.jsonl)`);
  }

  // 2. Smoothness by what the cursor was over, and by agent action.
  const groups = (keyOf: (t: number) => string) => {
    const m = new Map<string, { dur: number; frames: number; hitches: number; worst: number }>();
    for (const s of a.segments) {
      const fr = rows.filter((r) => r.s === "c" && r.t > s.start_s && r.t <= s.end_s);
      for (const r of fr) {
        const k = keyOf(r.t - r.interval / 2000);
        const g = m.get(k) ?? { dur: 0, frames: 0, hitches: 0, worst: 0 };
        g.dur += r.interval / 1000; g.frames++; if (r.interval >= 1.5 * period) g.hitches++; g.worst = Math.max(g.worst, r.interval);
        m.set(k, g);
      }
    }
    return [...m].filter(([, g]) => g.dur > 0.15).sort((x, y) => y[1].dur - x[1].dur);
  };
  const fmtGroups = (title: string, gs: ReturnType<typeof groups>) => {
    L.push(""); L.push(title);
    for (const [k, g] of gs.slice(0, 12)) L.push(`- ${k.padEnd(44).slice(0, 44)} ${g.dur.toFixed(2).padStart(6)}s animating · ${(g.frames / g.dur).toFixed(1).padStart(5)} fps · ${(g.hitches / g.dur).toFixed(1).padStart(5)} hitches/s · worst ${g.worst.toFixed(1)}ms`);
  };
  if (cursor.length) fmtGroups("## smoothness by what the cursor was over", groups((t) => cursorKey(at(t))));
  if (actions.length) fmtGroups("## smoothness by agent action", groups((t) => { const x = actAt(t); return x ? `${x.op}${x.note ? ` "${x.note}"` : ""}` : "(between actions)"; }));

  // 3. Suspects: app frames over-represented on the main thread during gaps vs. the rest of the animation.
  if (prof && a.segments.length) {
    const inGap = new Map<string, number>(), outGap = new Map<string, number>();
    let nIn = 0, nOut = 0;
    const gapWins = rows.filter((r) => r.s === "c" && r.interval >= 1.5 * period && inSeg(r.t)).map((r) => [r.t - r.interval / 1000, r.t] as const);
    for (const s of a.segments) {
      for (let i = lowerBound(sT, s.start_s); i < samp.length && samp[i].t <= s.end_s; i++) {
        const t = samp[i].t;
        const g = gapWins.some(([f, e]) => t >= f && t <= e);
        const names = new Set(samp[i].st.filter((f) => frameBin(f) === appBin && !BORING.test(frameName(f))).map(frameName));
        for (const c of categorize(samp[i].st.map(frameName))) names.add(`[${c}]`);
        if (g) nIn++; else nOut++;
        for (const n of names) (g ? inGap : outGap).set(n, ((g ? inGap : outGap).get(n) ?? 0) + 1);
      }
    }
    // Kind-of-work breakdown (a sample can count in several kinds — they nest).
    L.push("");
    L.push(`## main-thread work by kind during animation (share of samples; dropped-frame windows vs. smooth)`);
    for (const k of CATEGORIES.map(([n]) => n)) {
      const pin = (inGap.get(`[${k}]`) ?? 0) / Math.max(1, nIn), pout = (outGap.get(`[${k}]`) ?? 0) / Math.max(1, nOut);
      if (pin + pout < 0.01) continue;
      L.push(`- ${k.padEnd(28)} ${(100 * pin).toFixed(0).padStart(3)}% in gaps · ${(100 * pout).toFixed(0).padStart(3)}% smooth`);
    }
    for (const k of [...inGap.keys()]) if (k.startsWith("[")) { inGap.delete(k); outGap.delete(k); }
    const rowsOut = [...inGap].map(([n, c]) => ({ n, pin: c / Math.max(1, nIn), pout: (outGap.get(n) ?? 0) / Math.max(1, nOut) }))
      .filter((x) => x.pin > 0.03).sort((x, y) => (y.pin - y.pout) - (x.pin - x.pout)).slice(0, 10);
    L.push("");
    L.push(`## ${appBin} code on the main thread: during dropped frames vs. smooth frames (${nIn} vs ${nOut} samples)`);
    for (const r of rowsOut) L.push(`- ${short(r.n).padEnd(70).slice(0, 70)} ${(100 * r.pin).toFixed(0).padStart(3)}% of gap samples vs ${(100 * r.pout).toFixed(0).padStart(3)}% otherwise`);
    const axAll = samp.filter((s) => s.st.some((f) => /Accessibility/.test(frameName(f)))).length;
    L.push(`accessibility work: ${((100 * axAll) / Math.max(1, samp.length)).toFixed(1)}% of all main-thread samples (an AX client — e.g. this tool's cursor element lookups — makes SwiftUI maintain its accessibility graph)`);
  }
  return L.join("\n");
}

const BORING = /^(main|DYLD-STUB|__swift_|specialized _ArrayBuffer|outlined |\?|_hidden#)/;
/** Coarse kinds of main-thread work, matched anywhere in a sample's stack. */
const CATEGORIES: [string, RegExp][] = [
  ["event handling", /sendEvent|_handleMouse|mouseMoved|scrollWheel|NSTrackingArea|_routeEvent|dispatchEvent/],
  ["SwiftUI view body", /\.body\.getter/],
  ["SwiftUI layout", /sizeThatFits|placeSubviews|LayoutComputer|ViewLayoutEngine|lengthThatFits|explicitAlignment|_layout|UnaryLayout|StackLayout/],
  ["AttributeGraph update", /AG::Graph|AGGraph|AG::Subgraph|updateValue/],
  ["accessibility", /Accessibility/],
  ["NSView/AppKit layout", /NSView.*(layout|updateConstraints|_layoutSubtree)|NSHostingView.*layout|layoutSubtreeIfNeeded/],
  ["display list / render", /DisplayList|RenderBox|ViewGraphRootValueUpdater\.render|updateDisplayList/],
  ["CA commit / layers", /CA::Transaction|CA::Context|CA::Layer|CALayer/],
  ["glass (app)", /Glass|SDF|Backdrop/],
  ["text", /CoreText|TextKit|NSTextView|NSLayoutManager|CRichText|AttributedString/],
  ["SwiftData / CoreData", /SwiftData|NSManagedObject|PersistentModel|ModelContext|CoreData/],
  ["timers / runloop", /CFRunLoopTimer|__CFRunLoopDoTimer|DisplayLink|CVDisplayLink/],
];
function categorize(names: string[]): Set<string> {
  const s = new Set<string>();
  for (const [k, re] of CATEGORIES) if (names.some((n) => re.test(n))) s.add(k);
  return s;
}

function guessAppBinary(p: Profile): string {
  const c = new Map<string, number>();
  for (const [, st] of p.samples.slice(0, 5000)) for (const f of st) {
    const b = p.frames[f]?.[1] ?? "";
    if (b && !/^(lib|Swift|AttributeGraph|CoreFoundation|AppKit|QuartzCore|Foundation|Combine|CoreGraphics|Metal|dyld|HIToolbox|SkyLight|CoreAnimation|IOKit|CoreText|CoreServices|\?)/.test(b) && !b.endsWith(".dylib")) c.set(b, (c.get(b) ?? 0) + 1);
  }
  return [...c].sort((x, y) => y[1] - x[1])[0]?.[0] ?? "";
}
function median(v: number[]) { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; }
function short(f: string) { return f.replace(/\(.*?\)/g, "()").replace(/closure #\d+ in /g, "λ ").slice(0, 110); }
export type { Row };
