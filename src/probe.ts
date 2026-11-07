// In-process layer probe: geometry of every displayed frame straight from the app's own layer tree
// (presentation values = what is animating right now), no screenshots. The native half is
// swift/EyeProbe.swift, loaded into the target through a debugger (lldb, or Xcode's own session).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { checkInstances, claimDriver, duplicatesSchemaDescription } from "./single.ts";

type Deps = {
  root: string;
  runDir: (label?: string) => string;
  text: (t: string) => any;
  fail: (t: string) => any;
};

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
  const r = await run("swiftc", ["-O", "-swift-version", "5", "-emit-library", "-module-name", `EyeProbe_${v}`, SRC(), "-o", path], 180_000);
  if (r.code !== 0) throw new Error(`building EyeProbe failed:\n${r.stderr}`);
  return { v, path };
}

// ---- target

type Target = { pid: number; exe: string; app?: string; bundleId?: string; sandboxed: boolean; dir: string; name: string };

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
    if (!ids.stdout.toUpperCase().includes(identity)) {
      throw new Error(`the target is signed by a certificate whose private key is not in your keychain (${identity}); the probe can't be signed to pass its library validation`);
    }
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
/** Live JSON of the most recent running probe recording (for eye_act / eye_peek). */
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
  const lines = [`probe @${l.t.toFixed(1)}s · last ${l.window_s}s: ${l.ticks} ticks (${l.tick_hz.toFixed(0)}/s) · walk p50 ${l.walk_us_p50}µs max ${l.walk_us_max}µs · ${l.layers_tracked} layers · ${l.moving_count} moving`];
  if (l.moving?.length) lines.push(` moving:`, ...l.moving.slice(0, max).map(fmtEntry));
  if (l.watched?.length) lines.push(` watched:`, ...l.watched.slice(0, max).map(fmtEntry));
  return lines.join("\n");
}

// ---- offline analysis

type Opts = { match?: string[]; from_s?: number; to_s?: number; top?: number; split_ms?: number; capture_csv?: string; layer_id?: number; max_rows?: number };

export function analyzeProbe(file: string, o: Opts = {}): string {
  const lines = readFileSync(file, "utf8").split("\n");
  let head: any = null, end: any = null;
  const layers = new Map<number, any>();
  const ticks: { t: number; us: number; v: number }[] = [];
  const changes = new Map<number, { t: number; v: number[]; motion: boolean }[]>();
  const lastVals = new Map<number, number[]>();
  for (const line of lines) {
    if (!line) continue;
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    if (r.k === "S") head = r;
    else if (r.k === "E") end = r;
    else if (r.k === "L") layers.set(r.id, r);
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
    stats.push({ id, label: label(id), updates: mv.length, segs, frames, upd, cov: frames ? upd / frames : null, gap, travel, shapeTravel, last: chs[chs.length - 1].v });
  }
  stats.sort((a, b) => b.travel + b.shapeTravel - (a.travel + a.shapeTravel));
  const top = o.top ?? 15;
  const out = [
    `probe ${head.id} · pid ${head.pid} · display ${head.display} @${hz}Hz · t relative to ${align}${end ? ` · ended: ${end.reason}` : ""}`,
    `ticks: ${tk.length} over ${span.toFixed(2)}s (${span ? (tk.length / span).toFixed(1) : 0}/s) · display-link gaps >1.5 frames: ${missed} · walk cost p50 ${pct(us, 0.5)}µs p95 ${pct(us, 0.95)}µs max ${us[us.length - 1] ?? 0}µs (runs on the app's main thread)`,
    `layers seen: ${layers.size} · layers that moved: ${stats.length}${match.length ? ` (matching ${o.match!.join(", ")})` : ""}`,
    "",
    "coverage = frames this layer's geometry actually changed / display frames during its motion (100% = updated every frame).",
    ...stats.slice(0, top).map((s) => {
      const segs = s.segs.filter((x: any) => x.n >= 2).map((x: any) => `${rel(x.a)}→${rel(x.b)}s`).slice(0, 4).join(", ");
      return `#${s.id} ${s.label.slice(0, 100)}\n   ${s.updates} updates · ${s.cov === null ? "no sustained motion" : `coverage ${(s.cov * 100).toFixed(0)}% (${s.upd}/${s.frames})`} · max gap ${(s.gap * 1000).toFixed(1)}ms · travel ${s.travel.toFixed(1)}pt${s.shapeTravel ? ` · shape travel ${s.shapeTravel.toFixed(1)}pt` : ""}\n   motion ${segs || "-"} · now ${fmtRect(s.last.slice(0, 4))}${s.last[5] !== null && s.last[5] !== undefined ? ` · shape ${fmtRect(s.last.slice(5, 9))}` : ""}`;
    }),
    stats.length > top ? `… ${stats.length - top} more (raise top, or filter with match)` : "",
    `\nfile: ${file}`,
  ];
  return out.filter((x) => x !== "").join("\n");
}

// ---- stop (used by eye_stop) / peek (eye_peek)

export function probeRunIds(): string[] { return [...runs.values()].filter((r) => !r.final).map((r) => r.id); }
export function isProbeRun(id: string) { return runs.has(id); }
export function peekProbe(id?: string, max = 8): string | null {
  const r = id ? runs.get(id) : [...runs.values()].filter((x) => !x.final).pop();
  if (!r) return null;
  if (r.final) return r.final;
  const s = readStatus(r.target.dir, r.v);
  const ended = s && s.state === "idle" && s.last?.id === r.id ? ` · ENDED (${s.last.reason}) — eye_stop for the report` : "";
  return `${r.id} "${r.label}" · ${((Date.now() - r.started) / 1000).toFixed(1)}s${ended}\n${describeProbeLive(liveOf(r), max)}`;
}
/** Stop probe recordings (one id, or every running one) and return their reports. */
export async function stopProbes(runDir: (label?: string) => string, id?: string, o: { capture_csv?: string; match?: string[]; top?: number } = {}): Promise<string[]> {
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
    try { r.final = analyzeProbe(dest, o); } catch (e: any) { r.final = `could not analyze ${dest}: ${e.message}`; }
    out.push(r.final);
  }
  return out;
}

// ---- tool

export function registerProbeTools(server: any, d: Deps) {
  root = d.root;
  const { text, fail } = d;
  server.registerTool("eye_probe", {
    title: "Record layer geometry from inside an app",
    description: [
      "Load the-eye's layer probe INTO a running app (if not loaded yet) and start recording, on every display refresh, the",
      "PRESENTATION geometry (live animated values) of the app's layers: frame, opacity, shape/mask bounds, in display-local points.",
      "No pixels. Use it when you need to know WHICH layer moved/stuttered, not just that the screen did. Returns at once;",
      "eye_peek shows the live state (call ~every 0.5s while acting), eye_act can aim at layers (`on`) and read them (`L('label')`),",
      "eye_stop ends it and returns the per-layer report (aligned to a running eye_record capture automatically).",
      "Needs a debuggable target (Debug build, get-task-allow) whose signing certificate is in your keychain. If Xcode is already",
      "debugging the app, this returns lldb commands to send through Xcode's InvokeDebuggerCommand; do that and call eye_probe again.",
      "LIMIT: effects the window server renders itself (system glass, backdrops) are not in the app's layer tree.",
    ].join(" "),
    inputSchema: {
      process: z.union([z.string(), z.number()]).describe("Target app: process name (e.g. 'NOOTCH!') or pid."),
      method: z.enum(["auto", "print"]).optional().describe("print = don't run lldb, just return the attach commands (default auto)."),
      label: z.string().optional(),
      display: z.number().int().optional().describe("Display id (eye_status). Default: the main display."),
      rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional().describe("Only log layers intersecting this display-local rect (points)."),
      match: z.array(z.string()).optional().describe("Only log layers whose label (layer class, view class, name) contains one of these."),
      watch: z.array(z.string()).optional().describe("Always show these layers in the live summary, moving or not (label substrings, e.g. 'NSGlassEffectView'). Never limits what is logged; use match for that."),
      max_seconds: z.number().positive().max(600).optional().describe("Safety stop (default 60)."),
      max_layers: z.number().int().positive().optional().describe("Max layers walked per frame (default 6000)."),
      full_walk: z.boolean().optional().describe("Walk the whole layer tree every frame. Default false when match is given (the tree is re-walked every 30 frames; new layers can take up to 30 frames to appear)."),
      duplicates: z.enum(["ask", "quit_others", "relaunch", "allow"]).optional().describe(duplicatesSchemaDescription),
      app_path: z.string().optional().describe("For duplicates:\"relaunch\": the .app to start instead of the target's own."),
    },
  }, async (p: any) => {
    try {
      const busy = claimDriver("eye_probe");
      if (busy) return fail(busy);
      const c = await checkInstances(p.process, p.duplicates, p.app_path);
      if (!c.ok) return fail(c.error);
      const t = await resolveTarget(c.pid ?? p.process);
      const built = await buildProbe();
      const v = built.v;
      if (!alive(t, v)) {
        const dylib = await stageFor(t, built);
        const cmds = injectCommands(dylib, t.dir, v);
        const viaXcode = [
          `Send these through Xcode's debugger (tools.xcode.InvokeDebuggerCommand), in order, then call eye_probe again:`,
          `  process interrupt`, ...cmds.map((c) => `  ${c}`), `  process continue`,
          `(If dlopen "couldn't look up symbols", the app was interrupted mid-launch: continue, wait ~2s, retry.)`,
        ].join("\n");
        if (p.method === "print") return text(`${t.name} pid ${t.pid}\n${viaXcode}`);
        const ppid = (await run("/bin/ps", ["-o", "ppid=", "-p", String(t.pid)], 3000)).stdout.trim();
        const parent = ppid ? (await run("/bin/ps", ["-o", "comm=", "-p", ppid], 3000)).stdout : "";
        if (parent.includes("debugserver")) return text(`${t.name} (pid ${t.pid}) is already under a debugger (Xcode). The probe is NOT loaded yet.\n${viaXcode}`);
        const args = ["--batch", "-p", String(t.pid)];
        for (const c of cmds) args.push("-o", c);
        args.push("-o", "process detach");
        const r = await run("lldb", args, 60_000);
        for (let i = 0; i < 20 && !alive(t, v); i++) await sleep(150);
        if (!alive(t, v)) return fail(`lldb could not load the probe.\n${(r.stdout + r.stderr).trim().slice(-1500)}\n\nIf a debugger owns the process, or attaching needs Developer Tools access:\n${viaXcode}`);
      }
      retireOthers(t, v);
      const id = `probe${++seq}_${Date.now().toString(36)}`;
      const out = join(t.dir, `${id}.ndjson`);
      writeFileSync(join(t.dir, "control.json"), JSON.stringify({
        cmd: "start", version: v, id, out, display: p.display, rect: p.rect ? [p.rect.x, p.rect.y, p.rect.w, p.rect.h] : undefined,
        match: p.match, watch: p.watch, max_seconds: p.max_seconds ?? 60, max_layers: p.max_layers, full_walk: p.full_walk, nonce: Math.random(),
      }));
      const r: ProbeRun = { id, label: p.label ?? id, target: t, v, out, started: Date.now() };
      for (let i = 0; i < 20; i++) {
        await sleep(100);
        const s = readStatus(t.dir, v);
        if (s?.state === "recording" && s.id === id) { runs.set(id, r); return text(`${id} recording layers in ${t.name} (pid ${t.pid}) → ${out}\neye_peek every ~0.5s while acting; eye_stop {id:"${id}"} for the report.`); }
        if (s?.last?.error) return fail(`probe refused: ${s.last.error}`);
      }
      return fail("the probe did not start within 2s (is the app's main thread blocked?)");
    } catch (e: any) { return fail(e.message); }
  });
}

export function probeRunsStatus(): string[] {
  return [...runs.values()].map((r) => `${r.id} "${r.label}" ${r.final ? "done" : "recording"} in ${r.target.name} (pid ${r.target.pid})`);
}
