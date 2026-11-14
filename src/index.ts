#!/usr/bin/env node
// the-eye — an MCP server that lets an agent SEE and MEASURE what is on a macOS screen over time: per-frame
// timing and motion (pixels → numbers), what UI element is under the pointer and the element tree of the
// observed windows (Accessibility), and, optionally, layer geometry from inside an app (probe.ts).
// Native capture, input and AX live in bin/eye-capture (swift/EyeCapture.swift).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, compare, formatAnalysis, loadRun, timeline, type Options } from "./analyze.ts";
import { explain } from "./explain.ts";
import { formatSeen, notice } from "./notice.ts";
import { ROOT_HINT, endUnder, startUnder, stopUnder, type Under } from "./under.ts";
import { still, type Img } from "./still.ts";
import {
  activeProbeLive, activeProbeTarget, analyzeProbe, describeProbeLive, isProbeRun, peekProbe, probeRunIds, probeRunsStatus,
  registerProbeTools, resolvePid, snapshotStalls, stopProbes,
} from "./probe.ts";
import {
  checkInstances, driverStatus, driving, duplicatesSchemaDescription, familyOf, freshEvents, launch, listFamily, quitPids, releaseDriver,
  startLeaseHeartbeat, watchedStatus, watchPid,
} from "./single.ts";

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

// `the-eye watch …` — not the MCP server: a CLI that streams UI events, one line each, for an agent's Monitor
// (or a background shell wait with --until). See `the-eye watch --help`.
const WATCH_CMD = `node ${join(ROOT, "src", "index.ts")} watch`;
if (process.argv[2] === "watch") {
  ensureBinary();
  const child = spawn(BIN, ["watch", ...process.argv.slice(3)], { stdio: "inherit" });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill("SIGTERM"));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
  await new Promise(() => {});
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
  process: z.coerce.string().describe("App process name or pid to attach Instruments to (e.g. 'NOOTCH!')."),
  template: z.string().optional().describe("Instruments template (default 'Time Profiler')."),
  hitches: z.boolean().optional().describe("Add the Hitches instrument (default true)."),
  keep_trace: z.boolean().optional().describe("Keep the raw .trace (default false: it embeds the app's environment, which may contain secrets)."),
}).optional().describe("Also record Instruments on the app and align it with the frames (eye_report view:'explain'). Starting xctrace takes a few seconds.");

const treeSchema = z.enum(["none", "basic", "full"]);
const axOpts = {
  ax: z.boolean().optional().describe("Accessibility context: log the element under the pointer (live + hover.jsonl) and snapshot the element tree of the observed windows. Default true, false when `profile` is set. COST: makes SwiftUI apps maintain their AX graph (~18% more main-thread time, up to −25% fps) — set false for final fps numbers and A/B comparisons."),
  ax_hz: z.number().optional().describe("Hover hit-tests per second when ax is on (default 10)."),
  tree: treeSchema.optional().describe("Element tree of the observed windows at start: basic (labeled elements + bounds, default when ax on), full (every node + actions), none."),
  process: z.coerce.string().optional().describe("Focus the AX tree on this app (name or pid). Default: whatever is actually visible in rect."),
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
  /** `eye-capture watch --exact` on the recorded app, writing events.jsonl beside the frames. */
  events?: ChildProcess;
  /** Signposts and vitals of the recorded app, plus dtrace + powermetrics when sudo needs no password (under.ts). */
  under?: Under | null;
};
const captures = new Map<string, Capture>();
/**
 * `ready` resolves true once input is actually blocked (after the countdown and the settle wait), false if the
 * helper refused (its preflight runs BEFORE any countdown) or died. style "quick" = "Just a sec…": no countdown,
 * a small pill instead of the orange wash.
 */
type LockStyle = "full" | "quick";
type Lock = { id: string; child: ChildProcess; done: Promise<string>; ready: Promise<boolean>; until: number; style: LockStyle; engaged?: string;
  /** Resolves the moment input is free again (the helper's report line), before any exit animation. */
  freed: Promise<void> };
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
  profile?: ProfileOpts; cursor?: boolean; ax_hz?: number; only_pid?: number;
}): Capture {
  ensureBinary();
  const dir = runDir(p.label);
  const csv = join(dir, "frames.csv");
  const args = ["capture", "--rect", rectArg(p.rect), "--seconds", String(p.seconds), "--out", csv];
  if (p.display !== undefined) args.push("--display", String(p.display));
  if (p.fps) args.push("--fps", String(p.fps));
  if (p.keyframe_ms) args.push("--keyframes-dir", join(dir, "keyframes"), "--keyframe-ms", String(p.keyframe_ms));
  if (p.cursor === false) args.push("--cursor", "off");
  if (p.only_pid) args.push("--only-pid", String(p.only_pid));
  args.push("--ax-hz", String(p.ax_hz ?? 0));
  const child = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  const id = `cap${++seq}`;
  const c: Capture = { id, label: p.label ?? id, dir, csv, child, done: collect(child), started: Date.now() };
  if (p.profile) c.trace = startTrace(dir, p.profile, p.seconds + 15);
  captures.set(id, c);
  c.done.then((msg) => {
    // Ended on its own (not via eye_stop): keep why, so the next call can say so.
    // (Exit 0 is a `seconds` run reaching its end: finished, not died.)
    if (captures.has(id) && !c.stopping && c.child.exitCode !== 0) diedCaptures.push(`${id} "${c.label}" ended after ${((Date.now() - c.started) / 1000).toFixed(1)}s: ${msg.slice(-600)}`);
  }).finally(() => { captures.delete(id); endUnder(c.under); });
  return c;
}

/**
 * What the app tells accessibility while it is recorded (a value changed, focus moved, a window or sheet came or
 * went, an announcement), each line stamped the moment it arrived, so the report can put it on the frames' clock.
 * An observer only listens: unlike `ax` (which asks the app what is under the pointer ten times a second) it puts
 * a question to the app only when something changed.
 */
function startEvents(c: Capture, pid: number, seconds: number) {
  try {
    const fd = openSync(join(c.dir, "events.jsonl"), "w");
    c.events = spawn(BIN, ["watch", "--app", String(pid), "--json", "--exact", "--seconds", String(Math.ceil(seconds))], { stdio: ["ignore", fd, "ignore"] });
    closeSync(fd);
    c.events.on("error", () => {});
  } catch { /* a recording without the app's words is still a recording */ }
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
  c.events?.kill("SIGTERM");
  const underDone = stopUnder(c.under);
  const { out, killed } = await endChild(c.child, c.done, "SIGTERM", 6000);
  await underDone;
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
/** Every lock blocks ALL physical input (pointer, gestures, keyboard). full: 3·2·1 then the orange overlay; quick: the "Just a sec…" pill. */
function startLock(seconds: number, allow: "synthetic" | "tagged", style: LockStyle = "full"): Lock {
  ensureBinary();
  const args = ["lock", "--seconds", String(seconds), "--allow", allow, "--style", style];
  const child = spawn(BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin!.on("error", () => {});
  const id = `lock${++seq}`;
  const freed = new Promise<void>((res) => { child.stdout!.on("data", (d) => { if (String(d).includes('"ended"')) res(); }); child.on("close", () => res()); });
  const l: Lock = { id, child, done: collect(child), ready: null as any, style, freed,
    until: Date.now() + (style === "full" ? LOCK_COUNTDOWN_MS : 0) + seconds * 1000 };
  // Preflight (tap, every pointing device seizable, no other lock) runs before the countdown: a refusal exits at
  // once. Then the helper prints "locked for …" once input is really blocked.
  l.ready = new Promise<boolean>((res) => {
    let err = "";
    child.stderr?.on("data", (d) => {
      err += d;
      const m = err.match(/locked for [^\n]*/);
      if (m) { l.engaged = m[0]; l.until = Date.now() + seconds * 1000; res(true); }
    });
    child.on("close", () => res(false));
    setTimeout(() => res(child.exitCode === null && child.signalCode === null), 8000);
  });
  locks.set(id, l);
  // Killed before it could restore the pointer↔cursor link (SIGKILL, crash): restore it from outside.
  child.on("exit", (_code, sig) => { if (sig === "SIGKILL" || sig === "SIGSEGV" || sig === "SIGABRT") spawn(BIN, ["release-cursor"], { stdio: "ignore" }); });
  l.done.then((r) => { finishedLocks.unshift(`${id}: ${r}`); finishedLocks.length = Math.min(finishedLocks.length, 10); })
    .finally(() => locks.delete(id));
  return l;
}
/** Push a running lock's end out to `seconds` from now (one lock across calls instead of a gap and a new countdown). */
function extendLock(l: Lock, seconds: number) {
  l.child.stdin!.write(`extend ${seconds}\n`);
  l.until = Date.now() + seconds * 1000;
}
async function stopLock(l: Lock) {
  if (l.child.exitCode === null && l.child.signalCode === null) l.child.stdin!.write("release\n");
  return (await endChild(l.child, l.done, "SIGTERM", 3000)).out;
}
/** Why a lock never engaged, from the helper's own words. */
async function lockFailure(l: Lock) {
  const out = await l.done;
  const m = out.match(/preflight: [^\n"]*/) ?? out.match(/failed: [^\n"]*/);
  return m ? `input lock refused — ${m[0]}` : `input lock failed: ${out.slice(-400)}`;
}
/** A held lock that covers the next `ms` (eye_lock / lock_input / a running glance), extended if it would end too soon. */
async function coveringLock(ms: number): Promise<Lock | undefined> {
  const l = [...locks.values()].find((x) => x.child.exitCode === null);
  if (!l || !(await l.ready)) return undefined;
  if (l.until < Date.now() + ms + 2000) extendLock(l, Math.ceil((ms + 5000) / 1000));
  return l;
}

/** What a viewer would have noticed (verdict, defects worst first with their causes, then the facts). */
function seen(csv: string, opts: Options, o: { live?: boolean; max?: number } = {}) {
  const { rows, meta } = loadRun(csv);
  return formatSeen(notice(rows, meta, analyze(rows, meta, opts), { ...opts, dir: dirname(csv), still_recording: o.live }), o.max);
}
/** The verdict first, the measurements under it. */
function report(csv: string, label: string, opts: Options, maxSegments?: number) {
  const { rows, meta } = loadRun(csv);
  const a = analyze(rows, meta, opts);
  return `${formatSeen(notice(rows, meta, a, { ...opts, dir: dirname(csv) }))}\n\n${formatAnalysis(a, label, maxSegments)}`;
}
/** frames.csv of the newest run on disk: what "the last recording" means when no csv is given. */
function lastCsv(): string | undefined {
  const mine = [...jobs.values()].pop()?.capture.csv;
  if (mine && existsSync(mine)) return mine;
  try {
    return readdirSync(RUNS).sort().reverse().map((d) => join(RUNS, d, "frames.csv")).find((f) => existsSync(f));
  } catch { return undefined; }
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Append instance notes and fresh launch warnings to a tool result. */
function withNotes<T extends { content: { type: "text"; text: string }[] }>(r: T, ...notes: string[]): T {
  const extra = [...notes, ...freshEvents()].filter(Boolean);
  if (extra.length) r.content.push({ type: "text", text: extra.join("\n") });
  return r;
}
/**
 * Apps on screen in a recording's rect (its AX tree plus AX hit-tests at a 3×3 grid of points): each one
 * gets watched, and a warning comes back when one of them runs more than once (another build counts too).
 */
async function observedConflicts(job: { treeFile?: string }, rect: Rect): Promise<string[]> {
  const pids = new Set<number>();
  try { for (const w of JSON.parse(readFileSync(job.treeFile!, "utf8")).windows ?? []) if (w.pid) pids.add(Number(w.pid)); } catch {}
  {
    for (const fx of [0.2, 0.5, 0.8]) for (const fy of [0.2, 0.5, 0.8]) {
      // AX hit-test, not the topmost CG window: transparent full-screen windows (the Dock's) sit above everything.
      const o = await actorSend({ op: "inspect", x: rect.x + rect.w * fx, y: rect.y + rect.h * fy, brief: true });
      if (o?.ok !== false && o?.element?.pid) pids.add(Number(o.element.pid));
    }
  }
  const out: string[] = [];
  for (const pid of pids) {
    let f = familyOf(pid);
    if (!f) continue;
    watchPid(pid);
    if (f.others.length) {
      // Stale copies (older launches of the same build) are quit on the spot; only real choices are left to report.
      const c = await checkInstances(pid, "ask");
      if (c.note) out.push(`⚠ ${c.note}`);
      f = familyOf(c.pid ?? pid) ?? f;
    }
    if (f.others.length) out.push(`⚠ ${f.target.name} (on screen in this rect) runs ${f.others.length + 1}× (${[f.target, ...f.others].map((p) => `${p.name} pid ${p.pid}`).join(", ")}). Measurements may mix them: eye_app {app:${pid}} for the choices.`);
  }
  return out;
}

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
  return { ok: true, text: String(r.text), nodes: Number(r.nodes ?? 0), rect: r.rect as number[] | undefined };
}

/**
 * What one still frame says by itself (still.ts): text sizes and contrast, near-miss alignment, uneven gaps,
 * overlaps, things cut off, corner shapes. From the image's pixels and the element tree saved next to it.
 * `at` is where the image sits on screen, in global points. "" when there is nothing to say or it cannot be read:
 * this is a reflex, it never fails the call it rides on.
 */
async function atRest(o: { image: string; raw?: string; tree: string; at: Rect }): Promise<string> {
  let raw = o.raw;
  try {
    if (!existsSync(o.tree)) return "";
    if (!raw || !existsSync(raw)) {
      raw = `${o.image}.rgba`;
      if ((await run(BIN, ["raw", "--in", o.image, "--out", raw], 4000)).code !== 0) return "";
    }
    const data = new Uint8Array(readFileSync(raw));
    // Raw pixels carry no header: the backing scale is the one that makes the rect's size come out to the byte count.
    const scale = [2, 1, 3].find((k) => Math.round(o.at.w * k) * Math.round(o.at.h * k) * 4 === data.length);
    if (!scale) return "";
    const img: Img = { w: Math.round(o.at.w * scale), h: Math.round(o.at.h * scale), data, scale, x: o.at.x, y: o.at.y };
    return still(img, JSON.parse(readFileSync(o.tree, "utf8")).windows ?? []).text;
  } catch { return ""; } finally { if (raw) rmSync(raw, { force: true }); }
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
  stopped?: string; final?: string; startNote?: string; finished: Promise<string>; opts: Options; tree?: string; treeFile?: string;
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
  /** Record this app's windows alone, over mid grey (nothing behind or over them). */
  only_pid?: number;
  /** The recorded app: its accessibility events go on the recording's clock (events.jsonl). `events: false` = don't listen. */
  events_pid?: number; events?: boolean;
  /** `root: false` = no dtrace / powermetrics beside the recording (signposts and vitals need no root and stay). */
  root?: boolean;
} & Options;

function startJob(p: RecordParams): Job {
  const hasCmd = !!p.command;
  const limit = hasCmd ? (p.timeout_s ?? 300) : (p.seconds ?? p.max_seconds ?? 300);
  const ax = p.cursor !== false && (p.ax ?? !p.profile);
  const capOpts = { rect: p.rect, display: p.display, label: p.label, keyframe_ms: p.keyframe_ms, fps: p.fps,
    seconds: hasCmd ? limit + 30 : limit, cursor: p.cursor, ax_hz: ax ? (p.ax_hz ?? 10) : 0, only_pid: p.only_pid };
  let c = startCapture({ ...capOpts, profile: p.profile });
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
    const retried: string[] = [];
    for (let attempt = 1; ; attempt++) {
      // ScreenCaptureKit can take seconds to start: never run the command (or report "recording") before frames
      // are on disk. The helper itself gives up after 8s.
      for (let i = 0; i < 95 && c.child.exitCode === null && !(existsSync(c.csv) && statSync(c.csv).size > 200); i++) await sleep(100);
      if (c.child.exitCode === null && !existsSync(c.csv)) { c.child.kill("SIGTERM"); await c.done; }
      // A short `seconds` run can finish before frames were seen here: exit 0 with a CSV is a complete run, not a failure.
      const finishedClean = c.child.exitCode === 0 && existsSync(c.csv);
      if (finishedClean || (c.child.exitCode === null && c.child.signalCode === null)) break;
      const why = await c.done;
      // Back-to-back sessions sometimes get a spurious TCC "declined" (or a wedged replayd) that sticks to the helper
      // process, so its own retries don't help: start a fresh helper, up to 3 tries.
      if (attempt < 3 && !job.stopped && /declined TCC|ScreenCaptureKit unavailable|did not respond|capture start failed/i.test(why)) {
        retried.push(why.split("\n").find((l) => /error|failed|timed out/i.test(l))?.slice(0, 160) ?? "start failed");
        const at = diedCaptures.findIndex((x) => x.startsWith(`${c.id} `));
        if (at >= 0) diedCaptures.splice(at, 1);
        rmSync(c.dir, { recursive: true, force: true });
        await sleep(700 * attempt);
        const trace = c.trace;
        c = startCapture(capOpts);
        c.trace = trace;
        job.capture = c;
        continue;
      }
      if (job.lock) job.lockResult = await stopLock(job.lock);
      job.state = "done"; job.final = `capture failed${retried.length ? ` after ${attempt} tries` : ""}: ${why}`;
      return job.final;
    }
    if (p.events_pid && p.events !== false && !job.stopped) startEvents(c, p.events_pid, capOpts.seconds + 5);
    if (p.events_pid && !job.stopped) c.under = startUnder(c.dir, p.events_pid, capOpts.seconds + 5, { root: p.root !== false, helper: BIN });
    if (retried.length) job.startNote = (`capture retried ${retried.length}× (ScreenCaptureKit refused to start: ${retried[0]})`);
    const treeMode = p.tree ?? (ax ? "basic" : "none");
    if (treeMode !== "none" && !job.stopped) {
      job.treeFile = join(c.dir, "ax_tree_start.json");
      const t = await axTree({ rect: p.rect, display: p.display, process: p.process, mode: treeMode, out: job.treeFile });
      job.tree = t.text;
      if (t.ok) writeFileSync(join(c.dir, "ax_tree_start.txt"), t.text);
    }
    await pre;
    // Never run a driver the user can still disturb: a lock that refused stops the run.
    if (job.lock && !(await job.lock.ready)) { job.stopped ??= await lockFailure(job.lock); job.lock = undefined; }
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
    snapshotStalls(c.dir); // a probe in the app: its main-thread watchdog explains the freezes in this report
    let body: string;
    try { body = report(c.csv, c.label, job.opts); }
    catch (e: any) { body = `${c.label}: could not analyze (${e.message})${existsSync(c.csv) ? "" : `\ncapture helper said: ${String(helperOut).slice(-600)}`}`; }
    const tail = job.output.slice(-15).join("\n");
    const hv = ax ? hoverTimeline(c.csv) : "";
    job.final = [
      hasCmd ? `${job.stopped ? `STOPPED (${job.stopped}) · ` : ""}command exit ${job.exitCode ?? "-"}${job.lockResult ? ` · input lock: ${job.lockResult}` : ""}` : (job.stopped && job.stopped !== "stopped by agent" ? `STOPPED (${job.stopped})` : ""),
      tail ? `command output (tail):\n${tail}` : "",
      job.startNote ?? "",
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
the-eye: your eyes and hands on a macOS screen. You act; it tells you what a person watching would have noticed, and why.

THE LOOP IS ONE CALL. eye_act {target_process, steps} presses / scrolls / drags in the app and returns:
- after every step: the pointer, the element under it (accessibility), the visible state;
- WHAT IT LOOKED LIKE: a verdict (SMOOTH · MOSTLY SMOOTH · ROUGH · BROKEN · NOTHING MOVED) and, worst first, each thing a viewer would have noticed: freezes, judder, jumps, flashes, slow answers to input, then the plain facts (how each motion travelled, overshoot, instant pops, how fast the screen answered each press). ✗ = clearly visible, ~ = visible if you look for it, · = a fact, not a defect.
With no recording running, eye_act records the target's window for exactly those steps by itself (see:false turns that off). Read the verdict; go to the table, timeline or explain only when you need numbers.

AT REST. A look at a window (eye_glance, live eye_snapshot) ends with "## at rest": what the one frame says by itself, measured from its pixels and accessibility frames without being asked. Text sizes in points and the weakest contrast (WCAG ratio, with both colours); text under 10.5pt; contrast under 4.5:1; a thing 0.5–3pt off the line its neighbours hold; a row whose gaps are not equal; siblings that overlap; a label that runs past its window; and the shape of every visible corner (square, capsule, "r≈18 circular arc", "r≈19 continuous"). The numbers are approximate (text ±5%, arc radius ±1%, continuous radius ±8%) and the rules are narrow on purpose, so an empty line means "nothing plainly off", not "perfect". Whether a faint secondary label or a circular corner is a defect is your call, not the tool's.

WHAT MOVED IT. Under each motion, "moved by:" names the physics behind the frames, fitted to them without being asked: a SPRING (damping ratio, response, and the SwiftUI call / stiffness + damping that reproduce it; how it feels), a TIMING CURVE (the named one, or its cubic-bezier, and its duration) or a PER-FRAME LERP (its factor and half-life), then what it measurably did: settle time, overshoot, where it was fastest. "or equally:" means the frames cannot tell two engines apart (a critically damped spring and an ease-out look alike); "nothing simple" means no one engine reproduces it (driven by hand, retargeted mid-flight, several animations at once). The motion line says what was seen to move ("what moved travelled 401pt right", "grew 60pt×44pt → 300pt×140pt"): a slide, a growth in both dimensions and a single moving edge are each read the way that suits them, and the "read from" note says which. "frame-rate dependent" on a lerp means it stepped once per callback and fell behind where frames dropped. These are measurements; whether that is the right motion for the thing is your call: compare the numbers with what the code asked for, and with what the platform would do (.smooth = bounce 0, .snappy 0.15, .bouncy 0.3, all 0.5s). A BOUNCE is gravity and a floor (acceleration in pt/s², when it first lands, the share of speed each rebound keeps): it lands hard and never passes its target, which is how it differs from a spring. A motion line that says "nothing moved: it dimmed/brightened in place, a fade" is an opacity or colour change: the engine under it was read from brightness alone. FROM INSIDE THE APP (eye_probe running): the eye_stop / eye_report probe report gives, per moving layer and stretch of motion, "declared:" = the Core Animation animation the app's own code attached (class, key path, from → to, duration, timing function, or a spring's mass / stiffness / damping), the same "moved by:" fit made on the layer's exact values at every display tick (no pixels, so it is exact where the screen reading is approximate), and a verdict: "✓ it ran as declared" or "≠ …" when what ran is not what the code asked for (interrupted, retargeted, stacked, slowed by dropped frames). No "declared:" line means the app drives the value itself each frame (SwiftUI on macOS, a display link): then the fit is the only account, and it is still exact. A layer that covered much of its way in ONE step gets "moved by: cannot be told" with the step, the wait before it and the main-thread block that swallowed the in-between positions; the screen reading says the same as "N% of the way went in a single frame". The probe report ends with "declared by the app's code": every Core Animation animation found, on whichever layer. RECORDED ALONE: eye_act's own recording and eye_record {process} capture only that app's windows over mid grey, so nothing behind a see-through window (an overlay, a notch) or over the app is mistaken for its motion; eye_record isolate:false records the screen as it is.

WHY IT HAPPENED. eye_probe {process} once (a Debug build; with System Integrity Protection off, any app at all, Apple's included) puts a watchdog inside the app. From then on every freeze in every report carries its cause as "why:" lines: how long the app's main thread was blocked, the app function that was running (share of stack samples) and the stack — or that the main thread was free, so the frames were lost after the app (render server, GPU, window server). No Instruments, nothing to set up per run. eye_report {view:"explain"} joins the worst frames with pointer, element, step and main thread. For a whole-run CPU profile add profile:{process} to eye_record (Instruments; takes seconds to start).
WHAT THE APP SAID. A recording of an app (eye_act's own, eye_record {process}) also listens to what the app tells accessibility: a value changed, focus moved, a window, sheet or menu came or went, an announcement. Each is put on the recording's clock under "what the app told accessibility": how long after the step, and how far into which motion. Under each "answered …" line, who was first: "the app knew first" (it told accessibility N ms before the screen began to change: the wait was in drawing, not deciding), "the screen changed first", or "yet the app reported a change" when nothing visible answered. If it says the app told accessibility nothing, assistive technology was not told what the steps changed. events:false does not listen.
UNDER THE PIXELS. A recording of an app also reads what no screen recording can. WITHOUT ROOT, always: SIGNPOSTS, what AppKit, Core Animation and the window server say of themselves (each update cycle of the app, each event it handled, each commit, and the ones the frameworks flag as stalls; each frame of the window server, how long it rendered and spent on the GPU, and the ones it marks as stalled), and VITALS twenty times a second: the energy, CPU time and wakeups the kernel billed to the app alone, the window server's own count of display updates and the display's refresh period right now. AS ROOT, when sudo runs dtrace and powermetrics without a password: each commit timed in the app, each frame swap, each time the window server learned that one of THIS APP's windows changed, and CPU time plus whole-machine GPU and CPU power. The report then says under a freeze WHO WAS LATE (the app committed nothing, and where its update cycle spent the time: handling an event, in the commit, or in its own per-frame code / the app was on time and the window server was not / both were on time and what was drawn did not change), and per motion: how often the app committed ("committed nothing" = the animation runs in the window server), how many frames reached the display and, as root, "this app's share" = how many of them carried a change of its windows and how long each took to reach the display; "inside the app" = its update cycles and what AppKit flagged; how long the window server rendered each frame; what moving cost against rest, for the whole machine and for the app alone (mW, share on performance cores, wakeups). A frame the window server marks as stalled is told with its rendering time: "it was waiting, not working" means a client kept it waiting. root:false leaves out only the root readers. Nothing ever asks for a password: ${ROOT_HINT}.

USE IT BY DEFAULT: this is how you test a macOS app's UI (SwiftUI or AppKit) yourself. After a UI change builds, launch the app and verify it here: find the element, drive it, read what it looked like. Don't hand the check to the user ("try it and tell me"). Only skip the-eye when the user says they'll drive the test.

WHEN TO USE WHAT
- Find UI / coordinates: eye_inspect {process} for an app's element tree with frames (or {rect} for what's visible there, {} for the element under the pointer). Those frames are eye_act's x/y.
- A still image: eye_snapshot {rect}. Don't record for a static look.
- A window that may be covered or in the background (state check, a short poke): eye_glance {app, look:["image","tree"], steps?}. It holds the user for well under a second and puts everything back.
- Several eye_act calls on one timeline, or anything longer: eye_record {process} (that app's window; or {rect}) → eye_act … → eye_stop for the report.
- A scripted, repeatable A/B: eye_record {rect, command:"./drive", lock_input:true, ax:false, label:"A"} (blocks, returns the report), again for B, then eye_report {runs:[…]}.
- Only when the user says they'll drive: ask "Ready?", wait for yes, then eye_record with NO input lock, let them act, eye_stop.
- Long background runs: eye_record {…, background:true} → eye_peek every few seconds → eye_stop.
- Later: eye_report {} re-reads the most recent run (view: summary | timeline | explain | hover; {runs} compares). Keyframe images: eye_snapshot {csv, t_s} (record with keyframe_ms).

KNOW THESE
- Coordinates are POINTS, top-left origin. rect is display-local (eye_status lists displays). Pointer, AX frames and eye_act x/y are global; on the main display both are the same.
- AX costs performance: an AX client makes SwiftUI apps rebuild their accessibility graph (~18% more main-thread time, up to −25% fps). eye_record has ax on by default (off with profile). For final fps numbers or A/B comparisons use ax:false, and compare runs recorded the same way. Reports say when AX was on.
- eye_act input is synthetic. It reaches apps through a different path than a physical trackpad (event taps, hover shields and pointer-location APIs can see it differently). If a bug doesn't reproduce with eye_act, vary it yourself (speeds, phased vs unphased scroll, scroll with momentum, hover paths, a CGEvent driver via eye_record command) and report what you tried and what each run measured.
- The pointer position in live data / cursor.csv comes from the window server. An app whose event tap swallows mouse moves (e.g. NOOTCH!'s hover shield over the notch) freezes it, so live hover can lag; eye_act's p is the position it actually posted.
- The measured extent (a, e) is a pixel difference. Translucent glass over a similar background can measure smaller than the real view: for true bounds use AX frames (eye_inspect, h.frame), and keep wait_until thresholds loose.
- eye_act safety: presses and two-finger gestures (pinch, rotate, smart_zoom, swipe) only land on target_process (name or pid, or the app of a running eye_probe); scrolls only inside the measured open area or a scroll_zones rect. Every lock (eye_act's automatic one, eye_record lock_input, eye_lock, eye_glance) blocks ALL physical input: trackpad, mouse, gestures, keyboard, media keys, and it pins the cursor. Two styles: full = a 1.5s on-screen 3·2·1 warning, then the orange overlay on every screen (budget ~1.5s per eye_act call that takes its own; a session eye_lock pays it once and eye_act calls inside it just extend it); quick ("Just a sec…") = no countdown, a small pill under the menu bar, engages in ~0.1-0.2s, used for checks of ≤5s (eye_glance, eye_act with front). Before any warning a preflight checks permission, a rival lock and that every pointing device can be seized: a refusal comes back at once as "input lock refused — preflight: …" and nothing ran. If the user is mid-drag / scroll / fling / pinch the lock waits up to 1.2s for them to let go, then ends that action cleanly (the report lists it). The user's only way out is Esc 6× in a row, ≤1s apart (emergency; the overlay shows the count). Never lock while the user should be acting.
- Covered windows: a press on a window hidden behind another app's window is refused (it would land on the wrong app). eye_act raises the target's window automatically when that happens (front: auto) and retries once, then puts the window back exactly where it was in the stacking order and returns focus; front:true raises before the first step, front:false never does. eye_glance does the same for a quick look.
- ONE AT A TIME. Only one agent session drives the screen. Driving tools (eye_act, eye_glance, eye_lock, eye_record, eye_probe, eye_app launch/quit) take turns: if another session is mid-turn, your call waits in a FIFO queue inside the server and then runs and returns its normal result (noted "waited Ns in the queue") — don't retry or sleep yourself. Between your calls your turn passes to anyone waiting; a lock, recording or probe you keep running holds it, so end those promptly (your replies say when someone is queued). After ~45s queued you get "QUEUED, not run …": nothing happened, call again within 20s to keep your place, or do read-only work (always available). eye_status shows the holder and the queue.
- ONE APP COPY, checked by the server itself. An app counts every copy AND every other build of it (NOOTCH!-Dev, NOOTCH!, a Setapp build…): they all draw and answer AX. Before eye_act (target_process or the probe's target), eye_probe and eye_record {process} it checks and, if several run, STOPS with the list and the choices: duplicates:"quit_others" (keep the target), "relaunch" (quit all, start the target's .app fresh, or app_path = the build you just made), "allow", or stop and ask the user (one may be theirs). Recordings also flag duplicated apps found in their rect. Once it has seen an app it watches it: a copy launched later (by you, Xcode or the user) shows up as ⚠ in the next tool result and in eye_status. To start the app, prefer eye_app {action:"launch", app_path}: it never makes a second copy.
- Needs Screen Recording (capture) and Accessibility (AX, input, lock) permission for the host app.
- WAITING ON THE SCREEN: don't loop eye_glance / eye_inspect to wait for a dialog, a window, a title or a status text. \`${WATCH_CMD}\` prints one line per UI event as it happens (app-launched/quit/focused, window-opened/closed/focused, sheet-opened/closed, title-changed, announced, and with --values text/progress value-changed). Dialogs, sheets and banners include their text and [buttons]. It only reads AX, so it takes no turn, locks nothing and needs no screenshots. --app NAME limits it to apps (repeatable). Stream it with your Monitor tool if you have one, or for a single "tell me when": run it in the background with --until "TEXT" (case-insensitive substring of a line; exits 0 on the first match, including a window already showing it) and --seconds N (exits 124 if nothing matched). Example: ${WATCH_CMD} --app Xcode --until "Build Succeeded" --values --seconds 600.
- Run files live in ~/Library/Caches/the-eye/runs/<time>_<label>/: frames.csv, cursor.csv, hover.jsonl, ax_tree_start.txt/.json, actions.jsonl, events.jsonl (what the app told accessibility), keyframes/.

TOOLS: eye_status · eye_inspect · eye_snapshot · eye_glance · eye_record · eye_peek · eye_act · eye_stop · eye_report · eye_lock · eye_probe · eye_app
`.trim();

const server = new McpServer({ name: "the-eye", version: "0.3.0" }, { instructions: INSTRUCTIONS });

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
    ...watchedStatus(),
    ...freshEvents(),
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
    process: z.coerce.string().optional().describe("Only this app's windows (name substring or pid), visible or not."),
    tree: treeSchema.optional().describe("basic (default with rect): labeled elements only, unlabeled layout groups folded. full: every node + its actions. none."),
    depth: z.number().int().optional().describe("Max tree depth (default 40 basic / 60 full)."),
    max_nodes: z.number().int().optional().describe("Max printed nodes (default 250 basic / 2000 full)."),
  },
}, async (p) => {
  const out: string[] = [];
  const mode = p.tree ?? (p.rect || p.process ? "basic" : "none");
  // Asked about an app: its tree is the answer, not whatever the pointer happens to be over.
  if (!p.rect && !(p.process && p.x === undefined && p.y === undefined)) {
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
  return withNotes(text(out.join("\n\n")));
});

server.registerTool("eye_snapshot", {
  title: "Image of a region (live or recorded)",
  description: "Live: one PNG of a screen region {rect}. Recorded: the saved keyframes of a run closest to a time {csv, t_s} (record with keyframe_ms). Returns paths; return_image adds the image(s) inline.",
  inputSchema: {
    rect: rectSchema.optional(), display: z.number().int().optional(), path: z.string().optional(),
    csv: z.string().optional().describe("frames.csv of a recording, to get its keyframes instead of a live image."),
    t_s: z.number().optional(), count: z.number().int().min(1).max(8).optional(),
    return_image: z.boolean().optional(),
    measure: z.boolean().optional().describe("Live: also read the frame at rest (text sizes, contrast, near-miss alignment, uneven gaps, overlaps, cut-off, corner shapes) from its pixels and the element tree there. Default true, except while a recording runs (reading the tree costs the app some frames)."),
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
  const measure = p.measure ?? !activeJob();
  const args = ["snapshot", "--rect", rectArg(rect), "--out", out];
  if (measure) args.push("--raw", `${out}.rgba`);
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
  if (measure) {
    const tree = join(p.path ? runDir("snapshot") : dirname(out), "ax_tree.json"); // never beside a path the caller chose
    const t = await axTree({ rect, display: p.display, mode: "basic", out: tree });
    // The tree op answers with the rect in global points: that is where the image sits.
    const seen = t.ok && t.rect ? await atRest({ image: out, raw: `${out}.rgba`, tree, at: { x: t.rect[0], y: t.rect[1], w: rect.w, h: rect.h } }) : "";
    if (seen) content.push({ type: "text", text: seen });
    rmSync(`${out}.rgba`, { force: true });
  }
  if (p.return_image) content.push({ type: "image", data: readFileSync(out).toString("base64"), mimeType: "image/png" });
  return { content };
});

server.registerTool("eye_record", {
  title: "Record a region (and optionally run a command)",
  description: [
    "Record a screen region — or, with `process` and no rect, that app's window — at the display's full refresh rate, with the pointer",
    "and (ax) the element under it. The report opens with what a viewer would have noticed. Three modes:",
    "(1) no command, no seconds → starts in the background and returns an id at once with the AX tree of what's there; act",
    "(eye_act, or the user), then eye_stop for the report. (2) seconds → records that long and returns the report.",
    "(3) command → runs a shell command (your input driver) while recording, optionally with the physical pointer locked",
    "(lock_input), keeps recording post_ms after it exits, returns command output + report. background:true makes (2)/(3)",
    "return an id at once — poll eye_peek, eye_stop to end early. The command gets env THE_EYE_LIVE (JSON refreshed 10×/s: moving,",
    "extent, last_1s stats, hover), THE_EYE_RECT and THE_EYE_RUN_DIR.",
  ].join(" "),
  inputSchema: {
    rect: rectSchema.optional().describe("Region to record, display-local points. Omit it and pass `process` to record that app's window, wherever it is."),
    window: z.string().optional().describe("Without rect: which of the app's windows (title substring). Default its main window, else the largest."),
    events: z.boolean().optional().describe("With a process: also listen to what the app tells accessibility while it is recorded (values, focus, windows, sheets, menus, announcements) and place each on the recording's clock, next to the motion and the steps (default true; false = don't attach an observer)."),
    root: z.boolean().optional().describe("With an app recording, when sudo runs dtrace and powermetrics without a password: also time the app's commits and the window server's frame swaps as root, count which display frames carried a change of THIS app's windows, and read whole-machine GPU/CPU power. Default true; false = leave them out (the signposts and the app's own energy need no root and are always read)."),
    isolate: z.boolean().optional().describe("With process and no rect: record that app's own windows only, over mid grey, so nothing behind a see-through window or over the app is mistaken for its motion (default true). false = the screen as it is, other apps included."),
    label: z.string().optional().describe("Name for this run (used in the run folder and reports)."),
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
    duplicates: z.enum(["ask", "quit_others", "relaunch", "allow"]).optional().describe(duplicatesSchemaDescription),
    app_path: z.string().optional().describe("For duplicates:\"relaunch\": the .app to start instead of the target's own (e.g. the build you just made)."),
    ...axOpts,
    ...analysisOpts,
  },
}, driving("eye_record", fail, async (p) => {
  let instNote = "";
  if (p.process) {
    const c = await checkInstances(p.process, p.duplicates, p.app_path);
    if (!c.ok) return fail(c.error);
    instNote = c.note ?? "";
    if (c.pid && (c.note?.startsWith("relaunched") || /^\d+$/.test(String(p.process)))) p.process = String(c.pid);
    try { (p as RecordParams).events_pid = c.pid ?? (await resolvePid(p.process)).pid; } catch { /* reported below, or recorded by rect alone */ }
  }
  if (!p.rect) {
    if (!p.process) return fail("pass rect, or process (records that app's window)");
    let w: Awaited<ReturnType<typeof windowRect>>;
    let pid: number;
    try { pid = (await resolvePid(p.process)).pid; w = await windowRect(pid, p.window); } catch (e: any) { return fail(e.message); }
    if (!w.ok) return fail(w.error);
    p.rect = w.rect; p.display ??= w.display;
    if (p.isolate !== false) (p as RecordParams).only_pid = pid;
    instNote = [instNote, `recording the window ${w.what}${p.isolate !== false ? ", the app's own windows only: what is behind a see-through window or over it is left out (isolate:false records the screen as it is)" : w.on_top ? "" : " — it is NOT the front window, so other windows over it are recorded too (eye_act front:true raises it)"}`].filter(Boolean).join("\n");
  }
  const rect = p.rect;
  const job = startJob({ ...p, rect });
  const blocking = p.background === undefined ? !!(p.command || p.seconds) : !p.background;
  if (blocking) {
    const final = await job.finished;
    const tree = job.tree ? `\n\nobserved windows at start (AX tree, global points):\n${capLines(job.tree, 60, `full tree: ${join(job.capture.dir, "ax_tree_start.txt")}`)}` : "";
    return text([instNote, ...(await observedConflicts(job, rect)), `${job.id} done\n\n${final}${tree}`, ...freshEvents()].filter(Boolean).join("\n"));
  }
  for (let i = 0; i < 600 && job.state === "starting"; i++) await sleep(50); // up to 3 helper starts
  if (job.state === "done") return fail(job.final ?? "capture failed");
  const live = readLive(job.capture);
  return text([
    `${job.id} recording "${job.label}" ${rectArg(rect)}${p.display !== undefined ? ` on display ${p.display}` : ""} → ${job.capture.csv}`,
    job.startNote ?? "",
    job.output.length ? job.output.join("\n") : "",
    job.ax ? "AX inspection ON (hover + tree): fps can read lower on SwiftUI apps; use ax:false for final numbers." : "AX inspection off.",
    describeLive(live),
    job.tree ? `observed windows (AX tree, global points):\n${capLines(job.tree, 120, `full tree: ${join(job.capture.dir, "ax_tree_start.txt")}`)}` : "",
    `next: eye_act {steps, target_process} · eye_peek {id:"${job.id}"} · eye_stop {id:"${job.id}"}`,
    instNote, ...(await observedConflicts(job, rect)), ...freshEvents(),
  ].filter(Boolean).join("\n"));
}));

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
    snapshotStalls(cap.dir);
    const o = { ...job.opts, from_s: Math.max(0, t - w) };
    lines.push(`last ${w}s: ${formatSeen(notice(rows, meta, analyze(rows, meta, o), { ...o, dir: cap.dir, still_recording: true }), 4)}`);
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
  return withNotes(text(lines.join("\n")));
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
  op: z.enum(["move", "click", "down", "up", "scroll", "pinch", "rotate", "smart_zoom", "swipe", "press", "force_click", "wait", "wait_until", "assert"]),
  x: z.number().optional(), y: z.number().optional(),
  ms: z.number().optional().describe("move: glide duration (0 = jump); wait: duration; pinch/rotate: gesture duration (default 300); press/force_click: whole press (default 400/700)"),
  force: z.union([z.array(z.number().min(0).max(2)).min(2), z.boolean()]).optional().describe("press/force_click: Force Touch pressure keyframes spread over ms, eased between. 0…1 = stage 1 (normal click pressure), crossing 1 = the force click (stage 2), 1…2 = pressure inside stage 2. press default [0,0.5,0]; force_click default [0,0.9,1.5,1.5,0.9,0] — OR scroll: skip the inside-the-open-area safety check. Presses (click/down) can NOT be forced."),
  behavior: z.number().int().optional().describe("press/force_click: NSPressureBehavior the events claim (default 5, deep click: the system default)"),
  button: z.enum(["left", "right"]).optional(), count: z.number().int().optional(), hold_ms: z.number().optional(),
  dy: z.number().optional(), dx: z.number().optional(), events: z.number().int().optional(),
  interval_ms: z.number().optional(), phased: z.boolean().optional().describe("scroll: trackpad phases (default true)"),
  momentum: z.boolean().optional().describe("scroll: after the fingers lift, coast like a trackpad fling (momentum phases, decaying deltas)"),
  decay: z.number().min(0.5).max(0.99).optional().describe("scroll momentum: per-event velocity factor (default 0.94; higher coasts longer)"),
  scale: z.number().positive().optional().describe("pinch: total zoom factor (2 = spread to double, 0.5 = pinch to half)"),
  degrees: z.number().optional().describe("rotate: total rotation, + = clockwise"),
  direction: z.enum(["left", "right", "up", "down"]).optional().describe("swipe: navigation swipe direction (left = back in browsers)"),
  expr: z.string().optional().describe("wait_until/assert: JS expression over a, e, moving, fps1, gap1, p, h, live, pr, L()"),
  timeout_ms: z.number().optional().describe("wait_until timeout (default 2000)"),
  guard: z.string().optional().describe("Expression that must hold BEFORE this step runs, else the sequence stops."),
  on: z.union([z.string(), z.number()]).optional().describe("click/down/move: aim at a probe layer (label substring or layer id) instead of x,y — its centre, from the probe's live data. The layer must be in the live moving/watched lists (eye_probe watch)."),
  note: z.string().optional(),
});

server.registerTool("eye_act", {
  title: "Act and observe",
  description: [
    "Drive the pointer step by step and get, after EVERY step, the pointer position, the accessibility element under it, and the",
    "measured visible state — so you can think and react between calls. Steps: move {x,y,ms}, click {x?,y?,button,count},",
    "down/up {button} (drag = down, move, up), scroll {dy,dx,events,phased,momentum} (two-finger scroll; momentum = fling),",
    "two-finger trackpad gestures at x,y or the pointer: pinch {scale,ms}, rotate {degrees,ms}, smart_zoom (double-tap), swipe {direction};",
    "Force Touch at x,y or the pointer: press {force:[keyframes 0…2],ms} (mouse down → pressure curve → up; past 1 = stage 2), force_click {ms};",
    "wait {ms}, wait_until {expr,timeout_ms}, assert {expr}.",
    "Any step may carry `guard`. Expressions see: a = top-anchored open extent {x0,x1,w,h,cx} or null, e = bbox of all change,",
    "moving, fps1, gap1 (ms), p = pointer {x,y}, h = element under the pointer (role, title, description, identifier, value, frame,",
    "path, app, enabled, focused, selected, actions) or null, live = raw live JSON, pr / L('label') = probe layers.",
    "e.g. wait_until {expr:\"h?.identifier=='close'\"}. Find targets first with eye_inspect. SAFETY: presses and gestures only on target_process;",
    "scroll only inside `a` or scroll_zones unless force. Blocks ALL the user's physical input (trackpad + keyboard) while it runs.",
    "With no eye_record running it records target_process's window for these steps itself and ends with WHAT IT LOOKED LIKE: a verdict",
    "and what a viewer would have noticed, worst first (freezes with their cause when eye_probe is loaded, judder, jumps, flashes, how fast",
    "the screen answered each press). Input is synthetic (see the guide if a bug won't reproduce with it).",
  ].join(" "),
  inputSchema: {
    steps: z.array(stepSchema).min(1).max(60),
    id: z.string().optional().describe("Recording whose live state to use (default: most recent running)."),
    target_process: z.union([z.string(), z.number()]).optional().describe("App that presses must land on (name or pid). Default: the app of the running eye_probe. Presses are refused without a target."),
    scroll_zones: z.array(rectSchema).optional().describe("Extra screen rects (points) where scrolling is allowed, e.g. the closed notch."),
    label: z.string().optional().describe("Phase name recorded with these steps in the run's action log (eye_report view:'explain' groups by it)."),
    ax: z.boolean().optional().describe("Report the element under the pointer after each step (default: the recording's ax setting, true without a recording)."),
    tree: treeSchema.optional().describe("After the steps, also dump the AX tree of the recorded region (or the window under the pointer). Default none."),
    events: z.boolean().optional().describe("With its own recording: also listen to what the app tells accessibility while it is recorded (values, focus, windows, sheets, menus, announcements) and place each on the recording's clock, next to the motion and the steps (default true; false = don't attach an observer)."),
    root: z.boolean().optional().describe("With an app recording, when sudo runs dtrace and powermetrics without a password: also time the app's commits and the window server's frame swaps as root, count which display frames carried a change of THIS app's windows, and read whole-machine GPU/CPU power. Default true; false = leave them out (the signposts and the app's own energy need no root and are always read)."),
    see: z.boolean().optional().describe("With no eye_record running: record target_process's window for these steps and report what it looked like (default true; costs ~0.3s before the first step and up to 1.5s after the last, while motion settles)."),
    lock: z.boolean().optional().describe("Block all physical input for exactly the duration of these steps (default true)."),
    lock_style: z.enum(["full", "quick"]).optional().describe("full: 1.5s 3·2·1 warning, orange overlay. quick: \"Just a sec…\" — no countdown, small pill. Default: quick when front:true and the steps take ≤5s, else full."),
    front: z.boolean().optional().describe("Bring target_process's window to the very front before the steps and put everything back after (z-order, focus, frame, minimized). Default: automatic — only when a press is refused because another app covers the target. false = never."),
    window: z.string().optional().describe("front: which of the app's windows (title substring). Default its main/focused window, else the largest."),
    duplicates: z.enum(["ask", "quit_others", "relaunch", "allow"]).optional().describe(duplicatesSchemaDescription),
    app_path: z.string().optional().describe("For duplicates:\"relaunch\": the .app to start instead of the target's own (e.g. the build you just made)."),
  },
}, driving("eye_act", fail, async (p) => {
  const named = p.target_process ?? activeProbeTarget()?.pid;
  let instNote = "";
  if (named !== undefined) {
    const c = await checkInstances(named, p.duplicates, p.app_path);
    if (!c.ok) return fail(c.error);
    instNote = c.note ?? "";
    if (c.pid) p.target_process = c.pid;
  }
  let target: { pid: number; name: string } | null = null;
  try { target = p.target_process !== undefined ? await resolvePid(p.target_process) : activeProbeTarget(); }
  catch (e: any) { return fail(e.message); }
  const budget = p.steps.reduce((t, s) => t + (s.ms ?? 0) + (s.timeout_ms ?? (s.op === "wait_until" ? 2000 : 0)) + (s.hold_ms ?? 0) + 400, 0);
  if (p.front && !target) return fail("front:true needs target_process (the app whose window to bring forward)");
  // Hands without eyes are no use: with no recording running, watch the target's window for exactly these steps
  // (started before the lock, so the user is not held while ScreenCaptureKit warms up).
  let auto: Job | undefined, autoWhat = "", autoNote = "";
  if (p.see !== false && target && !activeJob(p.id)) {
    const w = await windowRect(target.pid, p.window);
    if (w.ok) {
      auto = startJob({ rect: w.rect, display: w.display, label: p.label ?? "act", ax: false, tree: "none", max_seconds: Math.ceil(budget / 1000) + 30, only_pid: target.pid, events_pid: target.pid, events: p.events, root: p.root });
      for (let i = 0; i < 60 && auto.state === "starting"; i++) await sleep(50);
      if (auto.state === "running") { autoWhat = `${target.name} ${w.what}, its own windows only`; p.ax ??= true; p.id = auto.id; }
      else { auto.stopped ??= "not ready in time"; auto.stopNow(); auto = undefined; autoNote = "(could not record the window for these steps: the capture did not start within 3s — the steps ran unwatched; eye_record first for the visible result)"; }
    } else autoNote = `(not watching these steps: ${w.error})`;
  }
  const settleMs = auto ? 1700 : 0;
  let strictLock: Lock | undefined;
  // A session lock (eye_lock / lock_input) already covers us, including between calls mid-drag; extended if short.
  const covered = !!(await coveringLock(budget + settleMs));
  if (p.lock !== false && !covered) {
    // A short look at a window brought forward is a "Just a sec…" (no countdown); anything longer warns with 3·2·1.
    const style: LockStyle = p.lock_style ?? (p.front && budget <= QUICK_MAX_MS ? "quick" : "full");
    strictLock = startLock(Math.min(300, Math.ceil((budget + settleMs) / 1000) + 15), "tagged", style);
    if (!(await strictLock.ready)) { if (auto) { auto.stopped ??= "lock refused"; auto.stopNow(); } return fail(await lockFailure(strictLock)); }
  }
  const front: Front = { want: p.front, window: p.window };
  let result: ReturnType<typeof text> | undefined;
  let seenFrom = 0, seenTo: number | undefined;
  try {
    if (p.front && target) {
      const r = await raiseWindow(target.pid, p.window);
      if (!r.ok) return fail(`front: ${r.error}`);
      front.raised = r;
      if (auto) await sleep(150); // let the raise itself draw before the steps: it is not what we came to see
    }
    if (auto) seenFrom = readLive(auto.capture)?.t ?? 0;
    result = await actSteps({ ...p, auto_seen: !!auto }, target, front);
    if (auto) {
      // Still under the lock: whatever the steps set in motion plays out undisturbed (until 200ms of stillness, 1.5s at most).
      await sleep(120);
      for (let still = 0, end = Date.now() + 1500; still < 4 && Date.now() < end; await sleep(50)) still = readLive(auto.capture)?.moving ? 0 : still + 1;
      seenTo = readLive(auto.capture)?.t;
    }
  } finally {
    // Window back first, input free last: the user gets their screen back exactly as it was.
    const back = front.raised ? await restoreWindow(front.raised) : "";
    if (strictLock) await stopLock(strictLock);
    if (result && front.raised) result.content.push({ type: "text", text: `brought ${fmtWin(front.raised)} forward${front.auto ? " (automatically: another app covered the press)" : ""} in ${front.raised.raise_ms}ms · ${back}` });
    if (auto) {
      auto.stopped ??= "stopped by agent";
      auto.stopNow();
      await auto.finished;
      if (result) {
        let looked: string;
        try { looked = seen(auto.capture.csv, { from_s: seenFrom, to_s: seenTo }); } catch (e: any) { looked = `could not analyze: ${e.message}`; }
        result.content.push({ type: "text", text: `WHAT IT LOOKED LIKE — ${autoWhat}, recorded for these steps (times on the recording's clock):\n${looked}\nrun: ${auto.capture.dir} · eye_report {view:"explain"} joins the worst frames with pointer, step and main thread` });
      }
    }
  }
  return withNotes(result!, instNote, autoNote);
}));

// ---- bring a window forward, put it back

const QUICK_MAX_MS = 5000;
type Front = { want?: boolean; window?: string; raised?: any; auto?: boolean };
/** Raise a window of `pid` to the very front (AX raise + frontmost); the reply is what restoreWindow needs. */
async function raiseWindow(pid: number, window?: string | number): Promise<any> {
  const r = await actorSend({ op: "raise", pid, ...(typeof window === "number" ? { number: window } : window ? { title: window } : {}) });
  return r;
}
/** Undo raiseWindow: frame, minimized state, focus and the z-order of every window above it. One line for the report. */
async function restoreWindow(raised: any): Promise<string> {
  const r = await actorSend({ ...raised, op: "restore" });
  if (!r.ok) return `⚠ could not put the window back: ${r.error}`;
  return r.order_restored === false ? `⚠ window put back, but the z-order differs from before (${r.restored})` : `window put back (${r.restored})`;
}
/** Where an app's window is, as a display-local rect clipped to its display. Nothing is raised or moved. */
async function windowRect(pid: number, window?: string): Promise<{ ok: true; rect: Rect; display: number; what: string; on_top: boolean } | { ok: false; error: string }> {
  const r = await actorSend({ op: "raise", locate: true, pid, ...(window ? { title: window } : {}) });
  if (!r.ok) return { ok: false, error: String(r.error) };
  if (r.minimized) return { ok: false, error: `window "${r.title}" is minimized: nothing of it is on screen (eye_glance brings it up for a look)` };
  const [fx, fy, fw, fh] = r.frame as number[], [dx, dy, dw, dh] = r.display_bounds as number[];
  const x0 = Math.max(fx, dx), y0 = Math.max(fy, dy), x1 = Math.min(fx + fw, dx + dw), y1 = Math.min(fy + fh, dy + dh);
  if (x1 - x0 < 8 || y1 - y0 < 8) return { ok: false, error: `window "${r.title}" is off screen` };
  const rect = { x: Math.round(x0 - dx), y: Math.round(y0 - dy), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
  return { ok: true, rect, display: Number(r.display), what: `"${r.title || "untitled"}" [${rectArg(rect)}]`, on_top: !!r.on_top };
}
const fmtWin = (r: any) => `"${r.title || "untitled"}" #${r.number} [${r.frame.map((v: number) => v.toFixed(0)).join(",")}]`;

async function actSteps(p: any, target: { pid: number; name: string } | null, front: Front = {}) {
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
    let pressNote = "";
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
        if (s.op === "scroll" && s.force !== true) {
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
        const gesture = ["pinch", "rotate", "smart_zoom", "swipe", "press", "force_click"].includes(s.op);
        if (s.op === "click" || s.op === "down" || gesture) {
          // Presses and gestures can never land outside the target app: no force, both checks always run.
          if (!target) { stopped = `${tag}: REFUSED ${gesture ? "gesture" : "press"} — no target app (pass target_process, or run eye_probe)`; break; }
          const at = { x: cmd.x ?? ptr.x, y: cmd.y ?? ptr.y };
          // Aimed at a layer (`on`): the point must still be inside it. Otherwise the actor's owner check below is the guard.
          if (aimed && !(at.x >= aimed[0] && at.x <= aimed[0] + aimed[2] && at.y >= aimed[1] && at.y <= aimed[1] + aimed[3])) {
            stopped = `${tag}: REFUSED press at ${at.x.toFixed(0)},${at.y.toFixed(0)} — outside the layer it was aimed at`; break;
          }
          if (s.op === "down" && (cmd.x !== undefined || cmd.y !== undefined)) {
            const mv = await actorSend({ op: "move", x: at.x, y: at.y, ms: 0 });
            if (!mv.ok) { stopped = `${tag}: ${mv.error}`; break; }
          }
          cmd.require_pid = target.pid; // the actor re-checks the topmost window owner right before posting
        }
        let r = await actorSend(cmd);
        // The press was refused because another app's window covers the target there: bring the target's window
        // forward (put back when the call ends) and try once more — unless the caller said front:false.
        if (!r.ok && target && front.want !== false && !front.raised && /REFUSED press .*(belongs to|topmost window)/.test(String(r.error))) {
          const up = await raiseWindow(target.pid, front.window);
          if (up.ok) { front.raised = up; front.auto = true; await sleep(50); r = await actorSend(cmd); }
        }
        if (!r.ok) { stopped = `${tag}: ${r.error}${/REFUSED press/.test(String(r.error)) && front.want === false ? " (front:false — not raising it)" : ""}`; break; }
        ptr = { x: r.x, y: r.y };
        if (r.peak_force !== undefined) pressNote = ` · peak force ${r.peak_force}${r.force_clicked ? " (force click: reached stage 2)" : " (stage 1 only)"}`;
        await look();
      }
      lines.push(`${stamp()} ${tag}${pressNote} → p(${ptr.x.toFixed(0)},${ptr.y.toFixed(0)}) · ${short(readNow())}${over()}`);
    } catch (err: any) { stopped = `${tag}: ${err.message}`; break; }
    finally { if (s.op !== "assert") logAction(s, wall0, stopped === stoppedBefore); }
  }
  const live = readNow();
  let recent = "";
  if (cap && !p.auto_seen) {
    try {
      const { rows, meta } = loadRun(cap.csv);
      const t = live?.t ?? 0, w = Math.max(1, (Date.now() - t0) / 1000);
      snapshotStalls(cap.dir);
      const o = { ...job!.opts, from_s: Math.max(0, t - w) };
      recent = `during these steps: ${formatSeen(notice(rows, meta, analyze(rows, meta, o), { ...o, dir: cap.dir, still_recording: true }), 5)}`;
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

// ---- eye_glance: "Just a sec…" — bring a window forward, look, put it back

server.registerTool("eye_glance", {
  title: "Just a sec: bring a window forward, look, put it back",
  description: [
    "One call for a quick look at a window that may be covered, minimized or behind the user's work: holds the user's input",
    "with the \"Just a sec…\" lock (no countdown; waits for a drag/scroll in progress to finish), brings the app's window",
    "to the very front, takes what you ask for (image of the window, its AX tree, the element at a point, a few eye_act",
    "steps), then puts the screen back exactly as it was (z-order, focused app, frame, minimized) and frees input. The",
    "user is held for well under a second for an image + tree. Use it instead of activating apps yourself.",
  ].join(" "),
  inputSchema: {
    app: z.union([z.string(), z.number()]).describe("App name (any build) or pid."),
    window: z.string().optional().describe("Which window (title substring). Default its main/focused window, else the largest."),
    look: z.array(z.enum(["image", "tree", "element"])).optional().describe("What to take while it's in front (default [image, tree]). element = everything about the element at x,y."),
    x: z.number().optional(), y: z.number().optional().describe("element: the point (global). Default the window's centre."),
    rect: rectSchema.optional().describe("image: this display-local rect instead of the whole window."),
    tree: z.enum(["basic", "full"]).optional().describe("tree mode (default basic)."),
    steps: z.array(stepSchema).max(12).optional().describe("Optional eye_act steps to run while it's in front (keep them short: ≤5s stays a quick lock)."),
    settle_ms: z.number().min(0).max(2000).optional().describe("Wait after raising before looking, so it has drawn (default 80)."),
    return_image: z.boolean().optional().describe("Include the image inline (default true)."),
    duplicates: z.enum(["ask", "quit_others", "relaunch", "allow"]).optional().describe(duplicatesSchemaDescription),
  },
}, driving("eye_glance", fail, async (p) => {
  const inst = await checkInstances(p.app, p.duplicates);
  if (!inst.ok) return fail(inst.error);
  let target: { pid: number; name: string };
  try { target = await resolvePid(inst.pid ?? p.app); } catch (e: any) { return fail(e.message); }
  const look = new Set(p.look ?? ["image", "tree"]);
  const stepsMs = (p.steps ?? []).reduce((t, s) => t + (s.ms ?? 0) + (s.timeout_ms ?? (s.op === "wait_until" ? 2000 : 0)) + (s.hold_ms ?? 0) + 400, 0);
  const t0 = Date.now();
  const cover = await coveringLock(stepsMs + 3000);
  const own = cover ? undefined : startLock(Math.ceil((stepsMs + 8000) / 1000), "tagged", stepsMs > QUICK_MAX_MS ? "full" : "quick");
  if (own && !(await own.ready)) return fail(await lockFailure(own));
  const tLocked = Date.now();
  const marks: string[] = [`lock ${tLocked - t0}ms`];
  let tm = tLocked;
  const mark = (n: string) => { const now = Date.now(); marks.push(`${n} ${now - tm}ms`); tm = now; };
  const out: string[] = [];
  const content: any[] = [];
  const rest: { image?: string; tree?: string; at?: Rect } = {}; // the frame and the tree of one look: read after input is free
  let raised: any;
  let back = "";
  try {
    raised = await raiseWindow(target.pid, p.window);
    if (!raised.ok) return fail(`could not bring ${target.name} forward: ${raised.error}`);
    out.push(`${target.name} ${fmtWin(raised)} ${raised.already_front ? "was already in front" : `brought forward in ${raised.raise_ms}ms`}${raised.was_minimized ? " (was minimized)" : ""}`);
    if (raised.warning) out.push(`⚠ ${raised.warning}`);
    mark("raise");
    await sleep(p.settle_ms ?? 80);
    mark("settle");
    const [fx, fy, fw, fh] = raised.frame as number[];
    const [ox, oy] = (raised.display_origin ?? [0, 0]) as number[];
    // Everything below only reads: run the image and the AX work side by side to keep the hold short.
    const tasks: Promise<void>[] = [];
    const gdir = runDir("glance");
    if (look.has("image")) tasks.push((async () => {
      const rect = p.rect ?? { x: fx - ox, y: fy - oy, w: fw, h: fh };
      const file = join(gdir, "glance.png");
      let r = await run(BIN, ["snapshot", "--rect", rectArg(rect), "--out", file, "--raw", `${file}.rgba`, "--display", String(raised.display ?? "")].filter(Boolean), 6000);
      if (r.code !== 0) r = await run("/usr/sbin/screencapture", ["-x", "-R", `${rect.x + ox},${rect.y + oy},${rect.w},${rect.h}`, file], 8000);
      if (r.code !== 0 || !existsSync(file)) { out.push(`image failed: ${(r.stderr || r.stdout).trim().slice(-300)}`); return; }
      out.push(`image: ${file}`);
      rest.image = file; rest.at = { x: rect.x + ox, y: rect.y + oy, w: rect.w, h: rect.h };
      if (p.return_image !== false) content.push({ type: "image", data: readFileSync(file).toString("base64"), mimeType: "image/png" });
    })());
    if (look.has("tree")) tasks.push((async () => {
      const treeFile = join(gdir, "ax_tree.json");
      const t = await axTree({ rect: { x: fx - ox, y: fy - oy, w: fw, h: fh }, display: raised.display, process: String(target.pid), mode: p.tree ?? "basic", out: treeFile });
      if (t.ok) rest.tree = treeFile;
      out.push(`element tree (${p.tree ?? "basic"}, ${t.nodes} nodes; global points):\n${capLines(t.text, 120, "narrow with rect/tree:full via eye_inspect")}`);
    })());
    if (look.has("element")) tasks.push((async () => {
      const r = await actorSend({ op: "inspect", x: p.x ?? fx + fw / 2, y: p.y ?? fy + fh / 2 });
      out.push(r.ok ? `element at (${Number(r.x).toFixed(0)},${Number(r.y).toFixed(0)}): ${hoverFull(r.element)}` : `element: ${r.error}`);
    })());
    await Promise.all(tasks);
    mark([...look].join("+"));
    if (p.steps?.length) {
      const front: Front = { want: false, raised };
      const r = await actSteps({ steps: p.steps, ax: true }, target, front);
      out.push(`steps:\n${r.content.map((c) => c.text).join("\n")}`);
    }
  } finally {
    if (raised?.ok) { back = await restoreWindow(raised); mark("restore"); }
    if (own) { own.child.stdin!.write("release\n"); await Promise.race([own.freed, sleep(1500)]); mark("release"); }
  }
  const held = Date.now() - tLocked;
  if (own) await stopLock(own); // the pill's exit animation runs with input already free
  if (rest.image && rest.tree && rest.at) {
    const seen = await atRest({ image: rest.image, raw: `${rest.image}.rgba`, tree: rest.tree, at: rest.at });
    if (seen) out.push(seen);
  } else if (rest.image) rmSync(`${rest.image}.rgba`, { force: true });
  out.push(`${back} · user input held ${own ? `${(held / 1000).toFixed(2)}s ("Just a sec…": ${marks.join(", ")})` : "by the session lock already running"} · whole call ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  return withNotes({ content: [{ type: "text" as const, text: out.join("\n\n") }, ...content] }, inst.note ?? "");
}));

// ---- reports

server.registerTool("eye_report", {
  title: "Analyze recordings",
  description: [
    "Re-analyze recorded runs (default: the most recent one). view: summary (default) = what a viewer would have noticed, then",
    "one row per motion (fps = new images per second vs the display refresh; stall% = observed refreshes with no new image, a lower",
    "bound; hitch = a gap ≥1.5 frames, long ≥3; jumps = abrupt speed changes of the moving edge; w/h = its extent in points);",
    "timeline = binned time series (frames, idle, worst gap, % moved, luma, extent); explain = the worst on-screen gaps joined",
    "with where the pointer was, which element it was over, which eye_act step ran and (with profile) the app's main thread;",
    "hover = every change of the element under the pointer; compare (default for runs) = side-by-side table vs the first run;",
    "probe (default for an .ndjson file) = per-layer report, or one layer's per-frame series with layer_id.",
  ].join(" "),
  inputSchema: {
    view: z.enum(["summary", "timeline", "explain", "hover", "compare", "probe"]).optional(),
    csv: z.string().optional().describe("frames.csv of a run, or its folder. Default: the most recent recording."),
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
    p.csv ??= lastCsv();
    if (!p.csv) return fail(`${view} needs csv (no recording found in ${RUNS})`);
    if (!p.csv.endsWith(".csv")) p.csv = join(p.csv, "frames.csv"); // a run folder is as good as its csv
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
  description: "Block ALL of the user's physical input — trackpad/mouse, gestures, keyboard, media keys — and pin the cursor, so automated input runs undisturbed (auto-release after `seconds`; emergency release: the user presses Esc 6× in a row, ≤1s apart). Everything that could make it fail (permission, another lock, a device held by another process) is checked BEFORE any warning shows. If the user is mid-drag / scroll / fling / pinch it waits up to 1.2s for them to finish, then ends that action cleanly. eye_act takes one automatically while it drives; use a session lock to keep input blocked across several eye_act calls (e.g. a drag held between calls) or around your own driver — eye_act calls inside it extend it instead of locking again. release:true (or no seconds) releases locks and reports how many physical events were blocked.",
  inputSchema: {
    seconds: z.number().positive().max(600).optional(),
    style: z.enum(["full", "quick"]).optional().describe("full (default): 1.5s 3·2·1 warning, then the orange overlay on every screen — for anything longer than a few seconds. quick: \"Just a sec…\" — no countdown, a small pill under the menu bar; for ≤5s checks."),
    release: z.boolean().optional(),
    id: z.string().optional().describe("Release only this lock."),
    allow: z.enum(["synthetic", "tagged"]).optional().describe("synthetic (default): any process-posted event passes. tagged: only events with eventSourceUserData 0x45594521."),
  },
}, driving((p: any) => (p.release || !p.seconds ? null : "eye_lock"), fail, async (p) => {
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
  const l = startLock(p.seconds, p.allow ?? "synthetic", p.style ?? "full");
  if (!(await l.ready)) return fail(await lockFailure(l));
  return text(`${l.id}: physical pointer AND keyboard ${l.engaged ?? `locked for ${p.seconds}s`}. eye_lock {release:true} when done.`);
}));

server.registerTool("eye_app", {
  title: "Copies of the app under test",
  description: [
    "List, quit, launch or relaunch the app you test, counting every copy and every other build of it (Dev/Release/Setapp…):",
    "two of them on screen at once both draw and both answer accessibility. the-eye already checks this itself before eye_act /",
    "eye_probe / eye_record {process} and stops with the choices; use this to act on them, or to start the app without ever",
    "making a second copy. list (default): every running copy. quit: the given pid, or every copy except keep. launch: start",
    "app_path (or the app's last known .app) — refused while a copy runs unless duplicates says what to do. relaunch: quit",
    "every copy and start app_path (or the target's .app) fresh.",
  ].join(" "),
  inputSchema: {
    app: z.union([z.string(), z.number()]).optional().describe("App name (any build, e.g. 'NOOTCH'), pid, or nothing when app_path is given."),
    action: z.enum(["list", "quit", "launch", "relaunch"]).optional(),
    pid: z.number().int().optional().describe("quit: only this pid."),
    keep: z.number().int().optional().describe("quit: quit every copy except this pid."),
    app_path: z.string().optional().describe("launch/relaunch: the .app to start (e.g. the build you just made in DerivedData)."),
    duplicates: z.enum(["ask", "quit_others", "relaunch", "allow"]).optional().describe("launch while a copy runs: ask (default), quit_others/relaunch (quit them, then launch), allow (launch anyway; `open` still won't start a second copy of the same .app)."),
  },
}, driving((p: any) => ((p.action ?? "list") === "list" ? null : `eye_app ${p.action}`), fail, async (p) => {
  const action = p.action ?? "list";
  const ref = p.app ?? (p.app_path ? basename(p.app_path).replace(/\.app\/?$/, "") : undefined);
  if (ref === undefined) return fail("pass app (name or pid) or app_path");
  if (action === "list") { const f = familyOf(ref); if (f) watchPid(f.target.pid); return withNotes(text(listFamily(ref))); }
  const fam = familyOf(ref);
  if (action === "quit") {
    if (!fam) return text(`no running app matches "${ref}"`);
    const all = [fam.target, ...fam.others];
    const pids = p.pid ? all.filter((x) => x.pid === p.pid).map((x) => x.pid) : all.filter((x) => x.pid !== p.keep).map((x) => x.pid);
    if (!pids.length) return fail(`nothing to quit (running: ${all.map((x) => x.pid).join(", ")})`);
    const left = await quitPids(pids);
    return left.length ? fail(`could not quit pid ${left.join(", ")}`) : withNotes(text(`quit pid ${pids.join(", ")}\n${listFamily(ref)}`));
  }
  const appPath = p.app_path ?? fam?.target.app;
  if (!appPath) return fail(`no app_path, and no running copy of "${ref}" to take it from`);
  if (action === "launch" && fam && (p.duplicates ?? "ask") === "ask") {
    return fail(`not launched: ${fam.others.length + 1} cop${fam.others.length ? "ies" : "y"} already running\n${listFamily(ref)}\nCall again with duplicates:"quit_others"/"relaunch" (quit them first), or "allow", or use the running one.`);
  }
  if (fam && (action === "relaunch" || p.duplicates === "quit_others" || p.duplicates === "relaunch")) {
    const left = await quitPids([fam.target.pid, ...fam.others.map((x) => x.pid)]);
    if (left.length) return fail(`could not quit pid ${left.join(", ")}`);
  }
  const l = await launch(appPath);
  if (typeof l === "string") return fail(l);
  watchPid(l.pid);
  return withNotes(text(`started ${l.name} pid ${l.pid} (${appPath})\n${listFamily(l.pid)}`));
}));

registerProbeTools(server, { root: ROOT, runDir, text, fail });

function cleanup() {
  releaseDriver();
  actor?.child.kill("SIGTERM");
  for (const j of jobs.values()) j.cmd?.kill("SIGTERM");
  for (const l of locks.values()) l.child.kill("SIGTERM");
  for (const c of captures.values()) { c.child.kill("SIGTERM"); c.events?.kill("SIGTERM"); endUnder(c.under); }
}
startLeaseHeartbeat(() => [...jobs.values()].some(running) || locks.size > 0 || activeProbeTarget() !== null);
process.on("exit", cleanup);
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, () => { cleanup(); process.exit(0); });
process.stdin.on("close", () => { cleanup(); process.exit(0); });

ensureBinary();
await server.connect(new StdioServerTransport());
