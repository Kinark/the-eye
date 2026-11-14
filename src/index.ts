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
import { formatSeen, notice, type Seen } from "./notice.ts";
import { ROOT_HINT, endUnder, startUnder, stopUnder, type Under } from "./under.ts";
import { still, type Img } from "./still.ts";
import { WING_WORDS, parseWing } from "./wing.ts";
import {
  activeProbeLive, activeProbeTarget, analyzeProbe, describeProbeLive, probeCommands, probeRunIds, probeRunsStatus,
  resolvePid, setProbeRoot, snapshotStalls, startProbe, stopProbes,
} from "./probe.ts";
import { ask, ASK_SECONDS, clean as cleanQuestion, QUESTION_MAX, sayReply, setPresenter, type Presenter, type Reply } from "./ask.ts";
import {
  checkInstances, driverStatus, driving, duplicatesSchemaDescription, familyOf, freshEvents, launch, listFamily, notQuit, quitPids, releaseDriver,
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
const LIVE_CMD = `node ${join(ROOT, "src", "index.ts")} live`;
if (process.argv[2] === "live") {
  const { liveCli } = await import("./live.ts");
  process.exit(await liveCli(process.argv.slice(3), RUNS));
}
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
  rect: Rect; display?: number; seconds: number; label?: string; fps?: number; keyframe_ms?: number; keyframe_max?: number;
  profile?: ProfileOpts; cursor?: boolean; ax_hz?: number; only_pid?: number;
}): Capture {
  ensureBinary();
  const dir = runDir(p.label);
  const csv = join(dir, "frames.csv");
  const args = ["capture", "--rect", rectArg(p.rect), "--seconds", String(p.seconds), "--out", csv];
  if (p.display !== undefined) args.push("--display", String(p.display));
  if (p.fps) args.push("--fps", String(p.fps));
  if (p.keyframe_ms) args.push("--keyframes-dir", join(dir, "keyframes"), "--keyframe-ms", String(p.keyframe_ms));
  if (p.keyframe_ms && p.keyframe_max) args.push("--keyframe-max", String(p.keyframe_max));
  if (p.cursor === false) args.push("--cursor", "off");
  if (p.only_pid) args.push("--only-pid", String(p.only_pid));
  args.push("--ax-hz", String(p.ax_hz ?? 0));
  const child = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  const id = `cap${++seq}`;
  const c: Capture = { id, label: p.label ?? id, dir, csv, child, done: collect(child), started: Date.now() };
  if (p.profile) c.trace = startTrace(dir, p.profile, p.seconds + 15);
  captures.set(id, c);
  c.done.then((msg) => {
    // Ended on its own (not stopped by a call): keep why, so the next call can say so.
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
/**
 * Question mode (ask.ts decides when, and what the answers mean). Over a lock this server already holds, the
 * question is put on that lock; otherwise a lock is taken just for it: no countdown, the overlay and the question
 * at once, gone with the answer. Resolves with the helper's answer line, or with why it could not be shown.
 */
const presentQuestion: Presenter = async (question, preselect, seconds) => {
  ensureBinary();
  const read = (out: string): Reply | string => {
    for (const line of out.split("\n")) {
      if (!line.includes('"answer"')) continue;
      try {
        const j = JSON.parse(line);
        if (["nope", "yep", "casa"].includes(j.answer)) return { answer: j.answer, how: j.how, waited_ms: j.waited_ms };
        return `the lock could not show it (${j.how})`;
      } catch {}
    }
    return "";
  };
  const held = [...locks.values()].find((x) => x.child.exitCode === null && x.engaged);
  if (held) {
    if (held.until < Date.now() + (seconds + 3) * 1000) extendLock(held, seconds + 5);
    return new Promise((res) => {
      let buf = "";
      const end = (r: Reply | string) => { clearTimeout(t); held.child.stdout!.off("data", on); held.child.off("close", gone); res(r); };
      const on = (d: Buffer) => { buf += d; const r = read(buf); if (r) end(r); };
      const gone = () => end("the lock ended before the question was answered");
      const t = setTimeout(() => end("no answer came back from the lock"), (seconds + 3) * 1000);
      held.child.stdout!.on("data", on);
      held.child.on("close", gone);
      held.child.stdin!.write(`ask ${["nope", "yep", "casa"].indexOf(preselect)} ${seconds} ${question}\n`);
    });
  }
  const child = spawn(BIN, ["lock", "--style", "question", "--question", question, "--default", preselect, "--ask-seconds", String(seconds)], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin!.on("error", () => {});
  child.on("exit", (_code, sig) => { if (sig === "SIGKILL" || sig === "SIGSEGV" || sig === "SIGABRT") spawn(BIN, ["release-cursor"], { stdio: "ignore" }); });
  const done = collect(child);
  const t = setTimeout(() => child.kill("SIGKILL"), (seconds + 8) * 1000);
  const out = await done;
  clearTimeout(t);
  const r = read(out);
  if (r) return r;
  const m = out.match(/preflight: [^\n"]*/) ?? out.match(/failed: [^\n"]*/);
  return m ? `the question could not be shown: ${m[0]}` : `the question could not be shown: ${out.slice(-300).trim() || "the helper said nothing"}`;
};
setPresenter(presentQuestion);

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
/** A held lock that covers the next `ms` (a session, lock_input, a running glance), extended if it would end too soon. */
async function coveringLock(ms: number): Promise<Lock | undefined> {
  const l = [...locks.values()].find((x) => x.child.exitCode === null);
  if (!l || !(await l.ready)) return undefined;
  if (l.until < Date.now() + ms + 2000) extendLock(l, Math.ceil((ms + 5000) / 1000));
  return l;
}

/** What a viewer would have noticed (verdict, defects worst first with their causes, then the facts). */
/** A probe was (or is) inside the app of this run: its freezes get their cause from it, no hint needed. */
const probedRun = (dir: string) => existsSync(join(dir, "stalls.json")) || (drive?.job.capture.dir === dir && !!drive.probe);
function seen(csv: string, opts: Options, o: { live?: boolean; max?: number } = {}) {
  const { rows, meta } = loadRun(csv);
  return formatSeen(notice(rows, meta, analyze(rows, meta, opts), { ...opts, dir: dirname(csv), still_recording: o.live }), o.max, probedRun(dirname(csv)));
}
/** The verdict first, the measurements under it. */
function report(csv: string, label: string, opts: Options, maxSegments?: number) {
  const { rows, meta } = loadRun(csv);
  const a = analyze(rows, meta, opts);
  return `${formatSeen(notice(rows, meta, a, { ...opts, dir: dirname(csv) }), 10, probedRun(dirname(csv)))}\n\n${formatAnalysis(a, label, maxSegments)}`;
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
    if (f.others.length) out.push(`⚠ ${f.target.name} (on screen in this rect) runs ${f.others.length + 1}× (${[f.target, ...f.others].map((p) => `${p.name} pid ${p.pid}`).join(", ")}). Measurements may mix them: eye_status {app:${pid}} lists them.`);
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

// ---- recordings (one Job per session; command optional)

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
  try {
    const f = liveFile(c), live = JSON.parse(readFileSync(f, "utf8"));
    live.file_age_s = (Date.now() - statSync(f).mtimeMs) / 1000; // the helper rewrites it 10×/s for as long as it lives
    return live;
  } catch { return null; }
}
/**
 * Why this recording is NOT seeing right now ("" = it sees). A live reading is only the last thing the capture saw:
 * when the stream dies it keeps saying "still" for ever. Silence alone proves nothing (on a motionless display a
 * healthy stream stops calling back), so this goes by what is known: ScreenCaptureKit said the stream stopped, the
 * helper is gone, or no image ever came.
 */
function blind(live: any): string {
  if (!live) return "the recording has no live reading";
  if (live.stream_error) return `the capture stream died (${live.stream_error})`;
  if (live.file_age_s > 1.5) return `the recording ended, or its helper stopped, ${live.file_age_s.toFixed(1)}s ago`;
  if (live.frames_total === 0) return "the recording has not delivered a single image";
  return "";
}
const running = (j: Job) => j.state !== "done";

type RecordParams = {
  rect: Rect; label?: string; display?: number; fps?: number; keyframe_ms?: number; keyframe_max?: number; profile?: ProfileOpts;
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
  const capOpts = { rect: p.rect, display: p.display, label: p.label, keyframe_ms: p.keyframe_ms, keyframe_max: p.keyframe_max, fps: p.fps,
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
  const dark = blind(live);
  if (dark) return `⚠ NOT SEEING: ${dark}. The last reading is from ${Number(live.t).toFixed(1)}s on the recording's clock; nothing after it was observed.`;
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

USE IT BY DEFAULT: this is how you test a macOS app's UI (SwiftUI or AppKit) yourself. After a UI change builds, start the app and verify it here. Don't hand the check to the user ("try it and tell me") unless they say they'll drive.

FIVE TOOLS
- eye_drive: the one that acts. A session on an app: its window recorded, the user's input held, a hand on the mouse, a probe inside the app when it can go in. Open it with app, move with a wing (words, one flowing motion, things by name) or steps (exact coordinates, timings, gestures, Force Touch, waits), end:true for the report. hands:false only watches (the user or your script drives).
- eye_snapshot: one still image. {rect} of the screen as it is; {app} brings a covered or minimized window forward for a fraction of a second, takes the image and the element tree, and puts everything back.
- eye_inspect: what UI is here: an app's element tree with frames, or everything about the element at a point. No recording, no lock.
- eye_report: re-read a finished run: summary, timeline, explain (worst frames joined with pointer, step and main thread), hover, compare (A/B), probe.
- eye_status: displays, who is driving, what the open session sees right now, the copies of an app that are running.

THE LOOP IS ONE CALL: eye_drive {app:"Calculator", wing:'"7" tap "Add" tap "3" tap "Equals" tap settle', end:true}. To explore, leave end off: read what came back, send the next wing or steps, end:true when done. The hand, the recording and the lock stay up between calls; a session with a hand ends by itself after 30s without a call.

READING A REPLY
- WHAT IT LOOKED LIKE opens with a verdict (SMOOTH · MOSTLY SMOOTH · ROUGH · BROKEN · NOTHING MOVED) and then, worst first, each thing a viewer would have noticed: freezes, judder, jumps, flashes, slow answers to input. ✗ = clearly visible, ~ = visible if you look, · = a fact, not a defect. Read the verdict; go to eye_report only when you need numbers.
- NOT SEEN IN FULL, SAW NOTHING or "⚠ NOT SEEING" mean exactly that: do not report on that stretch as if you had watched it. Nothing is ever sent to a window that cannot be seen (minimized, hidden, another Space, a sleeping display).
- FRAMES come back unasked: the frame the screen settled on after each call and, with the final report, the recorded frame at each ✗. Look at them; they are the picture the numbers describe.
- "moved by:" under a motion is the engine fitted to its frames: a SPRING (damping ratio, response, the SwiftUI call that reproduces it), a TIMING CURVE (name or cubic-bezier, duration), a PER-FRAME LERP (factor; "frame-rate dependent" = it fell behind where frames dropped), a BOUNCE (gravity, restitution). "or equally:" = the frames cannot tell two engines apart. "nothing simple" = no single engine (driven by hand, retargeted, several at once). "it dimmed/brightened in place" = a fade. These are measurements: whether it is the right motion is your call (.smooth = bounce 0, .snappy 0.15, .bouncy 0.3, all 0.5s).
- "why:" under a freeze is its cause, from the probe inside the app: how long the main thread was blocked and in which function, or that it was free and the frames were lost after the app. With the probe, FROM INSIDE THE APP also gives per moving layer "declared:" (the Core Animation animation the code attached), the same fit on the layer's exact values, and "✓ it ran as declared" or "≠ …". No "declared:" = the app drives the value itself each frame (SwiftUI on macOS).
- WHO WAS LATE under a freeze (the app committed nothing / the window server was late / nothing changed), and per motion how often the app committed, how many frames reached the display and what moving cost in energy, come from signposts and, where sudo allows dtrace and powermetrics without a password, from those. Nothing ever asks for a password: ${ROOT_HINT}.
- "what the app told accessibility" places value changes, focus, windows, sheets and announcements on the recording's clock; under "answered …" it says who was first ("the app knew first" = the wait was in drawing, not deciding). If the app told accessibility nothing, assistive technology was not told what changed.
- "## at rest" (eye_snapshot) is what one still frame says by itself: text sizes and the weakest contrast (WCAG), a thing 0.5–3pt off its neighbours' line, uneven gaps, overlaps, a label cut by the window, the shape of each corner (circular arc or continuous, with radius). The rules are narrow on purpose: an empty line means "nothing plainly off", not "perfect".

KNOW THESE
- THE PROBE goes in by itself, once per app launch, when a session opens on an app. It needs a Debug build (or System Integrity Protection off) and cannot join an app Xcode is debugging; when it cannot go in, one line says why and the session goes on. It costs about 0.2ms a frame: probe:false for the cleanest fps numbers.
- Coordinates are POINTS, top-left origin. rect is display-local (eye_status lists displays); the pointer, accessibility frames and step x/y are global. On the main display both are the same.
- THE LOCK. A session with a hand blocks ALL of the user's physical input (trackpad, mouse, gestures, keyboard) and pins the cursor: a session that stays open warns with 3·2·1 and an orange overlay; one short call with end:true shows only a small pill ("Just a sec…"). Orange on screen means locked. The user's way out is Esc 6× in a row. Everything that could make it fail is checked before anything shows ("input lock refused — preflight: …" = nothing ran). Never hold it while the user should be acting: use hands:false.
- Presses and gestures land only on the session's app. A session with a hand brings the app's window forward when it opens (also from minimized) and puts it back, with everything that was above it, when it ends. front:false leaves it where it is: a press on a part another app covers is then refused.
- Input is synthetic and reaches apps by another path than a physical trackpad. If a bug does not reproduce, vary it (speeds, phased or unphased scroll, momentum, hover paths, your own CGEvent driver via hands:false + command) and report what each run measured.
- A/B: the same steps twice with different labels, then eye_report {runs:[{csv,label},…]}. Compare runs taken the same way (probe on in both, or off in both).
- The measured extent (a, e in expressions) is a pixel difference: translucent glass over a similar background measures smaller than the view. For true bounds use accessibility frames (eye_inspect, h.frame) and keep wait_until thresholds loose.
- THE USER IS ASKED before the-eye quits something that may be theirs (an app running from Xcode, a copy outside build folders): a question fills the locked screen with "Nope" · "Yep" · "Mi casa su casa"; unanswered after 6s the highlighted one is taken. Nope = they are using it: the call fails, nothing is quit for 30s, do not retry. Ask your own with eye_drive {ask:"…"} before anything else they might mind; never ask twice after a Nope.
- ONE AT A TIME. One agent session drives the screen. If another is mid-turn your eye_drive / eye_snapshot {app} call waits in a queue and then runs ("waited Ns in the queue"); don't retry or sleep. An open session holds the turn: end it promptly. After ~45s queued you get "QUEUED, not run": call again within 20s to keep your place. eye_inspect, eye_report, eye_status and eye_snapshot {rect} never wait.
- ONE APP COPY. Every copy and every other build of the app (Dev, Release, Setapp…) draws and answers accessibility. If several run, eye_drive stops with the list and the choices: duplicates:"quit_others", "relaunch" (app_path = the build you just made), "allow", or ask the user. To start the app, eye_drive {app_path}: it never makes a second copy.
- WAITING: don't poll. \`${WATCH_CMD}\` prints one line per UI event (windows, sheets, dialogs with their text and [buttons], titles, announcements, --values for text and progress); --app NAME limits it, --until "TEXT" --seconds N exits on the first match (124 if none). \`${LIVE_CMD}\` prints one line each time the recorded screen starts moving, comes to rest (how long it moved, at what fps, its worst gap) or hitches. Stream either with your Monitor tool, or run it in the background.
- Needs Screen Recording and Accessibility permission for the host app. Runs live in ~/Library/Caches/the-eye/runs/<time>_<label>/ (frames.csv, cursor.csv, actions.jsonl, events.jsonl, stalls.json, keyframes/).
`.trim();


const server = new McpServer({ name: "the-eye", version: "0.3.0" }, { instructions: INSTRUCTIONS });

server.registerTool("eye_status", {
  title: "Displays, the open session right now, who is driving",
  description: "Displays (id, size in points, scale, refresh rate = the fps target), who holds the screen, and what the open eye_drive session sees RIGHT NOW: moving or still, the visible extent, what a viewer noticed over the last seconds, the command's latest output, the live probe layers. app lists every running copy and build of an app. Read-only: never waits, never locks.",
  inputSchema: {
    app: z.union([z.string(), z.number()]).optional().describe("List every running copy and build of this app (name or pid)."),
    window_s: z.number().positive().optional().describe("Seconds of the session's recent history to judge (default 3)."),
    tree: treeSchema.optional().describe("Also the element tree of the session's region as it is now (default none; it costs the app some frames)."),
  },
}, async (p) => {
  ensureBinary();
  const now = Date.now();
  const d = await run(BIN, ["displays"], 8000);
  const L = [
    d.code === 0 ? d.stdout.trim() : `displays: ${(d.stdout + d.stderr).trim()}`,
    `runs dir: ${RUNS}`,
    driverStatus(),
    ...watchedStatus(),
    ...freshEvents(),
    ...[...locks.values()].map((l) => `${l.id} locked, ${Math.max(0, (l.until - now) / 1000).toFixed(0)}s left`),
    ...finishedLocks.slice(0, 3).map((r) => `ended ${r}`),
    ...probeRunsStatus(),
    ...diedCaptures.slice(-2).map((x) => `capture ended early: ${x}`),
  ];
  if (p.app !== undefined) { const f = familyOf(p.app); if (f) watchPid(f.target.pid); L.push(listFamily(p.app)); }
  const s = drive;
  if (!s) L.push(driveEnded ? "no session is open (the last one ended by itself: the next eye_drive call hands over its report)" : "no session is open");
  else {
    const job = s.job, cap = job.capture, live = readLive(cap);
    L.push(`session: ${s.what} · ${s.hands ? "a hand on the mouse" : "watching only"}${s.lock || job.lock ? " · the user's input is held" : ""} · ${job.state} · ${((now - job.started) / 1000).toFixed(1)}s · ${cap.dir}`);
    if (job.state === "done") L.push("its recording has ended: eye_drive {end:true} returns the report");
    else {
      L.push(describeLive(live));
      try {
        const { rows, meta } = loadRun(cap.csv);
        const t = live?.t ?? (rows.length ? rows[rows.length - 1].t : 0), w = p.window_s ?? 3;
        snapshotStalls(cap.dir);
        const o = { ...job.opts, from_s: Math.max(0, t - w) };
        L.push(`last ${w}s: ${formatSeen(notice(rows, meta, analyze(rows, meta, o), { ...o, dir: cap.dir, still_recording: true }), 4, probedRun(cap.dir))}`);
      } catch { /* csv not flushed yet */ }
      if (job.command) L.push(job.output.length ? `command output (last ${Math.min(8, job.output.length)}):\n${job.output.slice(-8).join("\n")}` : "command output: (none yet)");
      if (p.tree && p.tree !== "none") {
        const t = await axTree({ rect: job.rect, display: job.display, process: job.process, mode: p.tree });
        L.push(`AX tree now (${p.tree}, global points):\n${t.text}`);
      }
      const pl = activeProbeLive();
      if (pl) L.push(describeProbeLive(pl, 5));
      L.push(`as lines, while it runs: ${LIVE_CMD}`);
    }
  }
  return text(L.join("\n"));
});

server.registerTool("eye_inspect", {
  title: "What UI is here (Accessibility)",
  description: [
    "Accessibility view of the screen, no recording needed. Without rect: EVERYTHING the element under a point exposes (default:",
    "the pointer) — role, labels, value, frame, state, actions, every other attribute, ancestors, app and window. With rect (or",
    "tree set): the element tree of the windows actually visible there, one line per element with its bounds",
    "`Button \"Camera\" #id [x,y w×h] (focused) {Press}`. Frames are global points (same space as eye_drive step x/y).",
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
  description: "One still image, three ways. {rect}: a PNG of that screen region as it is now. {app}: \"Just a sec…\" — holds the user's input with a small pill (no countdown), brings the app's window to the very front even if it is covered or minimized, takes the image and its element tree, then puts the screen back exactly as it was (z-order, focus, frame); the user is held for well under a second. {csv, t_s}: the frames a recording kept, closest to a time. A live image ends with \"## at rest\": what the frame says by itself (text sizes, contrast, alignment, gaps, corner shapes). Returns paths; return_image adds the image inline (default true with app).",
  inputSchema: {
    app: z.union([z.string(), z.number()]).optional().describe("Bring this app's window forward for the look and put it back (name of any build, or pid)."),
    window: z.string().optional().describe("app: which window (title substring). Default its main/focused window, else the largest."),
    look: z.array(z.enum(["image", "tree", "element"])).optional().describe("app: what to take while it is in front (default [image, tree]). element = everything about the element at x,y."),
    x: z.number().optional(), y: z.number().optional().describe("app, element: the point (global). Default the window's centre."),
    tree: z.enum(["basic", "full"]).optional().describe("app: tree mode (default basic)."),
    settle_ms: z.number().min(0).max(2000).optional().describe("app: wait after raising before looking, so it has drawn (default 80)."),
    duplicates: z.enum(["ask", "quit_others", "relaunch", "allow"]).optional().describe(duplicatesSchemaDescription),
    rect: rectSchema.optional(), display: z.number().int().optional(), path: z.string().optional(),
    csv: z.string().optional().describe("frames.csv of a recording, to get its keyframes instead of a live image."),
    t_s: z.number().optional(), count: z.number().int().min(1).max(8).optional(),
    return_image: z.boolean().optional(),
    measure: z.boolean().optional().describe("Live: also read the frame at rest (text sizes, contrast, near-miss alignment, uneven gaps, overlaps, cut-off, corner shapes) from its pixels and the element tree there. Default true, except while a recording runs (reading the tree costs the app some frames)."),
  },
}, driving((p: any) => (p.app !== undefined ? "eye_snapshot app" : null), fail, async (p): Promise<any> => {
  if (p.app !== undefined) return glance(p);
  if (p.csv) {
    const dir = join(dirname(p.csv), "keyframes");
    if (!existsSync(dir)) return fail("this recording kept no frames (keyframe_ms:0, or nothing changed on screen)");
    const files = readdirSync(dir).filter((f) => f.endsWith(".png"))
      .map((f) => ({ f, t: Number(f.replace(/^frame_|ms\.png$/g, "")) / 1000 }))
      .sort((a, b) => Math.abs(a.t - (p.t_s ?? 0)) - Math.abs(b.t - (p.t_s ?? 0))).slice(0, p.count ?? 3).sort((a, b) => a.t - b.t);
    const content: any[] = [{ type: "text", text: files.map((x) => `${x.t.toFixed(3)}s ${join(dir, x.f)}`).join("\n") }];
    if (p.return_image) for (const x of files) content.push({ type: "image", data: readFileSync(join(dir, x.f)).toString("base64"), mimeType: "image/png" });
    return { content };
  }
  if (!p.rect) return fail("pass rect (the screen as it is), app (bring its window forward and look), or csv + t_s (frames a recording kept)");
  ensureBinary();
  const rect = p.rect;
  const out = p.path ?? join(runDir("snapshot"), "snapshot.png");
  const measure = p.measure ?? !activeJob();
  const args = ["snapshot", "--rect", rectArg(rect), "--out", out];
  if (measure) args.push("--raw", `${out}.rgba`);
  if (p.display !== undefined) args.push("--display", String(p.display));
  // While a recording runs the helper is not asked: a second ScreenCaptureKit client interrupts the recording's
  // stream for some tens of milliseconds, and the recording would have to report itself blind.
  const recording = !!activeJob() && p.display === undefined;
  let r = recording ? { code: 1, stdout: "", stderr: "a recording is running: taken without ScreenCaptureKit so its stream is not interrupted" } : await run(BIN, args, 6000);
  let note = r.stdout.trim();
  if (r.code !== 0 && p.display === undefined) {
    // That, or ScreenCaptureKit wedged: the system screenshot tool (main display, points).
    const fb = await run("/usr/sbin/screencapture", ["-x", "-R", `${rect.x},${rect.y},${rect.w},${rect.h}`, out], 8000);
    if (fb.code === 0 && existsSync(out)) {
      note = JSON.stringify({ path: out, via: "screencapture", reason: (r.stderr || r.stdout).trim().slice(0, 200) });
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
}));

// ---- exact steps

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
    pr: activeProbeLive(),                     // layer-probe live JSON, or null
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
  const dark = blind(live);
  if (dark) return `⚠ NOT SEEING: ${dark}`;
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
  on: z.union([z.string(), z.number()]).optional().describe("click/down/move: aim at a probe layer (label substring or layer id) instead of x,y — its centre, from the probe's live data. The layer must be in the live moving/watched lists (probe:{watch:[…]} when the session opens)."),
  note: z.string().optional(),
});

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
/**
 * Where an app's window is, as a display-local rect clipped to its display. Nothing is raised or moved. It answers
 * only for a window there is something of to see: not minimized, on screen (not hidden, not on another Space), on a
 * display that is awake and unlocked. `willRaise`: the caller brings it forward next, so hidden / minimized is fine.
 */
async function windowRect(pid: number, window?: string, willRaise = false): Promise<{ ok: true; rect: Rect; display: number; what: string; on_top: boolean } | { ok: false; error: string }> {
  const r = await actorSend({ op: "raise", locate: true, pid, ...(window ? { title: window } : {}) });
  if (!r.ok) return { ok: false, error: String(r.error) };
  if (r.screen_locked) return { ok: false, error: "the screen is locked: there is nothing to see or press until it is unlocked" };
  if (r.display_asleep) return { ok: false, error: `the display "${r.title}" is on is asleep: nothing is being drawn` };
  if (r.minimized && !willRaise) return { ok: false, error: `window "${r.title}" is minimized: nothing of it is on screen (front:true or eye_snapshot {app} brings it up)` };
  if (r.on_screen === false && !r.minimized && !willRaise) return { ok: false, error: `window "${r.title}" is not on screen (its app is hidden, or it is on another Space): there is nothing of it to see (front:true or eye_snapshot {app} brings it up)` };
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
  let heldButton: string | null = null, wentDark = "", blinks = 0;
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
      // The eye first: a step is only sent while the recording is really seeing. A dead stream goes on reading
      // "still", so the steps after it would all look fine and none of them would have been watched.
      let dark = cap ? blind(readNow()) : "";
      if (dark) {
        // The helper reopens a dropped stream in a few hundred ms: give it a moment before calling the run off.
        const since = Date.now();
        while (dark && Date.now() - since < 1500) { await sleep(50); dark = blind(readNow()); }
        if (!dark) blinks++;
        if (!dark) lines.push(`${stamp()} ⚠ THE EYE BLINKED: the capture stream dropped and was reopened (${Date.now() - since}ms waited). What step #${Math.max(0, i - 1)} did in that moment was not seen; the verdict below has the exact stretch.`);
      }
      if (dark) {
        if (heldButton) { await actorSend({ op: "up", button: heldButton }); heldButton = null; wentDark = " The button it was holding was released."; }
        stopped = `${tag}: NOT SENT — the eye went blind: ${dark}. Steps #${i}…#${p.steps.length - 1} were not run (${p.steps.length - i} of ${p.steps.length}); the lines above are what was really seen.${wentDark} End the session, open it again and carry on from here.`;
        break;
      }
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
          if (!hit) { stopped = `${tag}: no live probe layer matches ${JSON.stringify(on)} (probe:{watch:[…]} when the session opens shows it)`; break; }
          aimed = hit.shape ?? hit.rect;
          cmd.x = aimed![0] + aimed![2] / 2; cmd.y = aimed![1] + aimed![3] / 2;
        }
        const gesture = ["pinch", "rotate", "smart_zoom", "swipe", "press", "force_click"].includes(s.op);
        if (s.op === "click" || s.op === "down" || gesture) {
          // Presses and gestures can never land outside the target app: no force, both checks always run.
          if (!target) { stopped = `${tag}: REFUSED ${gesture ? "gesture" : "press"} — this session has no app`; break; }
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
        if (s.op === "down") heldButton = s.button ?? "left"; else if (s.op === "up" || s.op === "click") heldButton = null;
        if (r.peak_force !== undefined) pressNote = ` · peak force ${r.peak_force}${r.force_clicked ? " (force click: reached stage 2)" : " (stage 1 only)"}`;
        await look();
      }
      lines.push(`${stamp()} ${tag}${pressNote} → p(${ptr.x.toFixed(0)},${ptr.y.toFixed(0)}) · ${short(readNow())}${over()}`);
    } catch (err: any) { stopped = `${tag}: ${err.message}`; break; }
    finally { if (s.op !== "assert") logAction(s, wall0, stopped === stoppedBefore); }
  }
  const live = readNow();
  // Seeing at the start of the last step is not seeing its result.
  if (cap && !stopped) { const dark = blind(live); if (dark) wentDark = `⚠ THE EYE WENT BLIND during the last step (${dark}): it was sent, what it did was not seen.`; }
  let recent = "";
  if (cap && !p.auto_seen) {
    try {
      const { rows, meta } = loadRun(cap.csv);
      const t = live?.t ?? 0, w = Math.max(1, (Date.now() - t0) / 1000);
      snapshotStalls(cap.dir);
      const o = { ...job!.opts, from_s: Math.max(0, t - w) };
      recent = `during these steps: ${formatSeen(notice(rows, meta, analyze(rows, meta, o), { ...o, dir: cap.dir, still_recording: true }), 5, probedRun(cap.dir))}`;
    } catch { /* not flushed yet */ }
  }
  // Inside a session the caller tells the screen and the rest itself: only what each step did, and where it stopped.
  if (p.brief) return text([...lines, stopped ? `STOPPED — ${stopped}` : p.brief === "word" ? "" : wentDark || `all ${p.steps.length} steps done${blinks ? ` — but the eye blinked ${blinks}× on the way (⚠ above): not every one of them was watched` : ""}`].filter(Boolean).join("\n"));
  let tree = "";
  if (p.tree && p.tree !== "none") {
    const t = job ? await axTree({ rect: job.rect, display: job.display, process: job.process, mode: p.tree })
      : await axTree({ x: ptr.x, y: ptr.y, mode: p.tree });
    tree = `AX tree now (${p.tree}, global points):\n${t.text}`;
  }
  return text([
    ...lines,
    stopped ? `STOPPED — ${stopped}` : wentDark || `all ${p.steps.length} steps done${blinks ? ` — but the eye blinked ${blinks}× on the way (⚠ above): not every one of them was watched` : ""}`,
    axOn && hover ? `element under the pointer now: ${hoverLine(hover, 6)}` : "",
    cap ? describeLive(live) : diedCaptures.length ? `(capture ended early — ${diedCaptures[diedCaptures.length - 1]})` : "UNWATCHED: no recording was running for these steps, so nothing here says what the screen did .",
    recent,
    activeProbeLive() ? describeProbeLive(activeProbeLive(), 5) : "",
    tree,
  ].filter(Boolean).join("\n"));
}

// ---- eye_drive: a hand that stays on the mouse
//
// Steps are a list of points with a stop after each. A WING is one motion: is a line of words, flown
// without a stop between them, by a hand (eye-capture's Hand) that aims at things by name, keeps its momentum from
// one to the next, feels every element it passes over and presses only what is under it. The recording, the lock
// and the hand stay up between wings, so the next one costs nothing to start and picks the motion up where it is.

type Drive = {
  job: Job; target?: { pid: number; name: string }; window?: string;
  /** false = the session only watches: the user, or the caller's own driver, moves things. No hand, no idle end. */
  hands: boolean;
  lock?: Lock; raised?: any; idle?: NodeJS.Timeout; idleS: number; calls: number; evAt: number; what: string;
  /** The probe recording started inside the app when the session opened. */
  probe?: string;
  /** A session opened on a rect: the room the hand may move in, global points (else the window, read afresh each call). */
  room?: number[];
  /** Hand frames back with the replies (the settled one after each call; at the end, one per defect). */
  frames: boolean;
  /** `seconds` / `command`: the opening call waits for the recording to end and returns its report. */
  block: boolean;
};
let drive: Drive | null = null;
/** How a session that ended by itself (nobody steering) went: handed over with the next eye_drive call. */
let driveEnded = "";
/** Frames that go with the text endDrive returned. */
let endFrames: any[] = [];

/** The room the hand may move in, global points. An error when the window is not there to be seen. */
async function driveRoom(d: Drive): Promise<{ bounds: number[] } | { error: string }> {
  if (d.room) return { bounds: d.room };
  const w = await windowRect(d.target!.pid, d.window);
  if (!w.ok) return { error: w.error };
  const r = await actorSend({ op: "raise", locate: true, pid: d.target!.pid, ...(d.window ? { title: d.window } : {}) });
  const [dx, dy] = r.display_bounds as number[];
  return { bounds: [w.rect.x + dx, w.rect.y + dy, w.rect.w, w.rect.h] };
}

/** A frame small enough to hand back in a reply: JPEG, longest side at most 1200px. */
async function frameImage(file: string): Promise<any | null> {
  const out = `${file}.reply.jpg`;
  const r = await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "72", "-Z", "1200", file, "--out", out], 6000);
  if (r.code !== 0 || !existsSync(out)) return null;
  const data = readFileSync(out).toString("base64");
  rmSync(out, { force: true });
  return { type: "image", data, mimeType: "image/jpeg" };
}
/** What the recorded region shows right now, at rest. */
async function settledFrame(j: Job): Promise<any | null> {
  const file = join(j.capture.dir, `settled_${Date.now()}.png`);
  // Not through the helper: a second ScreenCaptureKit client interrupts the recording's own stream for some
  // tens of milliseconds ("application connection being interrupted"), and the recording would report itself blind.
  const [ox, oy] = (drive?.job === j ? drive.raised?.display_origin : undefined) ?? [0, 0];
  const r = await run("/usr/sbin/screencapture", ["-x", "-R", `${j.rect.x + ox},${j.rect.y + oy},${j.rect.w},${j.rect.h}`, file], 5000);
  return r.code === 0 && existsSync(file) ? frameImage(file) : null;
}
/** The recorded frame nearest each defect a viewer would plainly have seen (at most three). */
async function defectFrames(csv: string, s: Seen): Promise<any[]> {
  const dir = join(dirname(csv), "keyframes");
  let keys: { f: string; t: number }[];
  try { keys = readdirSync(dir).filter((f) => f.endsWith(".png")).map((f) => ({ f, t: Number(f.replace(/^frame_|ms\.png$/g, "")) / 1000 })); } catch { return []; }
  const out: any[] = [], used = new Set<string>();
  for (const p of s.percepts.filter((x) => x.sev >= 2 && x.kind !== "blind").slice(0, 3)) {
    const at = p.from ?? p.t;
    const k = keys.filter((x) => !used.has(x.f)).sort((a, b) => Math.abs(a.t - at) - Math.abs(b.t - at))[0];
    if (!k || Math.abs(k.t - at) > 0.6) continue;
    used.add(k.f);
    const im = await frameImage(join(dir, k.f));
    if (im) out.push({ type: "text", text: `the frame at ${k.t.toFixed(2)}s, where: ${p.text.slice(0, 160)}` }, im);
  }
  return out;
}
async function dropProbe(id?: string) {
  if (id) await stopProbes(runDir, id).catch(() => {});
}

/** What the app told accessibility since the last call (events.jsonl of the session's recording). */
function driveEvents(d: Drive): string {
  const f = join(d.job.capture.dir, "events.jsonl");
  let raw = "";
  try { raw = readFileSync(f, "utf8"); } catch { return ""; }
  const fresh = raw.slice(d.evAt);
  const cut = fresh.lastIndexOf("\n");
  if (cut < 0) return "";
  d.evAt += cut + 1;
  const out: string[] = [];
  for (const l of fresh.slice(0, cut).split("\n")) {
    let e: any; try { e = JSON.parse(l); } catch { continue; }
    if (!e.event || e.event === "ready") continue;
    // The helper's own one-line telling, when it has one: `value-changed Calculator StaticText "Edit field" = "10"`.
    if (typeof e.text === "string" && e.text) { out.push(e.text.length > 140 ? e.text.slice(0, 140) + "…" : e.text); continue; }
    const { event, t, pid, ...rest } = e;
    const body = Object.entries(rest).filter(([, v]) => v !== "" && v != null && !(Array.isArray(v) && !v.length))
      .map(([k, v]) => `${k} ${typeof v === "string" ? JSON.stringify(v.length > 70 ? v.slice(0, 70) + "…" : v) : JSON.stringify(v)}`).join(", ");
    out.push(`${event}${body ? `: ${body}` : ""}`);
  }
  if (!out.length) return "";
  const shown = out.length > 8 ? [...out.slice(0, 4), `… ${out.length - 8} more`, ...out.slice(-4)] : out;
  return `the app told accessibility: ${shown.join(" · ")}`;
}

async function endDrive(why: string, quitToo = false): Promise<string> {
  const d = drive;
  if (!d) return "";
  drive = null;
  clearTimeout(d.idle);
  const cap = d.job.capture;
  const imgs: any[] = [];
  let r: any = {};
  // The hand first: it brakes, lets go of anything it holds and stops feeling. Then what it set going plays out
  // under the lock (200ms of stillness, 1.5s at most), the eye closes, the window goes back, the user gets their input.
  if (d.hands && d.target) {
    r = await actorSend({ op: "wing", moves: [], end: true, pid: d.target.pid });
    if (d.job.state === "running") for (let still = 0, end = Date.now() + 1500; still < 4 && Date.now() < end; await sleep(50)) still = readLive(cap)?.moving ? 0 : still + 1;
  }
  if (d.frames && d.job.state === "running" && !blind(readLive(cap))) {
    const f = await settledFrame(d.job);
    if (f) imgs.push({ type: "text", text: "the frame it came to rest on:" }, f);
  }
  // The eye closes before the window goes back: putting it back is not part of what the app did (and reordering
  // windows under an app-only recording interrupts the stream).
  d.job.stopped ??= "stopped by agent";
  d.job.cmd?.kill("SIGTERM");
  d.job.stopNow();
  await Promise.race([cap.done, sleep(6500)]);
  const back = d.raised ? await restoreWindow(d.raised) : "";
  const freed = d.lock ? await stopLock(d.lock) : "";
  const final = await d.job.finished;
  const probe = d.probe ? await stopProbes(runDir, d.probe, { capture_csv: cap.csv, top: 5 }).catch((e) => [`probe: ${e.message}`]) : [];
  let looked = "", what: Seen | undefined;
  try {
    const { rows, meta } = loadRun(cap.csv);
    what = notice(rows, meta, analyze(rows, meta, d.job.opts), { ...d.job.opts, dir: cap.dir });
    looked = formatSeen(what);
  } catch (e: any) { looked = `could not analyze: ${e.message}`; }
  if (d.frames && what) imgs.push(...await defectFrames(cap.csv, what));
  let quitLine = "";
  if (quitToo && d.target) {
    const left = await quitPids([d.target.pid]);
    quitLine = left.length ? notQuit(left) : `quit ${d.target.name} (pid ${d.target.pid})`;
  }
  endFrames = imgs;
  const secs = ((Date.now() - d.job.started) / 1000).toFixed(1);
  return [
    d.hands
      ? `SESSION ENDED (${why}) after ${d.calls} call${d.calls === 1 ? "" : "s"}, ${secs}s. The hand is at rest at (${Number(r.x ?? 0).toFixed(0)},${Number(r.y ?? 0).toFixed(0)})${back ? ` · ${back}` : ""}${freed ? " · input is the user's again" : ""}.`
      : `SESSION ENDED (${why}), ${secs}s watched${back ? ` · ${back}` : ""}.`,
    d.hands ? `WHAT IT LOOKED LIKE — ${d.what}, the whole session (times on the recording's clock):\n${looked}` : `WHAT IT LOOKED LIKE — ${d.what}:\n${final}`,
    ...probe.map((x) => `FROM INSIDE THE APP (the probe; eye_report {view:"probe", file} for every layer):\n${x}`),
    d.hands ? `run: ${cap.dir} · eye_report {view:"explain"} joins the worst frames with pointer, step and main thread` : "",
    quitLine,
  ].filter(Boolean).join("\n");
}

const pt = (x: number, y: number) => `(${x.toFixed(0)},${y.toFixed(0)})`;
function compassOf(vx: number, vy: number) {
  return ["E", "SE", "S", "SW", "W", "NW", "N", "NE"][((Math.round(Math.atan2(vy, vx) / (Math.PI / 4)) % 8) + 8) % 8];
}
/** What one wing did, as the hand lived it: every element it passed over, each press where it happened, where it is now. */
function wingText(words: string[], r: any): string[] {
  const L: string[] = [];
  const secs = (Number(r.ms) / 1000).toFixed(2);
  L.push(r.stopped
    ? `WING STOPPED at move ${r.done + 1} of ${r.of}${words[r.done] ? ` (${words[r.done]})` : ""}: ${r.stopped}. ${r.done ? `The ${r.done} before it ${r.done === 1 ? "was" : "were"} flown` : "Nothing was flown"}${r.of - r.done - 1 > 0 ? `; the ${r.of - r.done - 1} after it ${r.of - r.done - 1 === 1 ? "was" : "were"} not` : ""}.`
    : `wing flown whole: ${r.of} move${r.of === 1 ? "" : "s"} in ${secs}s, one motion`);
  const rows: { t: number; s: string }[] = [];
  for (const s of r.trail ?? []) {
    const still = Math.hypot(s.x1 - s.x0, s.y1 - s.y0) < 1;
    rows.push({ t: s.t, s: `${still ? `at ${pt(s.x0, s.y0)}` : `${pt(s.x0, s.y0)}→${pt(s.x1, s.y1)}`}  ${s.label}${fr(s.frame ?? undefined)}${s.ms >= 1 ? `  ${Number(s.ms).toFixed(0)}ms` : ""}` });
  }
  const shownRows = rows.length > 44 ? [...rows.slice(0, 22), { t: rows[22].t, s: `… ${rows.length - 44} more elements crossed …` }, ...rows.slice(-22)] : rows;
  for (const m of r.marks ?? []) {
    shownRows.push({ t: m.t, s: m.k === "note" ? `· ${m.what}` : `● ${m.k === "scroll" ? words[m.i] ?? "scroll" : m.k} at ${pt(m.x, m.y)} on ${m.what}` });
  }
  shownRows.sort((a, b) => a.t - b.t);
  if (shownRows.length) {
    L.push(`what the hand passed over (${r.path_pt < 1 ? "it did not move" : `${Number(r.path_pt).toFixed(0)}pt travelled, felt every ${(Number(r.path_pt) / Math.max(1, r.samples)).toFixed(1)}pt`}${r.trail_dropped ? `, ${r.trail_dropped} oldest stretches dropped` : ""}):`);
    for (const x of shownRows) L.push(`  ${x.t >= r.t0 ? "+" : "−"}${Math.abs(x.t - r.t0).toFixed(2)}s  ${x.s}`);
  }
  const held = r.held?.length ? `, HOLDING the ${r.held.join(" and ")} button` : "";
  if (r.flying) {
    L.push(`now: still flying ${compassOf(r.course[0], r.course[1])} at ${Number(r.pace).toFixed(0)}pt/s, at ${pt(r.x, r.y)} over ${r.over}${held}. It goes on while you choose the next wing and brakes by itself after ${(Number(r.coast_ms) / 1000).toFixed(1)}s.`);
    if (r.ahead?.length) L.push(`ahead on this line: ${r.ahead.map((a: any) => `${a.label} in ${Number(a.in_pt).toFixed(0)}pt (${(Number(a.in_ms) / 1000).toFixed(2)}s)`).join(" · ")}`);
  } else L.push(`now: at rest at ${pt(r.x, r.y)} on ${r.over}${fr(r.over_frame ?? undefined)}${held}${r.edge ? " — it ran into the window's edge and stopped there" : ""}`);
  if (r.in_sight) L.push(`in sight instead: ${r.in_sight.join(" · ") || "nothing that can be pressed"}`);
  return L;
}

const stepsMs = (steps: any[] = []) => steps.reduce((t, s) => t + (s.ms ?? 0) + (s.timeout_ms ?? (s.op === "wait_until" ? 2000 : 0)) + (s.hold_ms ?? 0) + 400, 0);

/** Open the session: the app (started if asked), the probe inside it, the recording, the lock. "" = open; else why not. */
async function openDrive(p: any, out: string[]): Promise<string> {
  const watchOnly = p.hands === false || !!p.command || !!p.seconds;
  let ref: string | number | undefined = p.app ?? (p.app_path ? basename(p.app_path).replace(/\.app\/?$/, "") : undefined);
  let target: { pid: number; name: string } | undefined;
  let launched = false;
  if (ref !== undefined) {
    if (p.app_path && !familyOf(ref)) {
      const l = await launch(p.app_path);
      if (typeof l === "string") return l;
      watchPid(l.pid);
      out.push(`started ${l.name} pid ${l.pid} (${p.app_path})`);
      ref = l.pid; launched = true;
    }
    const c = await checkInstances(ref, p.duplicates, p.app_path);
    if (!c.ok) return c.error;
    if (c.note) out.push(c.note);
    if (c.note?.startsWith("relaunched")) launched = true;
    try { target = await resolvePid(c.pid ?? ref); } catch (e: any) { return e.message; }
  }
  if (!target && !p.rect) return "a session needs something to watch: app (name or pid; app_path starts it), or rect with hands:false";
  if (!target && !watchOnly) return "a hand needs an app to press: pass app. A rect alone can only be watched (hands:false)";
  const unseen = (why: string) => `NOT OPENED, nothing was sent: ${why}. The hand does not go where the eye cannot.`;
  // A fresh launch: its window first (a debugger that interrupts an app mid-launch finds no symbols).
  if (launched && target && !p.rect) for (let i = 0; i < 30 && !(await windowRect(target.pid, p.window, true)).ok; i++) await sleep(200);
  if (target && p.probe === "xcode") { try { return await probeCommands(target.pid); } catch (e: any) { return e.message; } }
  await Promise.all(probeRunIds().map((id) => dropProbe(id))); // one left behind by a call that died
  let probeId: string | undefined;
  if (target && p.probe !== false) {
    const o = p.probe && typeof p.probe === "object" ? p.probe : {};
    const r = await startProbe(target.pid, { label: `${p.label ?? "session"}_probe`, ...o, max_seconds: 600 }, p.probe !== undefined);
    if (r.ok) { probeId = r.id; out.push(r.note); }
    else out.push(`no probe: ${r.why}. The session goes on without it: freezes are still found, but the function that blocked is not named (probe:false skips the attempt).`);
  }
  let rect: Rect, display: number | undefined = p.display, what: string, only: number | undefined, room: number[] | undefined;
  if (p.rect) {
    rect = p.rect;
    let ox = 0, oy = 0;
    try {
      const ds = JSON.parse((await run(BIN, ["displays"], 8000)).stdout).displays as any[];
      const dd = ds.find((x) => (display === undefined ? x.main : x.id === display));
      if (dd) { ox = dd.points.x; oy = dd.points.y; }
    } catch { /* main display, origin 0,0 */ }
    room = [rect.x + ox, rect.y + oy, rect.w, rect.h];
    if (p.isolate === true && target) only = target.pid;
    what = `${target ? `${target.name}, ` : ""}the region [${rectArg(rect)}]${only ? ", its own windows only" : ""}`;
  } else {
    const w = await windowRect(target!.pid, p.window, p.front ?? !watchOnly);
    if (!w.ok) { await dropProbe(probeId); return unseen(w.error); }
    rect = w.rect; display ??= w.display;
    if (p.isolate !== false) only = target!.pid;
    what = `${target!.name} ${w.what}${only ? ", its own windows only" : w.on_top ? "" : " (not the front window: what covers it is recorded too)"}`;
  }
  const idleS = p.idle_s ?? 30;
  const common = { rect, display, only_pid: only, events_pid: target?.pid, events: p.events, root: p.root,
    keyframe_ms: p.keyframe_ms ?? 200, keyframe_max: 1200, fps: p.fps, profile: p.profile === true ? (target ? { process: String(target.pid) } : undefined) : p.profile || undefined,
    motion_threshold: p.motion_threshold, split_gap_ms: p.split_gap_ms, refresh_hz: p.refresh_hz };
  const job = watchOnly
    ? startJob({ ...common, label: p.label ?? (target ? target.name : "watch"), ax: p.ax ?? false, ax_hz: p.ax_hz, tree: p.tree ?? "none",
        process: target ? String(target.pid) : undefined, cursor: p.cursor, command: p.command, cwd: p.cwd, lock_input: p.lock === true,
        pre_ms: p.pre_ms, post_ms: p.post_ms, timeout_s: p.timeout_s, seconds: p.seconds, max_seconds: p.max_seconds })
    : startJob({ ...common, label: p.label ?? "drive", ax: false, tree: "none", max_seconds: p.max_seconds ?? 600 });
  const block = watchOnly && !!(p.command || p.seconds);
  for (let i = 0; i < 600 && job.state === "starting"; i++) await sleep(50);
  if (job.state === "done" && /^capture failed/.test(job.final ?? "")) { await dropProbe(probeId); return unseen(job.final!); }
  if (!block) {
    for (let i = 0; i < 20 && job.state === "running" && blind(readLive(job.capture)); i++) await sleep(50);
    const dark = job.state === "running" ? blind(readLive(job.capture)) : `the capture did not start (${String(job.final ?? "no answer from ScreenCaptureKit in 30s").slice(0, 300)})`;
    if (dark) { job.stopped ??= "not seeing"; job.stopNow(); await dropProbe(probeId); return unseen(`could not watch ${target?.name ?? "the region"} — ${dark}`); }
  }
  let lock: Lock | undefined;
  if (!watchOnly && p.lock !== false && !(await coveringLock((idleS + 30) * 1000))) {
    // One short call that opens and ends: "Just a sec…" (no countdown). A session that stays open warns with 3·2·1.
    const short1 = p.end && stepsMs(p.steps) + (p.wing ? p.wing.split(/\s+/).length * 400 : 0) <= QUICK_MAX_MS;
    lock = startLock(idleS + 30, "tagged", p.lock_style ?? (short1 ? "quick" : "full"));
    if (!(await lock.ready)) { job.stopped ??= "lock refused"; job.stopNow(); await dropProbe(probeId); return await lockFailure(lock); }
  }
  drive = { job, target, window: p.window, hands: !watchOnly, lock, idleS, calls: 0, evAt: 0, what, probe: probeId, room, frames: p.frames !== false, block };
  // A hand needs the window in front: it presses only what is in sight. Put back when the session ends.
  if (target && (p.front ?? !watchOnly)) {
    const up = await raiseWindow(target.pid, p.window);
    if (!up.ok) return `${await endDrive("could not bring the window forward")}\nfront: ${up.error}`;
    drive.raised = up;
    if (!up.already_front) out.push(`brought ${fmtWin(up)} forward${up.was_minimized ? " (it was minimized)" : ""}; it goes back where it was when the session ends`);
    await sleep(150);
  }
  if (!watchOnly) {
    out.push(`session open on ${what}${lock ? ` · the user's input is held (${lock.id})` : " · the user's input is NOT held"} · recording ${job.id} → ${job.capture.dir}`);
    if (!p.end) p.look ??= true;
  } else if (block) {
    out.push(job.startNote ?? "", ...(await observedConflicts(job, rect)));
  } else {
    out.push(
      `watching ${what} · no hand: ${p.lock === true ? "the user's input is held for your own driver" : "input stays the user's"} · recording ${job.id} → ${job.capture.dir}`,
      job.startNote ?? "",
      job.ax ? "accessibility inspection ON (hover + tree): fps can read lower on SwiftUI apps." : "",
      describeLive(readLive(job.capture)),
      job.tree ? `observed windows (AX tree, global points):\n${capLines(job.tree, 120, `full tree: ${join(job.capture.dir, "ax_tree_start.txt")}`)}` : "",
      ...(await observedConflicts(job, rect)),
      `next: let it be driven, then eye_drive {end:true} for the report (it ends by itself after ${p.max_seconds ?? 300}s). Meanwhile eye_status shows what it sees now, and \`${LIVE_CMD}\` prints a line each time the screen starts or stops moving.`,
    );
  }
  return "";
}

server.registerTool("eye_drive", {
  title: "Drive an app and see what it looked like: one session, a hand or just eyes",
  description: [
    "ONE SESSION on an app: a recording of its window, the input lock, a hand on the mouse and (in Debug builds) a probe inside the app. The first call opens it (`app`), every call may move, `end:true` closes it and returns WHAT IT LOOKED LIKE for the whole of it.",
    "One call that does everything: eye_drive {app, wing or steps, end:true}.",
    "TWO WAYS TO MOVE, mixed freely in one session.",
    `(1) wing: a line of words that is ONE unbroken motion, with no stop between its points. Words: ${WING_WORDS}.`,
    "e.g. wing:'\"7\" tap \"Add\" tap \"3\" tap \"Equals\" tap settle' · wing:'\"Volume\" down E 80 rest 200 W 30 up' (a drag, steered) · wing:'slow E' (keep going; the next wing turns it).",
    "The hand aims at THINGS by name as they are on screen right now, follows one that moves, and presses only what is under it: a thing that is not in sight is not reached for, and the reply says what is.",
    "The reply lists every element the pointer passed over, each press where it happened, and where the hand is now.",
    "(2) steps: exact, repeatable to the millisecond, for measuring and A/B: move {x,y,ms}, click {x?,y?,button,count}, down/up (drag = down, move, up), scroll {dy,dx,events,phased,momentum},",
    "pinch {scale,ms}, rotate {degrees,ms}, smart_zoom, swipe {direction}, press {force:[0…2 keyframes],ms} and force_click {ms} (Force Touch), wait {ms}, wait_until {expr,timeout_ms}, assert {expr}; any step may carry `guard`.",
    "Expressions see: a = top-anchored open extent {x0,x1,w,h,cx} or null, e = bbox of all change, moving, fps1, gap1 (ms), p = pointer {x,y}, h = element under the pointer (role, title, description, identifier, value, frame, …) or null, live, pr / L('label') = probe layers.",
    "After each step: the pointer, the element under it, the visible state. Presses and gestures only land on the app; scrolls only inside the measured open area or scroll_zones (force:true skips that).",
    "EVERY REPLY ends with the screen (moving / still), what a viewer noticed during this call, what the app told accessibility, and the frame it settled on.",
    "NEVER UNSEEN: nothing is sent to a window that is minimized, hidden, on another Space or on a sleeping display, and the hand brakes where it is if the capture goes blind.",
    "ONLY WATCH (hands:false): the same session with no hand and no lock, for when the user drives, or your own script does: stays open until end:true; or `seconds` records that long and returns the report; or `command` runs your driver (env THE_EYE_LIVE, THE_EYE_RECT, THE_EYE_RUN_DIR) and returns its output and the report (lock:true holds the user's input meanwhile).",
    "Also: app_path starts the app when it is not running; quit:true quits it (with end, or alone); ask:\"…\" puts a yes/no to the person at the machine.",
  ].join(" "),
  inputSchema: {
    wing: z.string().optional().describe("The motion, as words: one unbroken flight."),
    steps: z.array(stepSchema).max(60).optional().describe("Exact steps, each followed by what the pointer is over and what the screen did. Run after `wing` when both are given."),
    app: z.union([z.string(), z.number()]).optional().describe("The app (name or pid). Needed on the call that opens the session; the session keeps it."),
    app_path: z.string().optional().describe("The .app to start when no copy of it runs (and the one started by duplicates:\"relaunch\"), e.g. the build you just made."),
    window: z.string().optional().describe("Which of the app's windows (title substring). Default its main window."),
    rect: rectSchema.optional().describe("Watch this display-local region instead of the app's window (with hands:false it needs no app at all)."),
    display: z.number().int().optional().describe("Display of `rect` (eye_status lists them; default main)."),
    hands: z.boolean().optional().describe("false = only watch: no hand, no lock, no idle end. The user or your own driver moves things."),
    seconds: z.number().positive().max(600).optional().describe("Only watch, for this long, then return the report (implies hands:false)."),
    command: z.string().optional().describe("Only watch while this shell command runs (/bin/zsh -lc), then return its output and the report (implies hands:false)."),
    cwd: z.string().optional(),
    pre_ms: z.number().optional().describe("command: record this long before starting it (default 500)."),
    post_ms: z.number().optional().describe("command: keep recording after it exits (default 1000)."),
    timeout_s: z.number().positive().max(600).optional().describe("command: kill it after this (default 300)."),
    max_seconds: z.number().positive().max(600).optional().describe("The recording stops by itself after this (default 600 with a hand, 300 watching)."),
    end: z.boolean().optional().describe("End the session after this call: let go, free the user's input, report what the whole of it looked like (with the frame at each defect)."),
    quit: z.boolean().optional().describe("Quit the app: with end, after the report; alone with `app`, right away. The user is asked first when the copy may be theirs."),
    ask: z.string().min(1).max(QUESTION_MAX).optional().describe(`Ask the person at the machine a yes/no before you do something they may mind (at most ${QUESTION_MAX} characters). Input locks at once and the question fills the screen with three buttons: "Nope" · "Yep" (highlighted) · "Mi casa su casa" (yes to this same question for the rest of the session). Unanswered after ${ASK_SECONDS}s the highlighted one is taken. Returns the answer; nothing else in the call is done.`),
    probe: z.union([z.boolean(), z.literal("xcode"), z.object({
      match: z.array(z.string()).optional().describe("Only log layers whose label (layer class, view class, name) contains one of these."),
      watch: z.array(z.string()).optional().describe("Always show these layers in the live summary, moving or not."),
      full_walk: z.boolean().optional(), max_layers: z.number().int().positive().optional(),
    })]).optional().describe("The probe inside the app: times the main thread (every freeze gets its cause) and logs each layer's animated geometry and the animation its code declared. Tried by itself once per app launch when a session opens; it needs a Debug build (or System Integrity Protection off), costs about 0.2ms a frame, and when it cannot go in the reply says why in one line and the session goes on. false = don't try. true or {match, watch} = try again / choose layers. \"xcode\" = the app runs under Xcode's debugger: print the lldb commands to send through Xcode."),
    look: z.boolean().optional().describe("Also show the app's element tree as it is now (shown by itself when a session with a hand opens)."),
    frames: z.boolean().optional().describe("Hand frames back with the replies: the settled frame after each call and, at the end, the frame at each defect (default true)."),
    speed: z.number().min(20).max(4000).optional().describe("wing: pace in points per second from here on (default 700; or the words slow / walk / brisk / fast / <n>/s)."),
    coast_ms: z.number().min(0).max(10000).optional().describe("wing: how long a hand left flying on a heading keeps going after the reply before it brakes by itself (default 1500)."),
    scroll_zones: z.array(rectSchema).optional().describe("steps: extra screen rects (points) where scrolling is allowed, e.g. the closed notch."),
    idle_s: z.number().min(3).max(300).optional().describe("A session with a hand ends by itself when no call comes for this long (default 30): input is never held while nobody is steering."),
    front: z.boolean().optional().describe("Bring the window to the front when the session opens (also from minimized) and put it back, with everything that was above it, when it ends. Default true with a hand, false when only watching. false = leave it where it is: a press on a part another app covers is then refused."),
    lock: z.boolean().optional().describe("Hold the user's physical input. Default true with a hand (false = they can move the pointer too, and will fight it); false when only watching (true = hold it for your own driver)."),
    lock_style: z.enum(["full", "quick"]).optional().describe("full: 3·2·1 warning and the orange overlay (default for a session that stays open). quick: the small pill, no countdown (default for one short call with end:true)."),
    label: z.string().optional().describe("Name of the recording (run folder, reports)."),
    isolate: z.boolean().optional().describe("Record the app's own windows alone, over mid grey, so nothing behind a see-through window or over the app is mistaken for its motion. Default true on a window, false on a rect."),
    events: z.boolean().optional().describe("Listen to what the app tells accessibility and place it on the recording's clock (default true)."),
    root: z.boolean().optional().describe("false = no dtrace / powermetrics beside the recording (signposts and the app's own energy need no root and stay)."),
    keyframe_ms: z.number().min(0).optional().describe("Keep a small frame every N ms while the picture changes (default 200; 0 = none). They are what the defect frames are taken from; eye_snapshot {csv, t_s} reads them."),
    fps: z.number().optional(),
    profile: z.union([z.boolean(), profileSchema]).optional().describe("true = also record Instruments (Time Profiler + Hitches) on the session's app, aligned with the frames for eye_report view:'explain'. Starting it takes a few seconds; accessibility hover is off by default while it runs. An object names another process or template."),
    ax: z.boolean().optional().describe("steps: tell the element under the pointer after each (default true). Only watching: log the element under the pointer ten times a second (default false; it costs the app frame time)."),
    tree: treeSchema.optional().describe("Only watching: the element tree of the observed windows at start (default none)."),
    duplicates: z.enum(["ask", "quit_others", "relaunch", "allow"]).optional().describe(duplicatesSchemaDescription),
    ...analysisOpts,
  },
}, driving("eye_drive", fail, async (p): Promise<any> => {
  if (p.ask) {
    const r = await ask(p.ask);
    return typeof r === "string" ? fail(`not asked — ${r}`) : text(sayReply(cleanQuestion(p.ask), r));
  }
  const out: string[] = [], imgs: any[] = [];
  const done = (bad = false) => ({ content: [{ type: "text", text: out.filter(Boolean).join("\n") }, ...imgs, ...endFrames.splice(0)], ...(bad ? { isError: true } : {}) });
  if (driveEnded) { out.push(driveEnded); driveEnded = ""; }
  if (drive) clearTimeout(drive.idle);
  if (drive && !running(drive.job)) out.push(await endDrive("its recording ended"));
  const acting = !!(p.wing?.trim() || p.steps?.length);
  let opened = false;
  if (!drive) {
    const watching = p.hands !== undefined || !!p.command || !!p.seconds;
    if (p.quit && !acting && !p.look && !watching) {
      const fam = p.app !== undefined ? familyOf(p.app) : null;
      if (!fam) { out.push(p.app === undefined ? "quit needs app" : `no running app matches "${p.app}"`); return done(p.app === undefined); }
      const left = await quitPids([fam.target.pid]);
      out.push(left.length ? notQuit(left) : `quit pid ${fam.target.pid}\n${listFamily(p.app!)}`);
      return done(left.length > 0);
    }
    if (!acting && !p.look && !watching && p.app === undefined && !p.app_path && !p.rect) {
      if (!out.length) out.push(p.end ? "no session is open: nothing to end" : "no session is open: pass app with a wing or steps, or hands:false to only watch");
      return done(out.length === 1 && !p.end && !out[0].startsWith("("));
    }
    opened = true;
    const why = await openDrive(p, out);
    if (why) { out.push(why); return done(p.probe !== "xcode"); }
  } else if (p.app !== undefined && drive.target && String(p.app) !== String(drive.target.pid) && !drive.target.name.toLowerCase().includes(String(p.app).toLowerCase())) {
    const d = drive;
    if (d.hands) d.idle = setTimeout(idleOut, d.idleS * 1000);
    out.push(`NOT RUN: a session is open on ${d.what}. End it first (eye_drive {end:true}), then open one on "${p.app}".`);
    return done(true);
  }
  const d = drive!;
  if (p.idle_s) d.idleS = p.idle_s;
  const cap = d.job.capture;
  const rearm = () => { if (d.hands) d.idle = setTimeout(idleOut, d.idleS * 1000); };
  if (d.block) {
    await d.job.finished;
    out.push(await endDrive(p.command ? "the command ended" : `${p.seconds}s recorded`, p.quit));
    return done();
  }
  // A session that only watches may still wait on the screen and check it: those steps send nothing.
  const passive = !p.wing?.trim() && (p.steps ?? []).every((x: any) => ["wait", "wait_until", "assert"].includes(x.op));
  if (acting && !d.hands && !passive) {
    rearm();
    out.push("NOT RUN, nothing was sent: this session only watches (hands:false), so only wait, wait_until and assert steps run in it. End it and open one without hands:false to move things.");
    return done(true);
  }
  if (acting || p.look) {
    // The eye first, as ever: nothing is sent while the recording does not really see.
    let dark = blind(readLive(cap));
    for (const since = Date.now(); dark && Date.now() - since < 1500; dark = blind(readLive(cap))) await sleep(50);
    if (dark) { out.push(`NOT RUN, nothing was sent: the eye is shut — ${dark}.`, await endDrive("the eye went blind")); return done(true); }
  }
  let flying = false;
  if (acting) {
    d.calls++;
    if (d.lock) extendLock(d.lock, d.idleS + 60 + Math.ceil(stepsMs(p.steps) / 1000));
    const seenFrom = readLive(cap)?.t ?? 0;
    const front: Front = { want: p.front, window: d.window, raised: d.raised };
    const exact = (steps: any[], brief: true | "word") => actSteps({ steps, id: d.job.id, ax: p.ax ?? true, scroll_zones: p.scroll_zones, label: p.label, brief }, d.target!, front);
    let halted = false;
    if (p.wing?.trim()) {
      const w = parseWing(p.wing);
      if ("error" in w) { rearm(); out.push(w.error); return done(true); }
      // The wing in stretches: what the hand flies in one motion, and the exact words between (a gesture, a wait on the screen).
      const parts: { moves: any[]; words: string[]; step?: any }[] = [];
      w.moves.forEach((m, i) => {
        if (m.k === "exact") parts.push({ moves: [], words: [w.words[i]], step: m.step });
        else if (parts.length && !parts[parts.length - 1].step) { parts[parts.length - 1].moves.push(m); parts[parts.length - 1].words.push(w.words[i]); }
        else parts.push({ moves: [m], words: [w.words[i]] });
      });
      for (const [n, part] of parts.entries()) {
        if (part.step) {
          const t = String((await exact([{ ...part.step, note: part.words[0] }], "word")).content[0].text);
          out.push(t);
          if (/^STOPPED — /m.test(t)) halted = true;
        } else {
          const room = await driveRoom(d);
          if ("error" in room) { out.push(`NOT FLOWN, nothing was sent: ${room.error}.`, await endDrive("the window is not there to be seen")); return done(true); }
          const r = await actorSend({ op: "wing", moves: part.moves, pid: d.target!.pid, require_pid: d.target!.pid, bounds: room.bounds,
            live: liveFile(cap), speed: p.speed, coast_ms: p.coast_ms, max_ms: 30_000 }, 35_000);
          if (!r.ok) { rearm(); out.push(`the hand did not answer: ${r.error}`); return done(true); }
          for (const m of r.marks ?? []) {
            if (m.k === "note") continue;
            const op = /^tap|right-tap/.test(m.k) ? "click" : m.k;
            try { appendFileSync(join(cap.dir, "actions.jsonl"), JSON.stringify({ wall0: m.wall0, wall1: m.wall1, op, note: /"([^"]+)"/.exec(String(m.what))?.[1] ?? String(m.what), x: m.x, y: m.y, ok: true }) + "\n"); } catch { /* run dir gone */ }
          }
          out.push(...wingText(part.words, r));
          if (r.blind) out.push(`⚠ NOT SEEING: ${r.blind}. The hand braked where it was; what the last moves did was not watched.`);
          flying = !!r.flying;
          if (r.stopped) halted = true;
        }
        if (halted) {
          const rest = parts.slice(n + 1).flatMap((x) => x.words);
          if (rest.length) out.push(`not flown after that: ${rest.join(" ")}`);
          break;
        }
      }
    }
    if (p.steps?.length) {
      if (halted) out.push(`steps NOT RUN: the wing before them stopped (${p.steps.length} step${p.steps.length === 1 ? "" : "s"} not sent)`);
      else { out.push(String((await exact(p.steps, true)).content[0].text)); flying = false; }
    }
    if (front.raised && !d.raised) {
      d.raised = front.raised;
      out.push(`brought ${fmtWin(front.raised)} forward (another app covered the press); it goes back where it was when the session ends`);
    }
    // Whatever this set going plays out a moment before the screen is read (a hand left flying is not waited for).
    if (!flying) for (let still = 0, end = Date.now() + 600; still < 3 && Date.now() < end; await sleep(50)) still = readLive(cap)?.moving ? 0 : still + 1;
    // A call that opens and ends the session gets the session's report below: saying it twice helps nobody.
    if (!(p.end && d.calls <= 1)) {
      out.push(describeLive(readLive(cap)));
      try {
        const { rows, meta } = loadRun(cap.csv);
        snapshotStalls(cap.dir);
        const o = { ...d.job.opts, from_s: seenFrom };
        out.push(`during this call: ${formatSeen(notice(rows, meta, analyze(rows, meta, o), { ...o, dir: cap.dir, still_recording: true }), 5, probedRun(cap.dir))}`);
      } catch { /* not flushed yet */ }
      const ev = driveEvents(d);
      if (ev) out.push(ev);
      const pl = d.probe ? activeProbeLive() : null;
      if (pl) out.push(describeProbeLive(pl, 4));
    }
    if (d.frames && p.frames !== false && !flying && !p.end) {
      const f = await settledFrame(d.job);
      if (f) imgs.push({ type: "text", text: "the frame it settled on:" }, f);
    }
  }
  if (p.frames === false) d.frames = false;
  if (p.look) {
    const t = await axTree({ rect: d.job.rect, display: d.job.display, process: d.target ? String(d.target.pid) : undefined, mode: "basic" });
    const room = d.hands ? await driveRoom(d) : null;
    const where = room && "bounds" in room ? ` (the room the hand moves in: [${room.bounds[0].toFixed(0)},${room.bounds[1].toFixed(0)} ${room.bounds[2].toFixed(0)}×${room.bounds[3].toFixed(0)}], global points)` : " (global points)";
    out.push(`in sight now${where}:\n${capLines(t.text, 90, "eye_inspect {process} shows all of it")}`);
  }
  if (p.end) out.push(await endDrive("you ended it", p.quit));
  else {
    rearm();
    if (d.hands) out.push(`session open · next: another wing or steps, or end:true (it ends by itself after ${d.idleS}s without a call)`);
    else if (!opened) out.push(`still watching · end:true for the report`);
  }
  return done();
}));
function idleOut() {
  const s = drive?.idleS;
  endDrive(`no call came for ${s}s`).then((t) => { driveEnded = `(the previous session was not ended by you)\n${t}`; }).catch(() => {});
}

// ---- "Just a sec…": bring a window forward, look, put it back (eye_snapshot {app})

async function glance(p: any): Promise<any> {
  const inst = await checkInstances(p.app, p.duplicates);
  if (!inst.ok) return fail(inst.error);
  let target: { pid: number; name: string };
  try { target = await resolvePid(inst.pid ?? p.app); } catch (e: any) { return fail(e.message); }
  const look = new Set<string>(p.look ?? ["image", "tree"]);
  const t0 = Date.now();
  const cover = await coveringLock(3000);
  const own = cover ? undefined : startLock(8, "tagged", "quick");
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
      const file = p.path ?? join(gdir, "glance.png");
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
  } finally {
    if (raised?.ok) { back = await restoreWindow(raised); mark("restore"); }
    if (own) { own.child.stdin!.write("release\n"); await Promise.race([own.freed, sleep(1500)]); mark("release"); }
  }
  const held = Date.now() - tLocked;
  if (own) await stopLock(own); // the pill's exit animation runs with input already free
  if (rest.image && rest.tree && rest.at && p.measure !== false) {
    const seen = await atRest({ image: rest.image, raw: `${rest.image}.rgba`, tree: rest.tree, at: rest.at });
    if (seen) out.push(seen);
  } else if (rest.image) rmSync(`${rest.image}.rgba`, { force: true });
  out.push(`${back} · user input held ${own ? `${(held / 1000).toFixed(2)}s ("Just a sec…": ${marks.join(", ")})` : "by the session lock already running"} · whole call ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  return withNotes({ content: [{ type: "text" as const, text: out.join("\n\n") }, ...content] }, inst.note ?? "");
}

// ---- reports

server.registerTool("eye_report", {
  title: "Analyze recordings",
  description: [
    "Re-analyze recorded runs (default: the most recent one). view: summary (default) = what a viewer would have noticed, then",
    "one row per motion (fps = new images per second vs the display refresh; stall% = observed refreshes with no new image, a lower",
    "bound; hitch = a gap ≥1.5 frames, long ≥3; jumps = abrupt speed changes of the moving edge; w/h = its extent in points);",
    "timeline = binned time series (frames, idle, worst gap, % moved, luma, extent); explain = the worst on-screen gaps joined",
    "with where the pointer was, which element it was over, which step ran and (with profile) the app's main thread;",
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

setProbeRoot(ROOT);

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
