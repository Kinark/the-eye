#!/usr/bin/env node
// the-eye — an MCP server that lets an agent SEE and MEASURE what is on a macOS screen over time: per-frame
// timing and motion (pixels → numbers), what UI element is under the pointer and the element tree of the
// observed windows (Accessibility), and, optionally, layer geometry from inside an app (probe.ts).
// Native capture, input and AX live in bin/eye-capture (swift/EyeCapture.swift).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, compare, formatAnalysis, loadRun, timeline, type Options } from "./analyze.ts";
import { explain } from "./explain.ts";
import {
  activeProbeLive, activeProbeTarget, analyzeProbe, describeProbeLive, isProbeRun, peekProbe, probeRunIds, probeRunsStatus,
  registerProbeTools, resolvePid, stopProbes,
} from "./probe.ts";
import { claimDriver, driverStatus, duplicatesSchemaDescription, ensureSingleInstance, releaseDriver, startLeaseHeartbeat } from "./single.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "eye-capture");
const SRC = join(ROOT, "swift", "EyeCapture.swift");
const RUNS = process.env.THE_EYE_DIR ?? join(homedir(), "Library", "Caches", "the-eye", "runs");

function ensureBinary() {
  const stale = !existsSync(BIN) || (existsSync(SRC) && statSync(SRC).mtimeMs > statSync(BIN).mtimeMs);
  if (!stale) return;
  mkdirSync(dirname(BIN), { recursive: true });
  const r = spawnSync("swiftc", ["-O", "-swift-version", "5", SRC, "-o", BIN], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`building eye-capture failed:\n${r.stderr}`);
}

type Rect = { x: number; y: number; w: number; h: number };
const rectArg = (r: Rect) => `${r.x},${r.y},${r.w},${r.h}`;

const rectSchema = z.object({
  x: z.number().describe("left, display-local points"),
  y: z.number().describe("top, display-local points (0 = top of screen, menu bar/notch)"),
  w: z.number().positive(),
  h: z.number().positive(),
}).describe("Screen region in display-local POINTS, top-left origin. Keep it tight around what you want to measure.");

const profileSchema = z.object({
  process: z.string().describe("App process name or pid to attach Instruments to (e.g. 'NOOTCH!')."),
  template: z.string().optional().describe("Instruments template (default 'Time Profiler')."),
  hitches: z.boolean().optional().describe("Add the Hitches instrument (default true)."),
  keep_trace: z.boolean().optional().describe("Keep the raw .trace (default false: it embeds the app's environment, which may contain secrets)."),
}).optional().describe("Also record Instruments on the app and align it with the frames (eye_report view:'explain'). Starting xctrace takes a few seconds.");

const treeSchema = z.enum(["none", "basic", "full"]);
const axOpts = {
  ax: z.boolean().optional().describe("Accessibility context: log the element under the pointer (live + hover.jsonl) and snapshot the element tree of the observed windows. Default true, false when `profile` is set. COST: makes SwiftUI apps maintain their AX graph (~18% more main-thread time, up to −25% fps) — set false for final fps numbers and A/B comparisons."),
  ax_hz: z.number().optional().describe("Hover hit-tests per second when ax is on (default 10)."),
  tree: treeSchema.optional().describe("Element tree of the observed windows at start: basic (labeled elements + bounds, default when ax on), full (every node + actions), none."),
  process: z.string().optional().describe("Focus the AX tree on this app (name or pid). Default: whatever is actually visible in rect."),
  cursor: z.boolean().optional().describe("Log the pointer position to cursor.csv (default true; false also disables ax)."),
};

const analysisOpts = {
  motion_threshold: z.number().optional().describe("Fraction of sampled pixels that must change for a frame to count as 'moving' (default 0.0005)."),
  split_gap_ms: z.number().optional().describe("A pause longer than this splits animation segments (default 150)."),
  refresh_hz: z.number().optional().describe("Override the display refresh rate used as the target (default: from capture metadata)."),
};

function runDir(label?: string) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = (label ?? "run").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60);
  const d = join(RUNS, `${ts}_${safe}`);
  mkdirSync(d, { recursive: true });
  return d;
}

// ---- capture / trace / lock processes

type Capture = {
  id: string; label: string; dir: string; csv: string; child: ChildProcess; done: Promise<string>; started: number;
  trace?: Trace; profileNote?: string; stopping?: boolean;
};
const captures = new Map<string, Capture>();
/** `ready` resolves true once the countdown is over and input is actually blocked (false if the helper died). */
type Lock = { id: string; child: ChildProcess; done: Promise<string>; ready: Promise<boolean>; until: number };
const locks = new Map<string, Lock>();
const finishedLocks: string[] = []; // reports of locks that ended on their own (timeout / Esc)
const diedCaptures: string[] = [];
let seq = 0;

function collect(child: ChildProcess): Promise<string> {
  return new Promise((res) => {
    let out = "", err = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("close", (code) => res(code === 0 ? out.trim() : `${out}\n${err}`.trim() || `exited ${code}`));
    child.on("error", (e) => res(`spawn error: ${e.message}`));
  });
}

type ProfileOpts = { process: string; template?: string; hitches?: boolean; keep_trace?: boolean };
type Trace = { child: ChildProcess; path: string; ready: Promise<string>; done: Promise<string>; keep: boolean; log: string[] };

function startCapture(p: {
  rect: Rect; display?: number; seconds: number; label?: string; fps?: number; keyframe_ms?: number;
  profile?: ProfileOpts; cursor?: boolean; ax_hz?: number;
}): Capture {
  ensureBinary();
  const dir = runDir(p.label);
  const csv = join(dir, "frames.csv");
  const args = ["capture", "--rect", rectArg(p.rect), "--seconds", String(p.seconds), "--out", csv];
  if (p.display !== undefined) args.push("--display", String(p.display));
  if (p.fps) args.push("--fps", String(p.fps));
  if (p.keyframe_ms) args.push("--keyframes-dir", join(dir, "keyframes"), "--keyframe-ms", String(p.keyframe_ms));
  if (p.cursor === false) args.push("--cursor", "off");
  args.push("--ax-hz", String(p.ax_hz ?? 0));
  const child = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  const id = `cap${++seq}`;
  const c: Capture = { id, label: p.label ?? id, dir, csv, child, done: collect(child), started: Date.now() };
  if (p.profile) c.trace = startTrace(dir, p.profile, p.seconds + 15);
  captures.set(id, c);
  c.done.then((msg) => {
    // Ended on its own (not via eye_stop): keep why, so the next call can say so.
    if (captures.has(id) && !c.stopping) diedCaptures.push(`${id} "${c.label}" ended after ${((Date.now() - c.started) / 1000).toFixed(1)}s: ${msg.slice(-600)}`);
  }).finally(() => captures.delete(id));
  return c;
}

/** Instruments alongside the capture: Time Profiler (+ Hitches) attached to the app. */
function startTrace(dir: string, p: ProfileOpts, limitS: number): Trace {
  const path = join(dir, "trace.trace");
  const args = ["xctrace", "record", "--template", p.template ?? "Time Profiler", "--attach", p.process,
    "--output", path, "--time-limit", `${Math.ceil(limitS)}s`, "--no-prompt"];
  if (p.hitches !== false) args.splice(4, 0, "--instrument", "Hitches");
  const child = spawn("xcrun", args, { stdio: ["ignore", "pipe", "pipe"] });
  const log: string[] = [];
  const ready = new Promise<string>((res) => {
    const on = (d: Buffer) => { const s = String(d); log.push(s); if (/Ctrl-C to stop|Starting recording/i.test(s)) res("recording"); };
    child.stdout!.on("data", on); child.stderr!.on("data", on);
    child.on("close", (code) => res(`xctrace exited ${code}: ${log.join("").slice(-400)}`));
    setTimeout(() => res("xctrace slow to start (continuing)"), 15000);
  });
  return { child, path, ready, done: new Promise((r) => child.on("close", () => r(log.join("")))), keep: !!p.keep_trace, log };
}

/** Run a command without blocking the event loop (a spawnSync on a wedged helper freezes EVERY tool). */
function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    const t = setTimeout(() => { stderr += `\n${cmd.split("/").pop()} timed out after ${timeoutMs}ms — killed`; child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(t); res({ code, stdout, stderr }); });
    child.on("error", (e) => { clearTimeout(t); res({ code: -1, stdout, stderr: `${stderr}\n${e.message}` }); });
  });
}

/** Signal a child and wait for it, escalating to SIGKILL after `ms` so a wedged helper can never hang a tool call. */
async function endChild<T>(child: ChildProcess, done: Promise<T>, sig: NodeJS.Signals, ms: number): Promise<{ out: T; killed: boolean }> {
  if (child.exitCode !== null || child.signalCode !== null) return { out: await done, killed: false };
  child.kill(sig);
  let killed = false;
  const t = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, ms);
  const out = await done;
  clearTimeout(t);
  return { out, killed };
}

async function stopCapture(c: Capture) {
  c.stopping = true;
  const { out, killed } = await endChild(c.child, c.done, "SIGTERM", 6000);
  if (killed) c.profileNote = `${c.profileNote ?? ""}\nWARNING: capture helper did not exit on SIGTERM and was killed${existsSync(c.csv + ".meta.json") ? "" : " (no meta written)"}`.trim();
  if (c.trace) {
    const t = c.trace;
    await endChild(t.child, t.done, "SIGINT", 30000);
    if (existsSync(t.path)) {
      const r = await run("python3", [join(ROOT, "scripts", "xctrace_summary.py"), t.path, join(c.dir, "profile.json")], 180_000);
      c.profileNote = `${c.profileNote ? c.profileNote + "\n" : ""}${r.code === 0 ? `profile: ${r.stdout.trim()}` : `profile export failed: ${r.stderr.slice(-300)}`}`;
      // Traces embed the attached process's ENVIRONMENT (may hold secrets) — keep only if asked.
      if (!t.keep && r.code === 0) rmSync(t.path, { recursive: true, force: true });
    } else c.profileNote = `no trace written: ${t.log.join("").slice(-300)}`;
  }
  return out;
}

const LOCK_COUNTDOWN_MS = 1500;
/** Every lock blocks ALL physical input (pointer, gestures, keyboard) and shows the orange overlay. */
function startLock(seconds: number, allow: "synthetic" | "tagged"): Lock {
  ensureBinary();
  const args = ["lock", "--seconds", String(seconds), "--allow", allow];
  const child = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  const id = `lock${++seq}`;
  // The helper shows a 3·2·1 warning (0.5s per number) and then prints "locked" on stderr.
  const ready = new Promise<boolean>((res) => {
    let err = "";
    child.stderr?.on("data", (d) => { err += d; if (err.includes("locked for")) res(true); });
    child.on("close", () => res(false));
    setTimeout(() => res(child.exitCode === null), 6000);
  });
  const l: Lock = { id, child, done: collect(child), ready, until: Date.now() + LOCK_COUNTDOWN_MS + seconds * 1000 };
  locks.set(id, l);
  l.done.then((r) => { finishedLocks.unshift(`${id}: ${r}`); finishedLocks.length = Math.min(finishedLocks.length, 10); })
    .finally(() => locks.delete(id));
  return l;
}
async function stopLock(l: Lock) {
  return (await endChild(l.child, l.done, "SIGTERM", 3000)).out;
}

function report(csv: string, label: string, opts: Options, maxSegments?: number) {
  const { rows, meta } = loadRun(csv);
  return formatAnalysis(analyze(rows, meta, opts), label, maxSegments);
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- input + AX actor: one persistent native process (eye-capture input), JSON lines in/out

let actor: { child: ChildProcess; pending: ((s: string) => void)[]; buf: string; binMtime: number } | null = null;
function inputActor() {
  ensureBinary();
  const binMtime = statSync(BIN).mtimeMs;
  // A process killed by a signal keeps exitCode null (signalCode is set): check both.
  if (actor && actor.child.exitCode === null && actor.child.signalCode === null) {
    // A rebuilt binary must replace the running actor, or fixes never reach it. Swap only when idle.
    if (actor.binMtime === binMtime || actor.pending.length) return actor;
    actor.child.kill("SIGTERM");
  }
  const child = spawn(BIN, ["input"], { stdio: ["pipe", "pipe", "pipe"] });
  const a = { child, pending: [] as ((s: string) => void)[], buf: "", binMtime };
  child.stdout!.on("data", (d) => {
    a.buf += d;
    let i;
    while ((i = a.buf.indexOf("\n")) >= 0) { const line = a.buf.slice(0, i); a.buf = a.buf.slice(i + 1); a.pending.shift()?.(line); }
  });
  child.stdin!.on("error", () => {}); // EPIPE after the actor died is answered via actorSend's write callback
  child.on("close", () => { if (actor === a) actor = null; for (const p of a.pending.splice(0)) p(JSON.stringify({ ok: false, error: "input actor exited" })); });
  actor = a;
  return a;
}
async function actorSend(cmd: object, extraMs = 0): Promise<any> {
  const r = await actorSendOnce(cmd, extraMs);
  // The actor was already dead when we wrote (killed, crashed): the command never ran, so retry once on a fresh one.
  if (r?.ok === false && /input actor gone/.test(String(r.error))) return actorSendOnce(cmd, extraMs);
  return r;
}
function actorSendOnce(cmd: object, extraMs = 0): Promise<any> {
  const a = inputActor();
  const budget = 10_000 + extraMs + Number((cmd as any).ms ?? 0) + 50 * Number((cmd as any).events ?? 0);
  return new Promise((res) => {
    let done = false;
    const answer = (line: string) => { if (done) return; done = true; clearTimeout(t); try { res(JSON.parse(line)); } catch { res({ ok: false, error: line }); } };
    // If the actor wedges (or is already dead), kill it, drop it and answer anyway: the next call respawns it.
    const t = setTimeout(() => {
      a.child.kill("SIGKILL");
      if (actor === a) actor = null;
      answer(JSON.stringify({ ok: false, error: `input actor did not answer within ${budget}ms (restarted)` }));
    }, budget);
    a.pending.push(answer);
    a.child.stdin!.write(JSON.stringify(cmd) + "\n", (e) => { if (e) { if (actor === a) actor = null; answer(JSON.stringify({ ok: false, error: `input actor gone: ${e.message}` })); } });
  });
}

// ---- AX formatting

const fr = (f?: number[]) => (f ? ` [${f[0].toFixed(0)},${f[1].toFixed(0)} ${f[2].toFixed(0)}×${f[3].toFixed(0)}]` : "");
/** Last `n` path segments, unlabeled layout groups dropped (the element itself always stays). */
const tailPath = (p: string, n: number) => {
  const all = p.split(" › ");
  const s = all.filter((x, i) => i === all.length - 1 || !/^(Group|Unknown|LayoutArea|ScrollArea|SplitGroup)(\/\w+)?$/.test(x));
  return s.length > n || s.length < all.length ? `… › ${s.slice(-n).join(" › ")}` : p;
};
/** One line: `NOOTCH! › … › Group › Button "Camera" [743,233 125×125] (focused) {Press}`. */
function hoverLine(h: any, segs = 4): string {
  if (!h) return "nothing (no accessibility element)";
  const flags = [h.enabled === false && "disabled", h.focused && "focused", h.selected && "selected"].filter(Boolean).join(",");
  const id = h.identifier && !String(h.path ?? "").includes(h.identifier) ? ` #${h.identifier}` : "";
  return `${h.app ?? `pid ${h.pid}`} › ${tailPath(h.path ?? h.role ?? "?", segs)}${id}${fr(h.frame)}${flags ? ` (${flags})` : ""}${h.actions?.length ? ` {${h.actions.join(",")}}` : ""}`;
}
/** Everything the element exposes, readable. */
function hoverFull(h: any): string {
  if (!h) return "nothing (no accessibility element under that point)";
  const { path, ancestors, attributes, parameterized_attributes, ...core } = h;
  const L = [`${h.app ?? "?"} (pid ${h.pid}${h.bundle_id ? `, ${h.bundle_id}` : ""})`, `path: ${path ?? "?"}`, `element: ${JSON.stringify(core)}`];
  if (attributes) L.push(`other attributes: ${JSON.stringify(attributes)}`);
  if (parameterized_attributes) L.push(`parameterized attributes: ${parameterized_attributes.join(", ")}`);
  if (ancestors?.length) L.push("ancestors (nearest first):", ...ancestors.map((a: any) => `  ${JSON.stringify(a)}`));
  return L.join("\n");
}

/** The element tree of the windows in a display-local rect (or under a point); full JSON saved to `out`. */
async function axTree(o: { rect?: Rect; display?: number; x?: number; y?: number; process?: string; mode: "basic" | "full"; depth?: number; max_nodes?: number; out?: string; clip?: boolean }) {
  const r = await actorSend({
    op: "tree", rect: o.rect ? [o.rect.x, o.rect.y, o.rect.w, o.rect.h] : undefined, display: o.display, x: o.x, y: o.y,
    process: o.process, mode: o.mode, depth: o.depth, max_nodes: o.max_nodes, out: o.out, clip: o.clip,
  }, 20_000);
  if (!r.ok) return { ok: false, text: `AX tree failed: ${r.error}`, nodes: 0 };
  return { ok: true, text: String(r.text), nodes: Number(r.nodes ?? 0) };
}
function capLines(s: string, n: number, more: string) {
  const l = s.split("\n");
  return l.length > n ? `${l.slice(0, n).join("\n")}\n… ${l.length - n} more lines — ${more}` : s;
}

/** Hover changes during a run, from hover.jsonl, on the frames clock. */
function hoverTimeline(csv: string, max = 30, from?: number, to?: number): string {
  const p = join(dirname(csv), "hover.jsonl");
  if (!existsSync(p)) return "";
  let t0 = 0;
  try { t0 = JSON.parse(readFileSync(csv + ".meta.json", "utf8")).t0_mach ?? 0; } catch { /* still recording */ }
  const lines: string[] = [];
  let last = "";
  for (const l of readFileSync(p, "utf8").split("\n")) {
    if (!l) continue;
    let r: any; try { r = JSON.parse(l); } catch { continue; }
    const t = t0 ? r.t - t0 : r.t;
    if ((from !== undefined && t < from) || (to !== undefined && t > to)) continue;
    const d = hoverLine(r.hover, 3);
    if (d === last) continue;
    last = d;
    lines.push(`${t0 ? t.toFixed(2) + "s" : "?"} ${r.kind === "update" ? "~" : "→"} ${d}`);
  }
  if (!lines.length) return "";
  const h = Math.floor(max / 2);
  const shown = lines.length > max ? [...lines.slice(0, h), `… ${lines.length - max} more (eye_report {view:"hover"})`, ...lines.slice(-h)] : lines;
  return `## what the pointer was over (accessibility; → new element, ~ same element changed; times on the frames clock)\n${shown.join("\n")}`;
}

// ---- recordings (one Job per eye_record call; command optional)

type Job = {
  id: string; label: string; capture: Capture; rect: Rect; display?: number; process?: string; ax: boolean;
  lock?: Lock; cmd?: ChildProcess; command?: string; output: string[]; started: number;
  state: "starting" | "running" | "finishing" | "done"; exitCode?: number | null; lockResult?: string;
  stopped?: string; final?: string; finished: Promise<string>; opts: Options; tree?: string; treeFile?: string;
  stopNow: () => void;
};
const jobs = new Map<string, Job>();
const liveFile = (c: Capture) => c.csv + ".live.json";
function readLive(c: Capture): any | null {
  try { return JSON.parse(readFileSync(liveFile(c), "utf8")); } catch { return null; }
}
const running = (j: Job) => j.state !== "done";

type RecordParams = {
  rect: Rect; label?: string; display?: number; fps?: number; keyframe_ms?: number; profile?: ProfileOpts;
  ax?: boolean; ax_hz?: number; tree?: "none" | "basic" | "full"; process?: string; cursor?: boolean;
  command?: string; cwd?: string; lock_input?: boolean; pre_ms?: number; post_ms?: number; timeout_s?: number;
  seconds?: number; max_seconds?: number; background?: boolean;
} & Options;

function startJob(p: RecordParams): Job {
  const hasCmd = !!p.command;
  const limit = hasCmd ? (p.timeout_s ?? 300) : (p.seconds ?? p.max_seconds ?? 300);
  const ax = p.cursor !== false && (p.ax ?? !p.profile);
  const c = startCapture({ rect: p.rect, display: p.display, label: p.label, keyframe_ms: p.keyframe_ms, fps: p.fps,
    seconds: hasCmd ? limit + 30 : limit, profile: p.profile, cursor: p.cursor, ax_hz: ax ? (p.ax_hz ?? 10) : 0 });
  let stopNow!: () => void;
  const stopReq = new Promise<void>((r) => (stopNow = r));
  const id = `run${++seq}`;
  const job: Job = { id, label: p.label ?? id, capture: c, rect: p.rect, display: p.display, process: p.process, ax, command: p.command,
    output: [], started: Date.now(), state: "starting", finished: null as any, opts: p, stopNow };
  jobs.set(id, job);
  job.finished = (async () => {
    if (c.trace) job.output.push(`Instruments: ${await c.trace.ready}`);
    job.lock = p.lock_input ? startLock(limit + 10, "synthetic") : undefined;
    const pre = sleep(p.pre_ms ?? (hasCmd ? 500 : 0));
    // ScreenCaptureKit can take seconds to start: never run the command (or report "recording") before frames
    // are on disk. The helper itself gives up after 8s.
    for (let i = 0; i < 95 && c.child.exitCode === null && !(existsSync(c.csv) && statSync(c.csv).size > 200); i++) await sleep(100);
    if (c.child.exitCode === null && !existsSync(c.csv)) { c.child.kill("SIGTERM"); await c.done; }
    if (c.child.exitCode !== null || c.child.signalCode !== null) {
      if (job.lock) job.lockResult = await stopLock(job.lock);
      job.state = "done"; job.final = `capture failed: ${await c.done}`;
      return job.final;
    }
    const treeMode = p.tree ?? (ax ? "basic" : "none");
    if (treeMode !== "none" && !job.stopped) {
      job.treeFile = join(c.dir, "ax_tree_start.json");
      const t = await axTree({ rect: p.rect, display: p.display, process: p.process, mode: treeMode, out: job.treeFile });
      job.tree = t.text;
      if (t.ok) writeFileSync(join(c.dir, "ax_tree_start.txt"), t.text);
    }
    await pre;
    if (job.lock) await job.lock.ready;
    if (!job.stopped) {
      job.state = "running";
      if (hasCmd) {
        job.cmd = spawn("/bin/zsh", ["-lc", p.command!], {
          cwd: p.cwd, stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, THE_EYE_LIVE: liveFile(c), THE_EYE_RECT: rectArg(p.rect), THE_EYE_RUN_DIR: c.dir },
        });
        const push = (d: Buffer) => {
          for (const line of String(d).split("\n")) if (line.trim()) job.output.push(`${((Date.now() - job.started) / 1000).toFixed(1)}s ${line}`);
          if (job.output.length > 400) job.output.splice(0, job.output.length - 400);
        };
        job.cmd.stdout!.on("data", push);
        job.cmd.stderr!.on("data", push);
        const killer = setTimeout(() => { job.stopped ??= "timeout"; job.cmd?.kill("SIGTERM"); }, limit * 1000);
        job.exitCode = await new Promise((r) => job.cmd!.on("close", r));
        clearTimeout(killer);
      } else {
        await Promise.race([c.done, stopReq]);
      }
    }
    if (job.lock) job.lockResult = await stopLock(job.lock);
    job.state = "finishing";
    if (hasCmd && !job.stopped) await sleep(p.post_ms ?? 1000);
    const helperOut = await stopCapture(c);
    let body: string;
    try { body = report(c.csv, c.label, job.opts); }
    catch (e: any) { body = `${c.label}: could not analyze (${e.message})${existsSync(c.csv) ? "" : `\ncapture helper said: ${String(helperOut).slice(-600)}`}`; }
    const tail = job.output.slice(-15).join("\n");
    const hv = ax ? hoverTimeline(c.csv) : "";
    job.final = [
      hasCmd ? `${job.stopped ? `STOPPED (${job.stopped}) · ` : ""}command exit ${job.exitCode ?? "-"}${job.lockResult ? ` · input lock: ${job.lockResult}` : ""}` : (job.stopped && job.stopped !== "stopped by agent" ? `STOPPED (${job.stopped})` : ""),
      tail ? `command output (tail):\n${tail}` : "",
      body,
      ax ? "NOTE: recorded with accessibility inspection ON (ax) — on SwiftUI apps fps can read lower than without it. Use ax:false for final numbers." : "",
      hv,
      c.profileNote ?? "",
      `run: ${c.dir}\ncsv: ${c.csv}${job.treeFile && existsSync(job.treeFile) ? `\nAX tree at start: ${job.treeFile.replace(/json$/, "txt")}` : ""}${ax ? `\nhover log: ${join(c.dir, "hover.jsonl")}` : ""}`,
    ].filter(Boolean).join("\n\n");
    job.state = "done";
    return job.final;
  })();
  return job;
}

function describeLive(live: any): string {
  if (!live) return "live: (no data yet)";
  const l = live.last_1s ?? {};
  const e = live.changed_extent_screen, a = live.anchored_screen;
  const anch = a ? `top-anchored: x ${a.x0.toFixed(0)}..${a.x1.toFixed(0)} (${a.w.toFixed(0)}pt wide), hangs ${a.h.toFixed(0)}pt down` : "top-anchored: nothing changed at the top edge";
  const ext = e ? `any change: x ${e.x0.toFixed(0)}..${e.x1.toFixed(0)}, y ${e.y0.toFixed(0)}..${e.y1.toFixed(0)}` : "region identical to first frame";
  const hp = live.hover_point;
  const hov = live.ax ? `\n  pointer${hp ? ` (${hp[0].toFixed(0)},${hp[1].toFixed(0)})` : ""} over: ${hoverLine(live.hover)}` : "";
  return `live @${live.t.toFixed(1)}s: ${live.moving ? "MOVING" : "still"} · last 1s: ${l.new_frames} new frames, ${l.idle} idle, max gap ${Number(l.max_gap_ms).toFixed(1)}ms, ${l.hitches} hitches\n  ${anch} · ${ext}${hov}`;
}

function activeJob(id?: string): Job | undefined {
  if (id) return jobs.get(id);
  return [...jobs.values()].filter(running).pop();
}

// ---- server

const INSTRUCTIONS = `
the-eye: see and measure what a macOS screen shows, over time. Three kinds of evidence, all on one clock:
1. PIXELS AS NUMBERS: per displayed frame, whether the region showed a new image, the gap since the last one, how much changed, and the size/position of what changed. Answers "is this animation smooth?", "did my change help?", "how wide is the panel right now?". Reports give real on-screen fps vs the display refresh, stalls, hitches and velocity jumps.
2. ACCESSIBILITY (AX) CONTEXT: what UI element is under the pointer (role, label, identifier, value, frame, enabled/focused/selected, actions, every other attribute, ancestors, app, window), and the element TREE of the observed windows with each element's bounds. Answers "what am I looking at?", "where is the X button?", "what was the pointer over when the frame dropped?".
3. LAYER GEOMETRY from inside an app (eye_probe; Debug builds only): which layer moved or stuttered, per frame, no pixels.

USE IT BY DEFAULT: this is how you test a macOS app's UI (SwiftUI or AppKit) yourself. After a UI change builds, launch the app and verify it here: find the element, drive it, measure what happened, and report numbers. Don't hand the check to the user ("try it and tell me", "report what you feel"). Only skip the-eye when the user says they'll drive the test.

WHEN TO USE WHAT
- Find UI / coordinates: eye_inspect {rect} for the element tree of what's visible there, or eye_inspect {} for the element under the pointer. Use the frames it returns as eye_act x/y.
- A still image: eye_snapshot {rect}. Don't record for a static look.
- An animation you trigger yourself, step by step: eye_record {rect, label} (returns an id at once, with the AX tree) → eye_act {target_process, steps} (after EVERY step: pointer, element under it, visible extent, fps) → eye_stop → report.
- A scripted, repeatable run (A/B): eye_record {rect, command:"./drive", lock_input:true, ax:false, label:"A"} (blocks, returns the report), repeat for B, then eye_report {view:"compare", runs:[...]}.
- Only when the user says they'll drive the test themselves: ask "Ready?" and wait for yes, then eye_record {rect, label} with NO input lock, let them act, eye_stop. The report lists what the pointer was over over time; eye_report {view:"explain"} ties the worst frames to the cursor/element/main thread.
- Long background runs: eye_record {..., background:true} → eye_peek every few seconds → eye_stop early if it goes wrong.
- Re-analyze any run later: eye_report {csv, view: summary|timeline|explain|hover} or {runs, view:"compare"}. Keyframe images: eye_snapshot {csv, t_s} (record with keyframe_ms).

KNOW THESE
- Coordinates are POINTS, top-left origin. rect is display-local (eye_status lists displays). Pointer, AX frames and eye_act x/y are global; on the main display both are the same.
- AX costs performance: an AX client makes SwiftUI apps rebuild their accessibility graph (~18% more main-thread time, up to −25% fps). eye_record has ax on by default (off with profile). For final fps numbers or A/B comparisons use ax:false, and compare runs recorded the same way. Reports say when AX was on.
- eye_act input is synthetic. It reaches apps through a different path than a physical trackpad (event taps, hover shields and pointer-location APIs can see it differently). If a bug doesn't reproduce with eye_act, vary it yourself (speeds, phased vs unphased scroll, hover paths, a CGEvent driver via eye_record command) and report what you tried and what each run measured.
- The pointer position in live data / cursor.csv comes from the window server. An app whose event tap swallows mouse moves (e.g. NOOTCH!'s hover shield over the notch) freezes it, so live hover can lag; eye_act's p is the position it actually posted.
- The measured extent (a, e) is a pixel difference. Translucent glass over a similar background can measure smaller than the real view: for true bounds use AX frames (eye_inspect, h.frame), and keep wait_until thresholds loose.
- eye_act safety: presses only land on target_process (name or pid, or the app of a running eye_probe); scrolls only inside the measured open area or a scroll_zones rect. Every lock (eye_act's automatic one, eye_record lock_input, eye_lock) blocks ALL physical input: trackpad, mouse, gestures, keyboard, media keys, and it pins the cursor. Each lock starts with a 1.5s on-screen 3·2·1 warning (0.5s per number); calls wait for it, so budget ~1.5s per eye_act call that takes its own lock (a session eye_lock pays it once). The orange overlay shows exactly while one is held. The user's only way out is Esc 6× in a row, ≤1s apart (emergency; the overlay shows the count). Never lock while the user should be acting.
- ONE AT A TIME. Only one agent session drives the screen: eye_act, eye_lock, eye_record and eye_probe take a shared lease (renewed by each call, kept while a recording/lock/probe runs, released 60s after your last driving call or when your session ends). Another session gets "BUSY …": wait and retry, don't fight it. Read-only tools always work. eye_status shows who holds it.
- ONE APP COPY. eye_act (target_process / probe target), eye_probe and eye_record {process} refuse when the target app runs more than once (an Xcode run + an \`open\`, a stale launch): presses and measurements could hit the wrong copy. Pass duplicates:"quit_others" to keep the newest (or the pid you named) and quit the rest. Before launching the app yourself, check it isn't already running.
- Needs Screen Recording (capture) and Accessibility (AX, input, lock) permission for the host app.
- Run files live in ~/Library/Caches/the-eye/runs/<time>_<label>/: frames.csv, cursor.csv, hover.jsonl, ax_tree_start.txt/.json, actions.jsonl, keyframes/.

TOOLS: eye_status · eye_inspect · eye_snapshot · eye_record · eye_peek · eye_act · eye_stop · eye_report · eye_lock · eye_probe
`.trim();

const server = new McpServer({ name: "the-eye", version: "0.2.0" }, { instructions: INSTRUCTIONS });

server.registerTool("eye_status", {
  title: "Displays, active runs and locks",
  description: "Displays (id, size in points, scale, refresh rate = the fps target), active recordings / probe runs / input locks, and where runs are stored. Start here to pick a display and rect.",
  inputSchema: {},
}, async () => {
  ensureBinary();
  const now = Date.now();
  const d = await run(BIN, ["displays"], 8000);
  return text([
    d.code === 0 ? d.stdout.trim() : `displays: ${(d.stdout + d.stderr).trim()}`,
    `runs dir: ${RUNS}`,
    driverStatus(),
    ...[...jobs.values()].filter(running).map((j) => `${j.id} "${j.label}" ${j.state} (${((now - j.started) / 1000).toFixed(0)}s)${j.ax ? " · ax on" : ""} → ${j.capture.csv}`),
    ...[...locks.values()].map((l) => `${l.id} locked, ${Math.max(0, (l.until - now) / 1000).toFixed(0)}s left`),
    ...finishedLocks.slice(0, 3).map((r) => `ended ${r}`),
    ...probeRunsStatus(),
    ...diedCaptures.slice(-2).map((x) => `capture ended early: ${x}`),
  ].join("\n"));
});

server.registerTool("eye_inspect", {
  title: "What UI is here (Accessibility)",
  description: [
    "Accessibility view of the screen, no recording needed. Without rect: EVERYTHING the element under a point exposes (default:",
    "the pointer) — role, labels, value, frame, state, actions, every other attribute, ancestors, app and window. With rect (or",
    "tree set): the element tree of the windows actually visible there, one line per element with its bounds",
    "`Button \"Camera\" #id [x,y w×h] (focused) {Press}`. Frames are global points (same space as eye_act x/y).",
    "Note: querying a SwiftUI app turns on its accessibility work for a while (slower frames) — don't do it in the middle of a perf measurement.",
  ].join(" "),
  inputSchema: {
    x: z.number().optional(), y: z.number().optional().describe("Point to inspect (global points). Default: the pointer."),
    rect: rectSchema.optional().describe("Tree of the windows visible in this display-local rect (clipped to it)."),
    display: z.number().int().optional(),
    process: z.string().optional().describe("Only this app's windows (name substring or pid), visible or not."),
    tree: treeSchema.optional().describe("basic (default with rect): labeled elements only, unlabeled layout groups folded. full: every node + its actions. none."),
    depth: z.number().int().optional().describe("Max tree depth (default 40 basic / 60 full)."),
    max_nodes: z.number().int().optional().describe("Max printed nodes (default 250 basic / 2000 full)."),
  },
}, async (p) => {
  const out: string[] = [];
  const mode = p.tree ?? (p.rect || p.process ? "basic" : "none");
  if (!p.rect) {
    const r = await actorSend({ op: "inspect", x: p.x, y: p.y });
    if (!r.ok) return fail(r.error);
    out.push(`at (${Number(r.x).toFixed(0)},${Number(r.y).toFixed(0)}): ${hoverFull(r.element)}`);
    if (r.cg_window) out.push(`window-server window there: ${JSON.stringify(r.cg_window)}`);
  }
  if (mode !== "none") {
    const dir = runDir("inspect");
    const file = join(dir, "ax_tree.json");
    const t = await axTree({ rect: p.rect, display: p.display, x: p.rect ? undefined : p.x, y: p.rect ? undefined : p.y,
      process: p.process, mode, depth: p.depth, max_nodes: p.max_nodes, out: file });
    if (t.ok) writeFileSync(join(dir, "ax_tree.txt"), t.text);
    out.push(`element tree (${mode}, ${t.nodes} nodes; global points):\n${t.text}${t.ok ? `\nfull JSON: ${file}` : ""}`);
  }
  return text(out.join("\n\n"));
});

server.registerTool("eye_snapshot", {
  title: "Image of a region (live or recorded)",
  description: "Live: one PNG of a screen region {rect}. Recorded: the saved keyframes of a run closest to a time {csv, t_s} (record with keyframe_ms). Returns paths; return_image adds the image(s) inline.",
  inputSchema: {
    rect: rectSchema.optional(), display: z.number().int().optional(), path: z.string().optional(),
    csv: z.string().optional().describe("frames.csv of a recording, to get its keyframes instead of a live image."),
    t_s: z.number().optional(), count: z.number().int().min(1).max(8).optional(),
    return_image: z.boolean().optional(),
  },
}, async (p) => {
  if (p.csv) {
    const dir = join(dirname(p.csv), "keyframes");
    if (!existsSync(dir)) return fail("this recording has no keyframes (record with keyframe_ms)");
    const files = readdirSync(dir).filter((f) => f.endsWith(".png"))
      .map((f) => ({ f, t: Number(f.replace(/^frame_|ms\.png$/g, "")) / 1000 }))
      .sort((a, b) => Math.abs(a.t - (p.t_s ?? 0)) - Math.abs(b.t - (p.t_s ?? 0))).slice(0, p.count ?? 3).sort((a, b) => a.t - b.t);
    const content: any[] = [{ type: "text", text: files.map((x) => `${x.t.toFixed(3)}s ${join(dir, x.f)}`).join("\n") }];
    if (p.return_image) for (const x of files) content.push({ type: "image", data: readFileSync(join(dir, x.f)).toString("base64"), mimeType: "image/png" });
    return { content };
  }
  if (!p.rect) return fail("pass rect (live) or csv + t_s (recorded keyframes)");
  ensureBinary();
  const rect = p.rect;
  const out = p.path ?? join(runDir("snapshot"), "snapshot.png");
  const args = ["snapshot", "--rect", rectArg(rect), "--out", out];
  if (p.display !== undefined) args.push("--display", String(p.display));
  let r = await run(BIN, args, 6000);
  let note = r.stdout.trim();
  if (r.code !== 0 && p.display === undefined) {
    // ScreenCaptureKit wedged: fall back to the system screenshot tool (main display, points).
    const fb = await run("/usr/sbin/screencapture", ["-x", "-R", `${rect.x},${rect.y},${rect.w},${rect.h}`, out], 8000);
    if (fb.code === 0 && existsSync(out)) {
      note = JSON.stringify({ path: out, via: "screencapture fallback", reason: (r.stderr || r.stdout).trim().slice(0, 200) });
      r = fb;
    }
  }
  if (r.code !== 0) return fail(r.stdout + r.stderr);
  const content: any[] = [{ type: "text", text: note }];
  if (p.return_image) content.push({ type: "image", data: readFileSync(out).toString("base64"), mimeType: "image/png" });
  return { content };
});

server.registerTool("eye_record", {
  title: "Record a region (and optionally run a command)",
  description: [
    "Record a screen region at the display's full refresh rate, with the pointer and (ax) the element under it. Three modes:",
    "(1) no command, no seconds → starts in the background and returns an id at once with the AX tree of what's there; act",
    "(eye_act, or the user), then eye_stop for the report. (2) seconds → records that long and returns the report.",
    "(3) command → runs a shell command (your input driver) while recording, optionally with the physical pointer locked",
    "(lock_input), keeps recording post_ms after it exits, returns command output + report. background:true makes (2)/(3)",
    "return an id at once — poll eye_peek, eye_stop to end early. The command gets env THE_EYE_LIVE (JSON refreshed 10×/s: moving,",
    "extent, last_1s stats, hover), THE_EYE_RECT and THE_EYE_RUN_DIR.",
  ].join(" "),
  inputSchema: {
    rect: rectSchema, label: z.string().optional().describe("Name for this run (used in the run folder and reports)."),
    display: z.number().int().optional().describe("Display id from eye_status (default main)."),
    seconds: z.number().positive().max(600).optional().describe("Record this long (no command)."),
    command: z.string().optional().describe("Shell command to run while recording (/bin/zsh -lc)."), cwd: z.string().optional(),
    background: z.boolean().optional().describe("Return an id immediately (default: true without command/seconds, false otherwise)."),
    lock_input: z.boolean().optional().describe("Block ALL the user's physical input (pointer, gestures, keyboard) while the command runs; process-posted input passes. Default false."),
    pre_ms: z.number().optional().describe("Record this long before starting the command (default 500)."),
    post_ms: z.number().optional().describe("Keep recording after the command exits (default 1000)."),
    timeout_s: z.number().positive().max(600).optional().describe("Kill the command after this (default 300)."),
    max_seconds: z.number().positive().max(600).optional().describe("Safety stop for open-ended recordings (default 300)."),
    fps: z.number().optional(),
    keyframe_ms: z.number().optional().describe("Also save a PNG every N ms (eye_snapshot {csv, t_s}). Omit to save none."),
    profile: profileSchema,
    duplicates: z.enum(["refuse", "quit_others", "allow"]).optional().describe(duplicatesSchemaDescription + " Checked when `process` is given."),
    ...axOpts,
    ...analysisOpts,
  },
}, async (p) => {
  const busy = claimDriver("eye_record");
  if (busy) return fail(busy);
  if (p.process) { const dup = ensureSingleInstance(p.process, p.duplicates); if (dup) return fail(dup); }
  const job = startJob(p);
  const blocking = p.background === undefined ? !!(p.command || p.seconds) : !p.background;
  if (blocking) {
    const final = await job.finished;
    const tree = job.tree ? `\n\nobserved windows at start (AX tree, global points):\n${capLines(job.tree, 60, `full tree: ${join(job.capture.dir, "ax_tree_start.txt")}`)}` : "";
    return text(`${job.id} done\n\n${final}${tree}`);
  }
  for (let i = 0; i < 100 && job.state === "starting"; i++) await sleep(50);
  if (job.state === "done") return fail(job.final ?? "capture failed");
  const live = readLive(job.capture);
  return text([
    `${job.id} recording "${job.label}" ${rectArg(p.rect)}${p.display !== undefined ? ` on display ${p.display}` : ""} → ${job.capture.csv}`,
    job.output.length ? job.output.join("\n") : "",
    job.ax ? "AX inspection ON (hover + tree): fps can read lower on SwiftUI apps; use ax:false for final numbers." : "AX inspection off.",
    describeLive(live),
    job.tree ? `observed windows (AX tree, global points):\n${capLines(job.tree, 120, `full tree: ${join(job.capture.dir, "ax_tree_start.txt")}`)}` : "",
    `next: eye_act {steps, target_process} · eye_peek {id:"${job.id}"} · eye_stop {id:"${job.id}"}`,
  ].filter(Boolean).join("\n"));
});

server.registerTool("eye_peek", {
  title: "Live state of a recording",
  description: "What a running recording sees RIGHT NOW: moving or not, the visible extent, smoothness over the last few seconds, the element under the pointer, the command's latest output, and the live probe layers. Optionally the full element under the pointer (hover:'full') or a fresh AX tree of the region (tree). Returns the final report once the run has ended.",
  inputSchema: {
    id: z.string().optional().describe("eye_record or eye_probe id. Omit for the most recent running one."),
    window_s: z.number().positive().optional().describe("Seconds of recent history to measure (default 3)."),
    output_lines: z.number().int().optional().describe("Command output lines to include (default 8)."),
    hover: z.enum(["short", "full"]).optional().describe("full = every attribute of the element under the pointer (default short)."),
    tree: treeSchema.optional().describe("Also dump the CURRENT AX tree of the recorded region (default none)."),
    max_layers: z.number().int().optional().describe("Probe layers per list (default 5)."),
  },
}, async (p) => {
  if (p.id && isProbeRun(p.id)) return text(peekProbe(p.id, p.max_layers ?? 8) ?? "no probe run");
  const job = p.id ? jobs.get(p.id) : (activeJob() ?? [...jobs.values()].pop());
  if (!job) {
    const pr = peekProbe(undefined, p.max_layers ?? 8);
    return pr ? text(pr) : fail(`unknown run ${p.id ?? "(none active)"}`);
  }
  if (job.state === "done") return text(`${job.id} done\n\n${job.final}`);
  const cap = job.capture;
  const live = readLive(cap);
  const lines: string[] = [];
  lines.push(`${job.id} "${job.label}" ${job.state} · ${((Date.now() - job.started) / 1000).toFixed(1)}s elapsed${job.lock ? " · input locked" : ""}${job.ax ? "" : " · ax off"}`);
  lines.push(describeLive(live));
  if (p.hover === "full" && job.ax) lines.push(`element under the pointer:\n${hoverFull(live?.hover)}`);
  try {
    const { rows, meta } = loadRun(cap.csv);
    const t = live?.t ?? (rows.length ? rows[rows.length - 1].t : 0);
    const w = p.window_s ?? 3;
    const a = analyze(rows, meta, { ...job.opts, from_s: Math.max(0, t - w) });
    lines.push(a.overall
      ? `last ${w}s while animating: ${a.overall.fps} fps of ${a.overall.target_fps} · hitches ${a.overall.hitches} (long ${a.overall.long_hitches}) · p95 gap ${a.overall.gap_p95_ms}ms · max ${a.overall.gap_max_ms}ms`
      : `last ${w}s: no animation`);
  } catch { /* csv not flushed yet */ }
  if (job.command) {
    const n = p.output_lines ?? 8;
    lines.push(job.output.length ? `command output (last ${Math.min(n, job.output.length)}):\n${job.output.slice(-n).join("\n")}` : "command output: (none yet)");
  }
  if (p.tree && p.tree !== "none") {
    const t = await axTree({ rect: job.rect, display: job.display, process: job.process, mode: p.tree });
    lines.push(`AX tree now (${p.tree}, global points):\n${t.text}`);
  }
  const pl = activeProbeLive();
  if (pl) lines.push(describeProbeLive(pl, p.max_layers ?? 5));
  return text(lines.join("\n"));
});

server.registerTool("eye_stop", {
  title: "Stop and report",
  description: "End a recording (eye_record) and/or probe run (eye_probe) now and return the report: smoothness, what the pointer was over, command output, and the probe's per-layer report aligned to the capture. A running command is killed. Omit id to stop everything that's running.",
  inputSchema: {
    id: z.string().optional().describe("eye_record or eye_probe id. Omit to stop all."),
    reason: z.string().optional().describe("Why (shown in the report when a command was cut short)."),
    match: z.array(z.string()).optional().describe("Probe report: only layers whose label contains one of these."),
    top: z.number().int().optional().describe("Probe report: layers to list (default 15)."),
    ...analysisOpts,
  },
}, async (p) => {
  const { id, reason, match, top, ...opts } = p;
  const jobList = id ? (isProbeRun(id) ? [] : [jobs.get(id)].filter(Boolean) as Job[]) : [...jobs.values()].filter(running);
  const probeIds = id ? (isProbeRun(id) ? [id] : []) : probeRunIds();
  if (!jobList.length && !probeIds.length) return fail(diedCaptures.length ? `nothing running — ${diedCaptures.slice(-2).join("\n")}` : `nothing running${id ? ` with id ${id}` : ""}`);
  const out: string[] = [];
  for (const j of jobList) {
    if (running(j)) {
      j.opts = { ...j.opts, ...opts };
      j.stopped ??= reason ?? "stopped by agent";
      j.cmd?.kill("SIGTERM");
      j.stopNow();
    }
    out.push(`${j.id}:\n${await j.finished}`);
  }
  const csv = jobList[0]?.capture.csv;
  for (const r of await stopProbes(runDir, probeIds.length === 1 ? probeIds[0] : undefined, { capture_csv: csv, match, top })) out.push(r);
  return text(out.join("\n\n"));
});

// ---- eye_act

/** Variables available to guard/until/assert expressions. */
function scope(live: any, ptr: { x: number; y: number }, hover: any) {
  return {
    live,
    a: live?.anchored_screen ?? null,          // top-anchored extent {x0,x1,w,h,cx,y0,y1} in screen points, or null
    e: live?.changed_extent_screen ?? null,    // bbox of every change vs the first frame
    moving: !!live?.moving,
    fps1: live?.last_1s?.new_frames ?? 0,      // new frames in the last second
    gap1: live?.last_1s?.max_gap_ms ?? 0,
    p: ptr,                                    // pointer position
    h: hover ?? null,                          // AX element under the pointer {role,title,description,identifier,value,frame,path,app,...}
    pr: activeProbeLive(),                     // layer-probe live JSON (eye_probe), or null
    L: (s: string) => {                        // first moving/watched probe layer whose label contains s
      const pl = activeProbeLive();
      const want = s.toLowerCase();
      return [...(pl?.moving ?? []), ...(pl?.watched ?? [])].find((e: any) => String(e.label).toLowerCase().includes(want)) ?? null;
    },
  };
}
function evalExpr(expr: string, s: ReturnType<typeof scope>): boolean {
  const f = new Function(...Object.keys(s), `return (${expr});`);
  return !!f(...Object.values(s));
}
function short(live: any): string {
  if (!live) return "no live capture";
  const a = live.anchored_screen, l = live.last_1s ?? {};
  return `${a ? `open-extent ${a.w.toFixed(0)}×${a.h.toFixed(0)} @x${a.x0.toFixed(0)}..${a.x1.toFixed(0)}` : "top edge unchanged"} · ${live.moving ? "MOVING" : "still"} · 1s: ${l.new_frames}f/${l.idle}i, max gap ${Number(l.max_gap_ms).toFixed(1)}ms`;
}

const stepSchema = z.object({
  op: z.enum(["move", "click", "down", "up", "scroll", "wait", "wait_until", "assert"]),
  x: z.number().optional(), y: z.number().optional(),
  ms: z.number().optional().describe("move: glide duration (0 = jump); wait: duration"),
  button: z.enum(["left", "right"]).optional(), count: z.number().int().optional(), hold_ms: z.number().optional(),
  dy: z.number().optional(), dx: z.number().optional(), events: z.number().int().optional(),
  interval_ms: z.number().optional(), phased: z.boolean().optional().describe("scroll: trackpad phases (default true)"),
  expr: z.string().optional().describe("wait_until/assert: JS expression over a, e, moving, fps1, gap1, p, h, live, pr, L()"),
  timeout_ms: z.number().optional().describe("wait_until timeout (default 2000)"),
  guard: z.string().optional().describe("Expression that must hold BEFORE this step runs, else the sequence stops."),
  force: z.boolean().optional().describe("scroll: skip the inside-the-open-area safety check. Presses (click/down) can NOT be forced."),
  on: z.union([z.string(), z.number()]).optional().describe("click/down/move: aim at a probe layer (label substring or layer id) instead of x,y — its centre, from the probe's live data. The layer must be in the live moving/watched lists (eye_probe watch)."),
  note: z.string().optional(),
});

server.registerTool("eye_act", {
  title: "Act and observe",
  description: [
    "Drive the pointer step by step and get, after EVERY step, the pointer position, the accessibility element under it, and the",
    "measured visible state — so you can think and react between calls. Steps: move {x,y,ms}, click {x?,y?,button,count},",
    "down/up {button} (drag = down, move, up), scroll {dy,dx,events,phased}, wait {ms}, wait_until {expr,timeout_ms}, assert {expr}.",
    "Any step may carry `guard`. Expressions see: a = top-anchored open extent {x0,x1,w,h,cx} or null, e = bbox of all change,",
    "moving, fps1, gap1 (ms), p = pointer {x,y}, h = element under the pointer (role, title, description, identifier, value, frame,",
    "path, app, enabled, focused, selected, actions) or null, live = raw live JSON, pr / L('label') = probe layers.",
    "e.g. wait_until {expr:\"h?.identifier=='close'\"}. Find targets first with eye_inspect. SAFETY: presses only on target_process;",
    "scroll only inside `a` or scroll_zones unless force. Blocks ALL the user's physical input (trackpad + keyboard) while it runs.",
    "Live visible state needs a running eye_record. Input is synthetic (see the guide if a bug won't reproduce with it).",
  ].join(" "),
  inputSchema: {
    steps: z.array(stepSchema).min(1).max(60),
    id: z.string().optional().describe("Recording whose live state to use (default: most recent running)."),
    target_process: z.union([z.string(), z.number()]).optional().describe("App that presses must land on (name or pid). Default: the app of the running eye_probe. Presses are refused without a target."),
    scroll_zones: z.array(rectSchema).optional().describe("Extra screen rects (points) where scrolling is allowed, e.g. the closed notch."),
    label: z.string().optional().describe("Phase name recorded with these steps in the run's action log (eye_report view:'explain' groups by it)."),
    ax: z.boolean().optional().describe("Report the element under the pointer after each step (default: the recording's ax setting, true without a recording)."),
    tree: treeSchema.optional().describe("After the steps, also dump the AX tree of the recorded region (or the window under the pointer). Default none."),
    lock: z.boolean().optional().describe("Block all physical input for exactly the duration of these steps (default true)."),
    duplicates: z.enum(["refuse", "quit_others", "allow"]).optional().describe(duplicatesSchemaDescription),
  },
}, async (p) => {
  const busy = claimDriver("eye_act");
  if (busy) return fail(busy);
  const named = p.target_process ?? activeProbeTarget()?.pid;
  if (named !== undefined) { const dup = ensureSingleInstance(named, p.duplicates); if (dup) return fail(dup); }
  let target: { pid: number; name: string } | null = null;
  try { target = p.target_process !== undefined ? await resolvePid(p.target_process) : activeProbeTarget(); }
  catch (e: any) { return fail(e.message); }
  let strictLock: Lock | undefined;
  // A session lock (eye_lock / lock_input) already covers us, including between calls mid-drag.
  const cover = [...locks.values()].find((l) => l.until > Date.now() + 5000);
  const covered = !!cover && (await cover.ready);
  if (p.lock !== false && !covered) {
    const budget = p.steps.reduce((t, s) => t + (s.ms ?? 0) + (s.timeout_ms ?? (s.op === "wait_until" ? 2000 : 0)) + (s.hold_ms ?? 0) + 400, 0);
    strictLock = startLock(Math.min(300, Math.ceil(budget / 1000) + 15), "tagged");
    if (!(await strictLock.ready)) return fail(`could not take the input lock: ${await strictLock.done}`);
  }
  try { return await actSteps(p, target); }
  finally { if (strictLock) await stopLock(strictLock); }
});

async function actSteps(p: any, target: { pid: number; name: string } | null) {
  const job = activeJob(p.id);
  const cap = job?.capture;
  const readNow = () => (cap ? readLive(cap) : null);
  const axOn: boolean = p.ax ?? (job ? job.ax : true);
  const t0 = Date.now();
  const lines: string[] = [];
  let ptr = { x: 0, y: 0 };
  let hover: any = null;
  const look = async () => {
    if (!axOn) return;
    const r = await actorSend({ op: "inspect", x: ptr.x, y: ptr.y, brief: true });
    hover = r.ok ? r.element : null;
  };
  { const r = await actorSend({ op: "pos" }); if (r.ok) ptr = { x: r.x, y: r.y }; }
  await look();
  const stamp = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
  let stopped = "";
  const wallNow = () => (performance.timeOrigin + performance.now()) / 1000;
  const logAction = (s: any, wall0: number, ok: boolean) => {
    if (!cap) return;
    try {
      appendFileSync(join(cap.dir, "actions.jsonl"), JSON.stringify({ wall0, wall1: wallNow(), op: s.op, note: s.note ?? p.label, x: ptr.x, y: ptr.y, ok }) + "\n");
    } catch { /* run dir gone */ }
  };
  const over = () => (axOn ? ` · over ${hoverLine(hover, 3)}` : "");
  for (const [i, s] of p.steps.entries()) {
    const tag = `#${i} ${s.op}${s.note ? ` (${s.note})` : ""}`;
    const wall0 = wallNow();
    const stoppedBefore = stopped;
    try {
      if (s.guard && !evalExpr(s.guard, scope(readNow(), ptr, hover))) { stopped = `${tag}: guard failed: ${s.guard}`; break; }
      if (s.op === "wait") { await sleep(s.ms ?? 300); await look(); }
      else if (s.op === "wait_until" || s.op === "assert") {
        if (!s.expr) { stopped = `${tag}: needs expr`; break; }
        const needsHover = /\bh\b/.test(s.expr);
        const end = Date.now() + (s.op === "assert" ? 0 : s.timeout_ms ?? 2000);
        let ok = evalExpr(s.expr, scope(readNow(), ptr, hover));
        while (!ok && Date.now() < end) {
          await sleep(needsHover ? 60 : 25);
          if (needsHover) await look();
          ok = evalExpr(s.expr, scope(readNow(), ptr, hover));
        }
        if (!ok) { lines.push(`${stamp()} ${tag} ✗ ${s.expr} · ${short(readNow())}${over()}`); stopped = `${tag}: not satisfied: ${s.expr}`; break; }
      } else {
        if (s.op === "scroll" && !s.force) {
          const live = readNow(), a = live?.anchored_screen;
          const inA = a && ptr.x > a.x0 + 10 && ptr.x < a.x1 - 10 && ptr.y < (a.y0 ?? 0) + a.h - 5;
          const inZone = (p.scroll_zones ?? []).some((z: Rect) => ptr.x >= z.x && ptr.x <= z.x + z.w && ptr.y >= z.y && ptr.y <= z.y + z.h);
          if (!inA && !inZone) { stopped = `${tag}: REFUSED scroll at ${ptr.x.toFixed(0)},${ptr.y.toFixed(0)} — not inside the open area or a scroll_zone`; break; }
        }
        const { guard, force, note, expr, timeout_ms, on, ...cmd } = s as any;
        // Aim at a probe layer: its centre, read from the live probe data right now.
        let aimed: number[] | null = null;
        if (on !== undefined) {
          const pl = activeProbeLive();
          const want = String(on).toLowerCase();
          const hit = [...(pl?.moving ?? []), ...(pl?.watched ?? [])].find((e: any) =>
            !e.gone && e.rect && (typeof on === "number" ? e.id === on : String(e.label).toLowerCase().includes(want)));
          if (!hit) { stopped = `${tag}: no live probe layer matches ${JSON.stringify(on)} (watch it in eye_probe)`; break; }
          aimed = hit.shape ?? hit.rect;
          cmd.x = aimed![0] + aimed![2] / 2; cmd.y = aimed![1] + aimed![3] / 2;
        }
        if (s.op === "click" || s.op === "down") {
          // Presses can never land outside the target app: no force, both checks always run.
          if (!target) { stopped = `${tag}: REFUSED press — no target app (pass target_process, or run eye_probe)`; break; }
          const at = { x: cmd.x ?? ptr.x, y: cmd.y ?? ptr.y };
          const pl = activeProbeLive();
          if (pl) {
            const boxes: number[][] = aimed ? [aimed] : [...(pl.moving ?? []), ...(pl.watched ?? [])].filter((e: any) => !e.gone && e.rect).map((e: any) => e.shape ?? e.rect);
            const inside = boxes.some((b) => at.x >= b[0] && at.x <= b[0] + b[2] && at.y >= b[1] && at.y <= b[1] + b[3]);
            if (!inside) { stopped = `${tag}: REFUSED press at ${at.x.toFixed(0)},${at.y.toFixed(0)} — not inside a live layer of ${target.name}`; break; }
          }
          if (s.op === "down" && (cmd.x !== undefined || cmd.y !== undefined)) {
            const mv = await actorSend({ op: "move", x: at.x, y: at.y, ms: 0 });
            if (!mv.ok) { stopped = `${tag}: ${mv.error}`; break; }
          }
          cmd.require_pid = target.pid; // the actor re-checks the topmost window owner right before posting
        }
        const r = await actorSend(cmd);
        if (!r.ok) { stopped = `${tag}: ${r.error}`; break; }
        ptr = { x: r.x, y: r.y };
        await look();
      }
      lines.push(`${stamp()} ${tag} → p(${ptr.x.toFixed(0)},${ptr.y.toFixed(0)}) · ${short(readNow())}${over()}`);
    } catch (err: any) { stopped = `${tag}: ${err.message}`; break; }
    finally { if (s.op !== "assert") logAction(s, wall0, stopped === stoppedBefore); }
  }
  const live = readNow();
  let recent = "";
  if (cap) {
    try {
      const { rows, meta } = loadRun(cap.csv);
      const t = live?.t ?? 0, w = Math.max(1, (Date.now() - t0) / 1000);
      const a = analyze(rows, meta, { from_s: Math.max(0, t - w) });
      recent = a.overall ? `during these steps while animating: ${a.overall.fps} fps of ${a.overall.target_fps} · hitches ${a.overall.hitches} (long ${a.overall.long_hitches}) · p95 ${a.overall.gap_p95_ms}ms · max ${a.overall.gap_max_ms}ms` : "during these steps: no animation";
    } catch { /* not flushed yet */ }
  }
  let tree = "";
  if (p.tree && p.tree !== "none") {
    const t = job ? await axTree({ rect: job.rect, display: job.display, process: job.process, mode: p.tree })
      : await axTree({ x: ptr.x, y: ptr.y, mode: p.tree });
    tree = `AX tree now (${p.tree}, global points):\n${t.text}`;
  }
  return text([
    ...lines,
    stopped ? `STOPPED — ${stopped}` : `all ${p.steps.length} steps done`,
    axOn && hover ? `element under the pointer now: ${hoverLine(hover, 6)}` : "",
    cap ? describeLive(live) : diedCaptures.length ? `(capture ended early — ${diedCaptures[diedCaptures.length - 1]})` : "(no running eye_record — start one for the visible-state numbers)",
    recent,
    activeProbeLive() ? describeProbeLive(activeProbeLive(), 5) : "",
    tree,
  ].filter(Boolean).join("\n"));
}

// ---- reports

server.registerTool("eye_report", {
  title: "Analyze recordings",
  description: [
    "Re-analyze recorded runs. view: summary (default for csv) = animation segments with fps/stalls/hitches/extent;",
    "timeline = binned time series (frames, idle, worst gap, % moved, luma, extent); explain = the worst on-screen gaps joined",
    "with where the pointer was, which element it was over, which eye_act step ran and (with profile) the app's main thread;",
    "hover = every change of the element under the pointer; compare (default for runs) = side-by-side table vs the first run;",
    "probe (default for an .ndjson file) = per-layer report, or one layer's per-frame series with layer_id.",
  ].join(" "),
  inputSchema: {
    view: z.enum(["summary", "timeline", "explain", "hover", "compare", "probe"]).optional(),
    csv: z.string().optional().describe("frames.csv of a run."),
    runs: z.array(z.object({ csv: z.string(), label: z.string() })).optional().describe("compare: first is the baseline."),
    file: z.string().optional().describe("probe: probe.ndjson."),
    label: z.string().optional(), from_s: z.number().optional(), to_s: z.number().optional(),
    max_segments: z.number().int().optional().describe("summary: segments to list."),
    bin_ms: z.number().positive().optional().describe("timeline: bin size (default 50)."),
    top: z.number().int().optional().describe("explain: worst gaps (default 12) · hover: changes (default 200) · probe: layers (default 15)."),
    gap_frames: z.number().optional().describe("explain: minimum gap in refreshes (default 3)."),
    app_binary: z.string().optional().describe("explain: the app's binary name in stacks (default guessed)."),
    match: z.array(z.string()).optional(), layer_id: z.number().int().optional(), max_rows: z.number().int().optional(),
    split_ms: z.number().optional(), capture_csv: z.string().optional().describe("probe: align times to this capture."),
    ...analysisOpts,
  },
}, async (p) => {
  const view = p.view ?? (p.runs ? "compare" : p.file ? "probe" : "summary");
  try {
    switch (view) {
      case "compare":
        if (!p.runs?.length) return fail("compare needs runs");
        return text(compare(p.runs.map(({ csv, label }) => { const { rows, meta } = loadRun(csv); return { label, a: analyze(rows, meta, p) }; })));
      case "probe":
        if (!p.file) return fail("probe needs file (probe.ndjson)");
        return text(analyzeProbe(p.file, p));
    }
    if (!p.csv) return fail(`${view} needs csv`);
    switch (view) {
      case "timeline": return text(timeline(loadRun(p.csv).rows, p.bin_ms ?? 50, p.from_s, p.to_s));
      case "explain": return text(explain(p.csv, p));
      case "hover": return text(hoverTimeline(p.csv, p.top ?? 200, p.from_s, p.to_s) || "no hover log for this run (recorded with ax off?)");
      default: return text(report(p.csv, p.label ?? p.csv, p, p.max_segments));
    }
  } catch (e: any) { return fail(e.stack ?? e.message); }
});

server.registerTool("eye_lock", {
  title: "Lock / unlock physical input",
  description: "Block ALL of the user's physical input — trackpad/mouse, gestures, keyboard, media keys — and pin the cursor, with the orange overlay on every screen (after a 1.5s 3·2·1 warning), so automated input runs undisturbed (auto-release after `seconds`; emergency release: the user presses Esc 6× in a row, ≤1s apart). eye_act takes one automatically while it drives; use a session lock to keep input blocked across several eye_act calls (e.g. a drag held between calls) or around your own driver. release:true (or no seconds) releases locks and reports how many physical events were blocked.",
  inputSchema: {
    seconds: z.number().positive().max(600).optional(),
    release: z.boolean().optional(),
    id: z.string().optional().describe("Release only this lock."),
    allow: z.enum(["synthetic", "tagged"]).optional().describe("synthetic (default): any process-posted event passes. tagged: only events with eventSourceUserData 0x45594521."),
  },
}, async (p) => {
  if (p.release || !p.seconds) {
    const list = p.id ? [locks.get(p.id)].filter(Boolean) as Lock[] : [...locks.values()];
    const out: string[] = [];
    for (const l of list) out.push(`${l.id}: ${await stopLock(l)}`);
    if (!out.length) {
      const prior = p.id ? finishedLocks.filter((r) => r.startsWith(p.id + ":")) : finishedLocks.slice(0, 3);
      return text(prior.length ? `no active lock; already ended:\n${prior.join("\n")}` : "no active lock");
    }
    return text(out.join("\n"));
  }
  const busy = claimDriver("eye_lock");
  if (busy) return fail(busy);
  const l = startLock(p.seconds, p.allow ?? "synthetic");
  if (!(await l.ready)) return fail(await l.done);
  return text(`${l.id}: physical pointer AND keyboard locked for ${p.seconds}s (Esc ×6 = user's emergency release). eye_lock {release:true} when done.`);
});

registerProbeTools(server, { root: ROOT, runDir, text, fail });

function cleanup() {
  releaseDriver();
  actor?.child.kill("SIGTERM");
  for (const j of jobs.values()) j.cmd?.kill("SIGTERM");
  for (const l of locks.values()) l.child.kill("SIGTERM");
  for (const c of captures.values()) c.child.kill("SIGTERM");
}
startLeaseHeartbeat(() => [...jobs.values()].some(running) || locks.size > 0 || activeProbeTarget() !== null);
process.on("exit", cleanup);
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, () => { cleanup(); process.exit(0); });
process.stdin.on("close", () => { cleanup(); process.exit(0); });

ensureBinary();
await server.connect(new StdioServerTransport());
