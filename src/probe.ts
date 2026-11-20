// In-process layer probe: geometry of every displayed frame straight from the app's own layer tree
// (presentation values = what is animating right now), no screenshots. The native half is
// swift/EyeProbe.swift, loaded into the target through a debugger (lldb, or Xcode's own session).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { sym, whyGap, type Stall, type Stalls } from "./notice.ts";
import { CURVES, bezierValue, fitMotion, formatFit, type MotionFit, type Sample } from "./physics.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout!.on("data", (d) => (stdout += d));
    c.stderr!.on("data", (d) => (stderr += d));
    const t = setTimeout(() => { c.kill("SIGTERM"); setTimeout(() => c.kill("SIGKILL"), 1000); stderr += `\n(timed out after ${timeoutMs}ms)`; }, timeoutMs);
    c.on("close", (code) => { clearTimeout(t); res({ code, stdout, stderr }); });
    c.on("error", (e) => { clearTimeout(t); res({ code: -1, stdout, stderr: String(e) }); });
  });
}

// ---- native build

let root = "";
const SRC = () => join(root, "swift", "EyeProbe.swift");
function version(): string {
  return createHash("sha1").update(readFileSync(SRC())).digest("hex").slice(0, 10);
}
async function buildProbe(): Promise<{ v: string; path: string }> {
  const v = version();
  const path = join(root, "bin", `EyeProbe_${v}.dylib`);
  if (existsSync(path)) return { v, path };
  mkdirSync(dirname(path), { recursive: true });
  // Module name carries the version: a rebuilt probe loaded next to an old one must not clash.
  const build = (out: string, target: string[]) => run("swiftc", ["-O", "-swift-version", "5", ...target, "-emit-library", "-module-name", `EyeProbe_${v}`, SRC(), "-o", out], 180_000);
  const r = await build(path, []);
  if (r.code !== 0) throw new Error(`building EyeProbe failed:\n${r.stderr}`);
  // Apple's own apps are arm64e and load nothing else: add that slice, so the probe fits them too. (Without it
  // the probe still serves every third-party app; the loader's refusal names the architecture.)
  if (process.arch === "arm64") {
    const e = `${path}.arm64e`, fat = `${path}.fat`;
    const b = await build(e, ["-target", "arm64e-apple-macos14.0"]);
    if (b.code === 0 && (await run("lipo", ["-create", path, e, "-output", fat], 30_000)).code === 0) renameSync(fat, path);
    rmSync(e, { force: true }); rmSync(fat, { force: true });
  }
  return { v, path };
}

// ---- target

type Target = { pid: number; exe: string; app?: string; bundleId?: string; sandboxed: boolean; dir: string; name: string;
  /** Set when the app is signed by a certificate we hold no key for: the probe went in signed ad hoc. */
  foreign?: string };

async function resolveTarget(proc: string | number): Promise<Target> {
  const ps = await run("/bin/ps", ["-axo", "pid=,comm="], 5000);
  const rows = ps.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(" ");
    return { pid: Number(l.slice(0, i)), exe: l.slice(i + 1).trim() };
  });
  let hit;
  if (typeof proc === "number" || /^\d+$/.test(String(proc))) hit = rows.find((r) => r.pid === Number(proc));
  else {
    const want = String(proc).toLowerCase();
    const cands = rows.filter((r) => !r.exe.includes("/debugserver") && !r.exe.includes("lldb"));
    hit = cands.find((r) => basename(r.exe).toLowerCase() === want)
      ?? cands.find((r) => r.exe.includes(".app/Contents/MacOS/") && basename(r.exe).toLowerCase().includes(want));
  }
  if (!hit) throw new Error(`no running process matches "${proc}"`);
  const m = hit.exe.match(/^(.*?\.app)\/Contents\/MacOS\//);
  const app = m?.[1];
  let bundleId: string | undefined;
  if (app) {
    const r = await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", join(app, "Contents", "Info.plist")], 5000);
    if (r.code === 0) bundleId = r.stdout.trim();
  }
  const ent = await run("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", app ?? hit.exe], 8000);
  const sandboxed = /com\.apple\.security\.app-sandbox<\/key>\s*<true/.test(ent.stdout);
  // A sandboxed app can only write inside its container, so the probe's files live there.
  const dir = sandboxed && bundleId
    ? join(homedir(), "Library", "Containers", bundleId, "Data", "Library", "Caches", "the-eye-probe")
    : join(homedir(), "Library", "Caches", "the-eye", "probe", String(hit.pid));
  mkdirSync(dir, { recursive: true });
  return { pid: hit.pid, exe: hit.exe, app, bundleId, sandboxed, dir, name: basename(hit.exe) };
}

/** Copy the probe next to the target and sign it with the target's own certificate (library validation). */
async function stageFor(t: Target, built: { v: string; path: string }): Promise<string> {
  const dest = join(t.dir, basename(built.path));
  copyFileSync(built.path, dest);
  const tmp = join(t.dir, ".certs");
  mkdirSync(tmp, { recursive: true });
  await run("/usr/bin/codesign", ["-d", `--extract-certificates=${join(tmp, "cert")}`, t.app ?? t.exe], 8000);
  let identity = "-";
  const leaf = join(tmp, "cert0");
  if (existsSync(leaf)) {
    identity = createHash("sha1").update(readFileSync(leaf)).digest("hex").toUpperCase();
    const ids = await run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], 8000);
    // Someone else's app (a release build, an App Store or system app): the probe cannot carry its signature.
    // Signed ad hoc it still loads where library validation is not enforced, which a debugger attached with
    // System Integrity Protection off brings about; elsewhere dlopen refuses it and the caller says so.
    if (!ids.stdout.toUpperCase().includes(identity)) { t.foreign = identity; identity = "-"; }
  }
  const r = await run("/usr/bin/codesign", ["-f", "-s", identity, dest], 30_000);
  if (r.code !== 0) throw new Error(`codesign failed: ${r.stderr}`);
  return dest;
}

function injectCommands(dylib: string, dir: string, v: string): string[] {
  const q = (s: string) => JSON.stringify(s);
  return [
    `expr -l c -- (void*)dlopen(${q(dylib)}, 2)`,
    `expr -l c -- ((int(*)(const char*, const char*))dlsym((void*)dlopen(${q(dylib)}, 2), "eye_probe_init"))(${q(dir)}, ${q(v)})`,
  ];
}

function readStatus(dir: string, v: string): any | null {
  try {
    const p = join(dir, `status_${v}.json`);
    const s = JSON.parse(readFileSync(p, "utf8"));
    s._age_ms = Date.now() - statSync(p).mtimeMs;
    return s;
  } catch { return null; }
}
function alive(t: Target, v: string) {
  const s = readStatus(t.dir, v);
  return !!s && s.version === v && s.pid === t.pid && s._age_ms < 2500;
}

/** Older probe versions loaded in the same process stop watching once a newer one is confirmed. */
function retireOthers(t: Target, v: string) {
  writeFileSync(join(t.dir, "control.json"), JSON.stringify({ cmd: "retire", keep: v, nonce: Math.random() }));
}

// ---- runs

type ProbeRun = { id: string; label: string; target: Target; v: string; out: string; started: number; final?: string; runDir?: string };
const runs = new Map<string, ProbeRun>();
let seq = 0;

function liveOf(r: ProbeRun): any | null {
  try { return JSON.parse(readFileSync(r.out + ".live.json", "utf8")); } catch { return null; }
}
/** Pid + name of the app the most recent running probe recording is attached to. */
export function activeProbeTarget(): { pid: number; name: string } | null {
  const r = [...runs.values()].filter((x) => !x.final).pop();
  return r ? { pid: r.target.pid, name: r.target.name } : null;
}
export async function resolvePid(proc: string | number): Promise<{ pid: number; name: string }> {
  const t = await resolveTarget(proc);
  return { pid: t.pid, name: t.name };
}
/** Live JSON of the most recent running probe recording (for eye_drive / eye_status). */
export function activeProbeLive(): any | null {
  const r = [...runs.values()].filter((x) => !x.final).pop();
  return r ? liveOf(r) : null;
}

const fmtRect = (r?: number[]) => (r ? `${r[0].toFixed(1)},${r[1].toFixed(1)} ${r[2].toFixed(1)}×${r[3].toFixed(1)}` : "-");
function fmtEntry(e: any): string {
  const cov = e.coverage !== undefined ? ` ${e.updates}/${e.frames_in_span} frames (${Math.round(e.coverage * 100)}%), max gap ${e.max_gap_ms}ms` : ` ${e.updates} updates`;
  return `  #${e.id} ${String(e.label).trim().slice(0, 90)}${e.gone ? " [gone]" : ""}\n     rect ${fmtRect(e.rect)}${e.shape ? ` · shape ${fmtRect(e.shape)}` : ""}${e.opacity !== undefined && e.opacity !== 1 ? ` · α ${e.opacity}` : ""} ·${cov}`;
}
export function describeProbeLive(l: any, max = 8): string {
  if (!l) return "probe: (no live data yet)";
  const lines = [`probe @${l.t.toFixed(1)}s · last ${l.window_s}s: ${l.ticks} ticks (${l.tick_hz.toFixed(0)}/s) · walk p50 ${l.walk_us_p50}µs max ${l.walk_us_max}µs · ${l.layers_tracked} ${l.web ? "elements" : "layers"} · ${l.moving_count} moving${l.stalls ? ` · MAIN THREAD STALLED ${l.stalls}× so far (worst ${l.stall_worst_ms}ms)` : ""}`];
  if (l.moving?.length) lines.push(` moving:`, ...l.moving.slice(0, max).map(fmtEntry));
  if (l.watched?.length) lines.push(` watched:`, ...l.watched.slice(0, max).map(fmtEntry));
  return lines.join("\n");
}

// ---- main-thread stalls (the probe's watchdog: "H" lines + their "F" frames)

/** Every stall in a probe recording, frames resolved, plus the span the watchdog covered (mach seconds). */
export function readStalls(file: string, name = "the app", pid = 0): Stalls | null {
  let head: any = null, lastT = 0;
  const frames = new Map<number, { s: string; b: string; a: number }>();
  const raw = new Map<number, any>();
  let lines: string[];
  try { lines = readFileSync(file, "utf8").split("\n"); } catch { return null; }
  for (const line of lines) {
    // Tick lines are the bulk of the file and carry nothing needed here but their time.
    if (line.startsWith('{"k":"T"')) { const m = line.match(/"t":([\d.]+)/); if (m) lastT = Number(m[1]); continue; }
    if (!line) continue;
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    if (r.k === "S") head = r;
    else if (r.k === "F") frames.set(r.i, r);
    else if (r.k === "H") raw.set(r.t, r); // an ongoing stall is rewritten: the last line for a start time wins
    else if (r.k === "E") lastT = Math.max(lastT, r.t ?? 0);
  }
  if (!head || head.stall_ms === undefined) return null; // recorded by a probe without the watchdog
  const short = (s: string) => s.replace(/\(.*?\)/g, "()").replace(/closure #\d+ in /g, "λ ").replace(/ -> .*$/, "").slice(0, 120);
  const stalls: Stall[] = [...raw.values()].sort((x, y) => x.t - y.t).map((h) => {
    if (h.lines) return { t: h.t, ms: h.ms, n: 0, app: h.app ?? [], leaf: h.leaf ?? [], stack: [], lines: h.lines }; // the page probe: scripts, not stacks
    const app = new Map<string, number>(), leaf = new Map<string, number>(), whole = new Map<string, number>();
    for (const st of h.s as number[][]) {
      const f = st.map((i) => frames.get(i) ?? { s: "?", b: "?", a: 0 });
      // Deepest frame in the app's own image = "our code that was running"; the leaf = what it was actually doing.
      const own = f.find((x) => x.a && !/^(main|\?|0x|__debug_main_executable)/.test(x.s)); // Xcode's debug-dylib stub is `main` by another name
      if (own) app.set(short(own.s), (app.get(short(own.s)) ?? 0) + 1);
      if (f[0]) { const k = `${short(f[0].s)} [${f[0].b}]`; leaf.set(k, (leaf.get(k) ?? 0) + 1); }
      const k = st.join(",");
      whole.set(k, (whole.get(k) ?? 0) + 1);
    }
    const top = (m: Map<string, number>) => [...m].sort((x, y) => y[1] - x[1]).slice(0, 4);
    const common = top(whole)[0]?.[0].split(",").map(Number) ?? [];
    return { t: h.t, ms: h.ms, n: h.n, ongoing: h.ongoing, app: top(app), leaf: top(leaf),
      stack: trimStack(common, frames).map((i) => { const x = frames.get(i); return x ? `${short(x.s)}${x.a ? "" : ` [${x.b}]`}` : "?"; }) };
  });
  return { name, pid: pid || head.pid, from: head.t, to: Math.max(lastT, head.t), threshold_ms: head.stall_ms, stacks: !!head.stacks, stalls };
}
/** Leaf → the outermost frame of the app's own code, plus the system caller that ran it; 10 frames at most. */
function trimStack(st: number[], frames: Map<number, { a: number; s: string }>): number[] {
  let last = -1;
  st.forEach((i, k) => { const f = frames.get(i); if (f?.a && !/^(main|start|\?|0x|__debug_main_executable)/.test(f.s)) last = k; }); // `main` is everyone's root, not a clue
  if (last < 0) return st.slice(0, 6);
  // Leaf side first: what it was executing, then the app's frames out to the one the system called into.
  return last + 2 <= 10 ? st.slice(0, last + 2) : [...st.slice(0, 3), ...st.slice(last - 5, last + 2)];
}
/** Save what the running (or last) probe's watchdog saw next to a capture, so its reports can say WHY. */
export function snapshotStalls(dir: string): Stalls | null {
  const r = [...runs.values()].filter((x) => !x.final).pop();
  if (!r) return null;
  const st = readStalls(r.out, r.target.name, r.target.pid);
  if (!st) return null;
  st.to += 0.15; // ticks reach the file in batches of 12
  try { writeFileSync(join(dir, "stalls.json"), JSON.stringify(st)); } catch { /* run dir gone */ }
  return st;
}
function stallSection(st: Stalls | null, t0: number, top: number, web = false, brief = false): string[] {
  if (!st) return [];
  if (!st.stalls.length) return [web ? `main thread: no animation frame over ${st.threshold_ms}ms — the page's main thread never held a frame back` : `main thread: no run-loop turn over ${st.threshold_ms}ms — the app's main thread never held a frame back`];
  const worst = [...st.stalls].sort((x, y) => y.ms - x.ms).slice(0, top);
  if (brief) return [`main-thread stalls over ${st.threshold_ms}ms: ${st.stalls.length}, ${st.stalls.reduce((s, x) => s + x.ms, 0).toFixed(0)}ms in all · worst: ${worst.map((s) => { const f = s.app?.[0]?.[0] ?? s.leaf?.[0]?.[0]; return `${s.ms >= 100 ? s.ms.toFixed(0) : s.ms.toFixed(1)}ms at ${(s.t - t0).toFixed(2)}s${f ? ` in ${sym(f, 44)}` : ""}`; }).join(" · ")}${st.stalls.length > top ? ` · … ${st.stalls.length - top} more` : ""}`];
  return [
    `main-thread stalls (${web ? "long animation frames" : "run-loop turns"} over ${st.threshold_ms}ms): ${st.stalls.length}, ${st.stalls.reduce((s, x) => s + x.ms, 0).toFixed(0)}ms in total · worst first:`,
    ...worst.flatMap((s) => whyGap({ ...st, from: -Infinity, to: Infinity, stalls: [s] }, t0, s.t - t0, s.t - t0 + s.ms / 1000).map((l) => (l.startsWith(" ") ? `  ${l}` : `- ${l}`))),
    st.stalls.length > top ? `… ${st.stalls.length - top} more` : "",
  ];
}

// ---- what moved a layer: the fit on its exact values, next to what the app declared

type Change = { t: number; v: number[]; motion: boolean };
const CHANNELS = ["x", "y", "width", "height", "opacity", "shape x", "shape y", "shape width", "shape height"];
const r2 = (x: number) => (Math.round(x * 100) / 100).toString();
const shown = (v: unknown) => (typeof v === "number" ? r2(v) : typeof v === "string" ? v.replace(/^NS(Point|Size|Rect): /, "") : "?");

/**
 * One stretch of a layer's motion as a series, one sample per display tick, on the channel that travelled furthest
 * (size before position: a thing growing about its centre moves its edge too). samples[0] is the value at rest before.
 */
export function segmentSeries(chs: Change[], seg: { a: number; b: number }, tickTimes: number[], hz: number):
  { samples: Sample[]; channel: number; cut: boolean } | null {
  const i0 = chs.findIndex((c) => c.t >= seg.a - 1e-6);
  if (i0 < 1) return null; // never seen at rest before it moved
  let i1 = i0;
  while (i1 + 1 < chs.length && chs[i1 + 1].t <= seg.b + 1e-6) i1++;
  const range = (k: number) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = i0 - 1; i <= i1; i++) { const x = chs[i].v[k]; if (x === null || x === undefined) return 0; lo = Math.min(lo, x); hi = Math.max(hi, x); }
    return hi - lo;
  };
  let channel = -1, most = 0.5;
  for (const k of [2, 3, 0, 1, 7, 8, 5, 6]) { const r = range(k); if (r > most * 1.02) { most = r; channel = k; } }
  if (channel < 0) { if (range(4) < 0.02) return null; channel = 4; }
  const next = chs[i1 + 1]?.t ?? Infinity, until = Math.min(next - 1e-6, seg.b + 0.25);
  const before = tickTimes.filter((t) => t < seg.a - 1e-6).pop() ?? seg.a - 1 / hz;
  const samples: Sample[] = [{ t: before, x: chs[i0 - 1].v[channel] }];
  let i = i0 - 1;
  for (const t of tickTimes) {
    if (t < seg.a - 1e-6) continue;
    if (t > until) break;
    while (i < i1 && chs[i + 1].t <= t + 1e-6) i++;
    samples.push({ t, x: chs[i].v[channel] });
  }
  const last = tickTimes[tickTimes.length - 1] ?? seg.b;
  return { samples, channel, cut: last - seg.b < 2.5 / hz };
}

const timing = (tf: number[] | null | undefined) => {
  if (!tf) return "linear";
  const preset = CURVES.find(([, p]) => p.every((x, i) => Math.abs(x - tf[i]) < 0.011));
  const bez = `cubic-bezier(${tf.map(r2).join(", ")})`;
  return preset ? (preset[0] === "linear" ? "linear" : `${preset[0].split(" (")[0]} = ${bez}`) : bez;
};

const CSS_EASE: Record<string, number[]> = { linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1], "ease-in": [0.42, 0, 1, 1], "ease-out": [0, 0, 0.58, 1], "ease-in-out": [0.42, 0, 0.58, 1] };
/** A CSS easing as its cubic Bézier; steps() and linear(…) are not one, so null. */
export function cssBezier(easing: unknown): number[] | null {
  const e = String(easing ?? "").trim().toLowerCase();
  if (CSS_EASE[e]) return CSS_EASE[e];
  const m = e.match(/^cubic-bezier\(\s*([-\d.e]+)\s*,\s*([-\d.e]+)\s*,\s*([-\d.e]+)\s*,\s*([-\d.e]+)\s*\)$/);
  return m ? m.slice(1).map(Number) : null;
}
const CSS_KINDS = ["CSSTransition", "CSSAnimation", "Animation"];
const isCss = (a: any) => CSS_KINDS.includes(a.cls);

/** One Core Animation animation as the app declared it, in the words its code used. */
export function describeDeclared(a: any): string {
  const on = a.kp ?? a.key ?? "?";
  const span = a.from !== null && a.from !== undefined && a.to !== null && a.to !== undefined ? ` ${shown(a.from)} → ${shown(a.to)}` : "";
  const extra = `${a.additive ? ", additive" : ""}${a.autoreverses ? ", autoreverses" : ""}${a.repeat ? `, repeats ${a.repeat === "forever" ? "forever" : `${r2(a.repeat)}×`}` : ""}${a.speed !== undefined && a.speed !== 1 ? `, speed ${r2(a.speed)}` : ""}`;
  if (isCss(a)) {
    const kind = a.cls === "CSSTransition" ? "CSS transition" : a.cls === "CSSAnimation" ? `CSS animation "${a.key}"` : "Web Animation";
    const bez = cssBezier(a.easing), name = String(a.easing ?? "linear");
    const curve = bez && !name.startsWith("cubic-bezier") && name !== "linear" ? `${name} = cubic-bezier(${bez.map(r2).join(", ")})` : name;
    return `${kind} on ${on}${span}: ${r2(a.dur)}s ${curve}${a.delay ? `, ${r2(a.delay)}s delay` : ""}${a.stops > 2 ? `, ${a.stops} keyframes` : ""}${extra}${a.compositor ? " · on the compositor: it keeps moving while the main thread is blocked" : ""}`;
  }
  if (a.cls === "CASpringAnimation" && a.mass > 0 && a.stiffness > 0) {
    const zeta = a.damping / (2 * Math.sqrt(a.stiffness * a.mass)), response = (2 * Math.PI) / Math.sqrt(a.stiffness / a.mass);
    return `CASpringAnimation on ${on}${span}: mass ${r2(a.mass)} stiffness ${r2(a.stiffness)} damping ${r2(a.damping)} = damping ratio ${r2(zeta)}, response ${r2(response)}s${a.v0 ? `, initial velocity ${r2(a.v0)}` : ""}; given ${r2(a.dur)}s to run${typeof a.settle === "number" && a.dur < a.settle * 0.8 ? ` — CUT SHORT: it needs ${r2(a.settle)}s to settle, so it snaps to the end` : ""}${extra}`;
  }
  if (a.cls === "CAAnimationGroup") return `CAAnimationGroup (${r2(a.dur)}s${extra}): ${(a.group ?? []).map(describeDeclared).join(" + ")}`;
  if (a.cls === "CAKeyframeAnimation") return `CAKeyframeAnimation on ${on}: ${a.path ? "along a path" : `${a.values} values`} over ${r2(a.dur)}s, ${a.mode}${a.keyTimes ? ` at ${a.keyTimes.map(r2).join(", ")}` : ""}${extra}`;
  if (a.cls === "CATransition") return `CATransition ${a.transition} over ${r2(a.dur)}s, ${timing(a.tf)}${extra}`;
  if (a.cls === "CABasicAnimation") return `CABasicAnimation on ${on}${span}: ${r2(a.dur)}s, ${timing(a.tf)}${extra}`;
  return `${a.cls} on ${on}: ${r2(a.dur)}s${extra}`;
}

/** Did the frames do what the code asked? Only said when one declared animation is the same kind as the fit. */
export function declaredVerdict(fit: MotionFit, declared: any[]): string | null {
  const m = fit.model;
  if (!m || fit.caveat) return null;
  const flat = declared.flatMap((a) => (a.cls === "CAAnimationGroup" ? a.group ?? [] : [a]));
  if (m.kind === "spring") {
    const s = flat.filter((a) => a.cls === "CASpringAnimation" && a.mass > 0 && a.stiffness > 0);
    if (!s.length) return flat.some((a) => a.cls === "CABasicAnimation" || isCss(a)) ? "≠ the code declared a timed animation, yet it moved like a spring: something else is driving this layer too" : null;
    const off = s.map((a) => {
      const zeta = a.damping / (2 * Math.sqrt(a.stiffness * a.mass)), response = (2 * Math.PI) / Math.sqrt(a.stiffness / a.mass);
      return { dz: Math.abs(zeta - m.zeta), dr: Math.abs(response - m.duration) / response, zeta, response };
    }).sort((p, q) => p.dz + p.dr - (q.dz + q.dr))[0];
    return off.dz <= 0.06 && off.dr <= 0.08 ? "✓ it ran as declared"
      : `≠ declared damping ratio ${r2(off.zeta)} / response ${r2(off.response)}s, but it ran as ${r2(m.zeta)} / ${r2(m.duration)}s: interrupted, retargeted mid-flight, or stacked with another animation`;
  }
  if (m.kind === "curve") {
    const c = flat.filter((a) => a.cls === "CABasicAnimation" || (isCss(a) && (a.stops ?? 2) <= 2 && (a.tf || cssBezier(a.easing))));
    if (!c.length) return null;
    const off = c.map((a) => {
      const tf: number[] = a.tf ?? cssBezier(a.easing) ?? [0, 0, 1, 1];
      let shape = 0;
      for (let p = 0.1; p < 0.95; p += 0.1) shape = Math.max(shape, Math.abs(bezierValue(tf[0], tf[1], tf[2], tf[3], p) - bezierValue(m.p[0], m.p[1], m.p[2], m.p[3], p)));
      return { shape, dd: Math.abs(a.dur - m.duration) / a.dur, a };
    }).sort((p, q) => p.shape + p.dd - (q.shape + q.dd))[0];
    return off.shape <= 0.04 && off.dd <= 0.1 ? "✓ it ran as declared"
      : `≠ declared ${r2(off.a.dur)}s ${isCss(off.a) ? off.a.easing : timing(off.a.tf)}, but it ran over ${r2(m.duration)}s${off.shape > 0.04 ? " along a different curve" : ""}: interrupted, slowed by dropped frames, or stacked with another animation`;
  }
  return null;
}

// ---- offline analysis

type Opts = { match?: string[]; from_s?: number; to_s?: number; top?: number; split_ms?: number; capture_csv?: string; layer_id?: number; max_rows?: number; name?: string; web?: boolean;
  /** The end of a session: one line per stall (their stacks are already under the freezes), one line per motion. */
  brief?: boolean };

export function analyzeProbe(file: string, o: Opts = {}): string {
  const lines = readFileSync(file, "utf8").split("\n");
  let head: any = null, end: any = null;
  const layers = new Map<number, any>();
  const ticks: { t: number; us: number; v: number }[] = [];
  const changes = new Map<number, { t: number; v: number[]; motion: boolean }[]>();
  const lastVals = new Map<number, number[]>();
  const anims = new Map<number, any[]>(); // what the app declared, per layer ("A" lines)
  for (const line of lines) {
    if (!line) continue;
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    if (r.k === "S") head = r;
    else if (r.k === "E") end = r;
    else if (r.k === "L") layers.set(r.id, r);
    else if (r.k === "A") { if (!anims.has(r.id)) anims.set(r.id, []); anims.get(r.id)!.push(r); }
    else if (r.k === "T") {
      ticks.push({ t: r.t, us: r.us, v: r.v });
      for (const g of r.g ?? []) lastVals.delete(g);
      for (const c of r.c ?? []) {
        const [id, ...v] = c;
        const prev = lastVals.get(id);
        if (!changes.has(id)) changes.set(id, []);
        changes.get(id)!.push({ t: r.t, v, motion: !!prev });
        lastVals.set(id, v);
      }
    }
  }
  if (!head) throw new Error("not a probe recording (no header)");
  let t0 = head.t, align = "probe start";
  if (o.capture_csv) {
    try { const m = JSON.parse(readFileSync(o.capture_csv + ".meta.json", "utf8")); if (m.t0_mach) { t0 = m.t0_mach; align = "capture t0 (same clock as frames.csv t)"; } } catch { /* keep */ }
  }
  const from = o.from_s !== undefined ? t0 + o.from_s : -Infinity, to = o.to_s !== undefined ? t0 + o.to_s : Infinity;
  const tk = ticks.filter((x) => x.t >= from && x.t <= to);
  const label = (id: number) => { const l = layers.get(id); return l ? [l.cls, l.view, l.name].filter(Boolean).join(" ") : `#${id}`; };
  const rel = (t: number) => (t - t0).toFixed(3);

  if (o.layer_id !== undefined) {
    const ch = (changes.get(o.layer_id) ?? []).filter((c) => c.t >= from && c.t <= to);
    const max = o.max_rows ?? 300, step = Math.max(1, Math.ceil(ch.length / max));
    const out = [`layer #${o.layer_id} ${label(o.layer_id)} · ${ch.length} changes · t relative to ${align}`, "t_s      x        y        w        h        α     | shape x  y  w  h"];
    for (let i = 0; i < ch.length; i += step) {
      const v = ch[i].v.map((n) => (n === null ? "-" : Number(n).toFixed(2)));
      out.push(`${rel(ch[i].t)}  ${v.slice(0, 5).join("  ")}  | ${v.slice(5).join("  ")}`);
    }
    return out.join("\n");
  }

  const hz = head.hz || 120;
  const intervals = tk.slice(1).map((x, i) => x.t - tk[i].t);
  const missed = intervals.filter((d) => d > 1.5 / hz).length;
  const us = tk.map((x) => x.us).sort((a, b) => a - b);
  const pct = (a: number[], p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
  const span = tk.length > 1 ? tk[tk.length - 1].t - tk[0].t : 0;
  const tickTimes = tk.map((x) => x.t);
  const ticksBetween = (a: number, b: number) => { let n = 0; for (const t of tickTimes) if (t >= a - 1e-6 && t <= b + 1e-6) n++; return n; };
  const split = (o.split_ms ?? 150) / 1000;
  const match = (o.match ?? []).map((m) => m.toLowerCase());

  const stats: any[] = [];
  for (const [id, chs] of changes) {
    if (match.length && !match.some((m) => label(id).toLowerCase().includes(m))) continue;
    const mv = chs.filter((c) => c.motion && c.t >= from && c.t <= to);
    if (!mv.length) continue;
    let travel = 0, shapeTravel = 0;
    const all = chs.filter((c) => c.t >= from && c.t <= to);
    for (let i = 1; i < all.length; i++) {
      if (!all[i].motion) continue;
      const a = all[i - 1].v, b = all[i].v;
      for (let k = 0; k < 4; k++) travel += Math.abs((b[k] ?? 0) - (a[k] ?? 0));
      for (let k = 5; k < 9; k++) if (a[k] !== null && b[k] !== null) shapeTravel += Math.abs(b[k] - a[k]);
    }
    const segs: { a: number; b: number; n: number; gap: number }[] = [];
    for (const c of mv) {
      const s = segs[segs.length - 1];
      if (s && c.t - s.b <= split) { s.gap = Math.max(s.gap, c.t - s.b); s.b = c.t; s.n++; }
      else segs.push({ a: c.t, b: c.t, n: 1, gap: 0 });
    }
    let frames = 0, upd = 0, gap = 0;
    for (const s of segs) { if (s.n < 2) continue; frames += ticksBetween(s.a, s.b); upd += s.n; gap = Math.max(gap, s.gap); }
    stats.push({ id, label: label(id), updates: mv.length, segs, chs, frames, upd, cov: frames ? upd / frames : null, gap, travel, shapeTravel, last: chs[chs.length - 1].v });
  }
  stats.sort((a, b) => b.travel + b.shapeTravel - (a.travel + a.shapeTravel));
  const top = o.top ?? 15;
  // What moved each layer: the app's own declared animations, the fit on the exact values, and whether they agree.
  const told = new Map<string, number>();
  // Everything the app's own code asked Core Animation for, on whichever layer: the same animation started again
  // (glow-1, glow-2, …) is one line with a count.
  const declaredSection = (): string[] => {
    const seen = new Map<string, { n: number; first: number; line: string }>();
    for (const [id, list] of anims) {
      if (match.length && !match.some((m) => label(id).toLowerCase().includes(m))) continue;
      for (const a of list) {
        if (a.t < from || a.t > to) continue;
        const line = `#${id} ${label(id).slice(0, 70)} · "${String(a.key).replace(/[-_]?\d+$/, "")}" ${describeDeclared(a)}`;
        const e = seen.get(line);
        if (e) e.n++; else seen.set(line, { n: 1, first: a.t, line });
      }
    }
    if (!seen.size) return [];
    const rows = [...seen.values()].sort((p, q) => p.first - q.first);
    return [o.web ? `declared by the page (CSS transitions / animations, Web Animations): ${rows.length}` : `declared by the app's code (Core Animation animations on layers): ${rows.length}`,
      ...rows.slice(0, 12).map((r) => `  ${rel(r.first)}s ${r.line}${r.n > 1 ? ` · started ${r.n}×` : ""}`),
      rows.length > 12 ? `  … ${rows.length - 12} more` : ""];
  };
  const stalls = readStalls(file, o.name ?? `pid ${head.pid}`);
  // Too few in-between values to fit: say what the layer did instead, and what the main thread was doing meanwhile.
  const leap = (ser: { samples: Sample[]; channel: number }, seg: { a: number; b: number; n: number }): string[] => {
    const x = ser.samples, travel = x[x.length - 1].x - x[0].x;
    let k = 1, lastChange = x[0].t, gap = 0;
    for (let i = 1, prev = x[0].t; i < x.length; i++) {
      if (x[i].x === x[i - 1].x) continue;
      if (Math.abs(x[i].x - x[i - 1].x) > Math.abs(x[k].x - x[k - 1].x)) { k = i; gap = x[i].t - prev; }
      prev = x[i].t; lastChange = x[i].t;
    }
    const step = x[k].x - x[k - 1].x, span = Math.max(Math.abs(travel), Math.abs(step));
    if (span < 2 || Math.abs(step) < 0.3 * span) return [];
    const hits = (stalls?.stalls ?? []).filter((h) => h.t < x[k].t + 0.004 && h.t + h.ms / 1000 > x[k].t - gap - 0.004).sort((p, q) => q.ms - p.ms);
    const hit = hits[0], blocked = hits.reduce((t, h) => t + h.ms, 0);
    const unit = ser.channel === 4 ? "" : "pt";
    return [
      `moved by: cannot be told — ${CHANNELS[ser.channel]} went ${r2(x[k - 1].x)}→${r2(x[k].x)}${unit} in ONE step at ${rel(x[k].t)}s (${Math.round((100 * Math.abs(step)) / span)}% of the way, ${Math.round(gap * 1000)}ms after its previous update): the in-between positions were never shown`,
      hit ? `  the ${o.web ? "page" : "app"}'s main thread was blocked ${hits.length > 1 ? `${hits.length}× for ${blocked.toFixed(0)}ms around that gap, longest ` : ""}${hit.ms.toFixed(1)}ms from ${rel(hit.t)}s${hit.app.length ? ` in ${sym(hit.app[0][0], 48)}` : hit.leaf.length ? ` in ${sym(hit.leaf[0][0], 48)}` : ""}: that is where they went`
        : `  ${seg.n} updates over ${Math.round((lastChange - x[0].t) * 1000)}ms: set in one go (no animation on this value), or its frames were dropped`,
    ];
  };
  const why = (s: any): string => {
    const L: string[] = [];
    const segs = [...s.segs].filter((x: any) => x.n >= 6).sort((p: any, q: any) => q.n - p.n).slice(0, 3).sort((p: any, q: any) => p.a - q.a);
    for (const seg of segs) {
      const declared = (anims.get(s.id) ?? []).filter((a) => a.t >= seg.a - 0.05 && a.t <= seg.b + 1e-6);
      const ser = segmentSeries(s.chs, seg, tickTimes, hz);
      const fit = ser ? fitMotion(ser.samples, 1 / hz, { cut: ser.cut, res: ser.channel === 4 ? 0.004 : 0.01 }) : null;
      const shownAs = { unit: ser?.channel === 4 ? " (opacity)" : "pt", from: `the ${o.web ? "element" : "layer"}'s own ${CHANNELS[ser?.channel ?? 0]}` };
      const verdict = fit && declared.length ? declaredVerdict(fit, declared) : null;
      const body = [
        ...declared.map((a) => `declared: ${describeDeclared(a)}`),
        ...(fit?.model ? formatFit(fit, shownAs) : ser && leap(ser, seg).length ? leap(ser, seg) : fit ? formatFit(fit, shownAs) : []),
        ...(verdict ? [verdict] : []),
      ];
      if (!body.length) continue;
      const key = `${seg.a.toFixed(3)}|${body.join("|")}`, first = told.get(key);
      if (first !== undefined) { L.push(`   ${rel(seg.a)}→${rel(seg.b)}s: moved exactly as #${first} did`); continue; }
      told.set(key, s.id);
      if (o.brief) L.push(`   ${rel(seg.a)}→${rel(seg.b)}s ${body.map((b) => b.trim()).join(" · ").replace(/^moved by: /, "")}`);
      else L.push(`   ${rel(seg.a)}→${rel(seg.b)}s`, ...body.map((b) => `     ${b}`));
    }
    return L.length ? "\n" + L.join("\n") : "";
  };
  const out = [
    `${o.web ? `page probe ${head.id} · ${head.url ?? ""} · browser pid ${head.pid}` : `probe ${head.id} · pid ${head.pid} · display ${head.display}`} @${hz}Hz · t relative to ${align}${end ? ` · ended: ${end.reason}` : ""}`,
    `ticks: ${tk.length} over ${span.toFixed(2)}s (${span ? (tk.length / span).toFixed(1) : 0}/s) · ${o.web ? "animation-frame" : "display-link"} gaps >1.5 frames: ${missed} · walk cost p50 ${pct(us, 0.5)}µs p95 ${pct(us, 0.95)}µs max ${us[us.length - 1] ?? 0}µs`,
    ...stallSection(stalls, t0, 5, o.web, o.brief),
    `${o.web ? "elements" : "layers"} seen: ${layers.size} · moved: ${stats.length}${match.length ? ` (matching ${o.match!.join(", ")})` : ""} · coverage = frames its geometry changed / display frames during its motion`,
    ...stats.slice(0, top).map((s) => {
      const segs = s.segs.filter((x: any) => x.n >= 2).map((x: any) => `${rel(x.a)}→${rel(x.b)}s`).slice(0, 4).join(", ");
      const head1 = `#${s.id} ${s.label.slice(0, o.brief ? 60 : 100)}`;
      const nums = `${s.updates} updates · ${s.cov === null ? "no sustained motion" : `coverage ${(s.cov * 100).toFixed(0)}% (${s.upd}/${s.frames})`} · max gap ${(s.gap * 1000).toFixed(o.brief ? 0 : 1)}ms · travel ${s.travel.toFixed(o.brief ? 0 : 1)}pt${s.shapeTravel ? ` · shape travel ${s.shapeTravel.toFixed(o.brief ? 0 : 1)}pt` : ""}`;
      if (o.brief) return `${head1} · ${nums}` + why(s);
      return `${head1}\n   ${nums}\n   motion ${segs || "-"} · now ${fmtRect(s.last.slice(0, 4))}${s.last[5] !== null && s.last[5] !== undefined ? ` · shape ${fmtRect(s.last.slice(5, 9))}` : ""}` + why(s);
    }),
    stats.length > top ? `… ${stats.length - top} more (raise top, or filter with match)` : "",
    ...declaredSection(),
    `file: ${file}`,
  ];
  return out.filter((x) => x !== "").join("\n");
}

// ---- stop (when a session ends) / peek

export function probeRunIds(): string[] { return [...runs.values()].filter((r) => !r.final).map((r) => r.id); }
export function isProbeRun(id: string) { return runs.has(id); }
export function peekProbe(id?: string, max = 8): string | null {
  const r = id ? runs.get(id) : [...runs.values()].filter((x) => !x.final).pop();
  if (!r) return null;
  if (r.final) return r.final;
  const s = readStatus(r.target.dir, r.v);
  const ended = s && s.state === "idle" && s.last?.id === r.id ? ` · ENDED (${s.last.reason}) — eye_drive {end:true} for the report` : "";
  return `${r.id} "${r.label}" · ${((Date.now() - r.started) / 1000).toFixed(1)}s${ended}\n${describeProbeLive(liveOf(r), max)}`;
}
/** Stop probe recordings (one id, or every running one) and return their reports. */
export async function stopProbes(runDir: (label?: string) => string, id?: string, o: { capture_csv?: string; match?: string[]; top?: number; brief?: boolean } = {}): Promise<string[]> {
  const list = id ? [runs.get(id)].filter(Boolean) as ProbeRun[] : [...runs.values()].filter((x) => !x.final);
  const out: string[] = [];
  for (const r of list) {
    if (r.final) { out.push(r.final); continue; }
    writeFileSync(join(r.target.dir, "control.json"), JSON.stringify({ cmd: "stop", version: r.v, nonce: Math.random() }));
    for (let i = 0; i < 30; i++) {
      const s = readStatus(r.target.dir, r.v);
      if (s?.state === "idle" && s.last?.id === r.id) break;
      await sleep(100);
    }
    await sleep(150); // let the io queue land the last lines
    const dir = runDir(r.label);
    const dest = join(dir, "probe.ndjson");
    try { copyFileSync(r.out, dest); } catch (e: any) { r.final = `${r.id}: could not read the recording: ${e.message}`; out.push(r.final); continue; }
    r.runDir = dir;
    // The complete stall log goes next to the capture it explains (eye_report summary / explain read it there).
    const st = readStalls(dest, r.target.name, r.target.pid);
    if (st) for (const d of new Set([dir, ...(o.capture_csv ? [dirname(o.capture_csv)] : [])])) { try { writeFileSync(join(d, "stalls.json"), JSON.stringify(st)); } catch { /* gone */ } }
    try { r.final = analyzeProbe(dest, { ...o, name: r.target.name }); } catch (e: any) { r.final = `could not analyze ${dest}: ${e.message}`; }
    out.push(r.final);
  }
  return out;
}

// ---- start (eye_drive puts the probe in by itself when a session opens on an app)

export function setProbeRoot(r: string) { root = r; }
export type ProbeOpts = { label?: string; display?: number; rect?: { x: number; y: number; w: number; h: number };
  match?: string[]; watch?: string[]; max_seconds?: number; max_layers?: number; full_walk?: boolean };
/** Pids the probe could not be put into, with the one-line reason: tried once per app launch, not again. */
const refused = new Map<number, string>();
/** lldb commands that load the probe, for an app Xcode is already debugging (sent through Xcode's own debugger). */
export async function probeCommands(proc: string | number): Promise<string> {
  const t = await resolveTarget(proc);
  const built = await buildProbe();
  const cmds = injectCommands(await stageFor(t, built), t.dir, built.v);
  return [`${t.name} pid ${t.pid}: send these through Xcode's debugger (tools.xcode.InvokeDebuggerCommand), in order, then open the session again:`,
    `  process interrupt`, ...cmds.map((c) => `  ${c}`), `  process continue`,
    `(If dlopen "couldn't look up symbols", the app was interrupted mid-launch: continue, wait ~2s, retry.)`].join("\n");
}
/**
 * Load the probe into the app (once per launch) and start a probe recording. `why` is one line: the session goes
 * on without it. `again` = try even though this launch refused before.
 */
export async function startProbe(proc: string | number, p: ProbeOpts = {}, again = false): Promise<{ ok: true; id: string; note: string } | { ok: false; why: string }> {
  try {
    const t = await resolveTarget(proc);
    const before = refused.get(t.pid);
    if (before && !again) return { ok: false, why: before };
    const no = (why: string) => { refused.set(t.pid, why); return { ok: false as const, why }; };
    const built = await buildProbe();
    const v = built.v;
    let loaded = "";
    if (!alive(t, v)) {
      const ppid = (await run("/bin/ps", ["-o", "ppid=", "-p", String(t.pid)], 3000)).stdout.trim();
      const parent = ppid ? (await run("/bin/ps", ["-o", "comm=", "-p", ppid], 3000)).stdout : "";
      if (parent.includes("debugserver")) return no(`${t.name} runs under Xcode's debugger, which a second debugger cannot join (probe:"xcode" prints the lldb commands to send through Xcode instead)`);
      const dylib = await stageFor(t, built);
      const args = ["--batch", "-p", String(t.pid)];
      for (const c of injectCommands(dylib, t.dir, v)) args.push("-o", c);
      args.push("-o", "process detach");
      const t0 = Date.now();
      const r = await run("lldb", args, 60_000);
      for (let i = 0; i < 20 && !alive(t, v); i++) await sleep(150);
      if (!alive(t, v)) {
        const sip = /disabled/i.test((await run("/usr/bin/csrutil", ["status"], 5000)).stdout);
        const said = (r.stdout + r.stderr).split("\n").map((l) => l.trim()).filter((l) => /error|denied|not allowed|refus|code sign|library validation/i.test(l)).pop()?.slice(0, 160);
        return no(sip ? `lldb could not load it into ${t.name}${said ? ` (${said})` : ""}`
          : `${t.name} is not a debuggable build${t.foreign ? " and is signed by someone else" : ""}: with System Integrity Protection on, the probe goes only into Debug builds (get-task-allow)${said ? ` (${said})` : ""}`);
      }
      loaded = ` (loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s)`;
    }
    retireOthers(t, v);
    const id = `probe${++seq}_${Date.now().toString(36)}`;
    const out = join(t.dir, `${id}.ndjson`);
    writeFileSync(join(t.dir, "control.json"), JSON.stringify({
      cmd: "start", version: v, id, out, display: p.display, rect: p.rect ? [p.rect.x, p.rect.y, p.rect.w, p.rect.h] : undefined,
      match: p.match, watch: p.watch, max_seconds: p.max_seconds ?? 600, max_layers: p.max_layers, full_walk: p.full_walk, nonce: Math.random(),
    }));
    const r: ProbeRun = { id, label: p.label ?? id, target: t, v, out, started: Date.now() };
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      const s = readStatus(t.dir, v);
      if (s?.state === "recording" && s.id === id) { runs.set(id, r); return { ok: true, id, note: `probe inside ${t.name}${loaded}` }; }
      if (s?.last?.error) return { ok: false, why: `the probe refused: ${s.last.error}` };
    }
    return { ok: false, why: "the probe is loaded but did not start within 2s (the app's main thread is blocked?)" };
  } catch (e: any) { return { ok: false, why: String(e.message).split("\n")[0].slice(0, 200) }; }
}

export function probeRunsStatus(): string[] {
  return [...runs.values()].map((r) => `${r.id} "${r.label}" ${r.final ? "done" : "recording"} in ${r.target.name} (pid ${r.target.pid})`);
}
