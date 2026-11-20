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
import { analyze, compare, formatAnalysis, loadRun, timeline, type Options, type Row } from "./analyze.ts";
import { explain } from "./explain.ts";
import { formatSeen, notice, type Seen } from "./notice.ts";
import { endUnder, startUnder, stopUnder, type Under } from "./under.ts";
import { still, type Img } from "./still.ts";
import { WING_WORDS, parseWing, wingMs } from "./wing.ts";
import { CHAPTERS, chapter, chapterFor, overview, pointer } from "./guide.ts";
import {
  activeProbeLive as appProbeLive, activeProbeTarget, analyzeProbe, describeProbeLive, probeCommands, probeRunIds, probeRunsStatus,
  resolvePid, setProbeRoot, snapshotStalls as appStalls, startProbe, stopProbes,
} from "./probe.ts";
import {
  closePage, openPage, pageActive, pageFind, pageLive, pageOpen, pageSaid, pageStalls, pageStatus, pageTool, pageTree, quitBrowser, setWebRoot,
  startPageProbe, stopPageProbe,
} from "./web.ts";
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

// The probe is in the app (probe.ts) or in the page (web.ts): whichever this session has answers.
const activeProbeLive = () => (pageActive() ? pageLive() : appProbeLive());
const snapshotStalls = (dir: string) => (pageActive() ? pageStalls(dir) : appStalls(dir));

type Rect = { x: number; y: number; w: number; h: number };
const rectArg =(r: Rect) => `${r.x},${r.y},${r.w},${r.h}`;

const rectSchema = z.object({
  x: z.number(), y: z.number().describe("0 = top of the screen"), w: z.number().positive(), h: z.number().positive(),
}).describe("Screen region in display-local POINTS, top-left origin.");

const profileSchema = z.object({
  process: z.coerce.string().describe("Process name or pid to attach Instruments to."),
  template: z.string().optional(), hitches: z.boolean().optional(), keep_trace: z.boolean().optional(),
}).optional();

const treeSchema = z.enum(["none", "basic", "full"]);

const analysisOpts = {
  motion_threshold: z.number().optional().describe("Fraction of pixels that must change for a frame to count as moving (default 0.0005)."),
  split_gap_ms: z.number().optional().describe("A pause longer than this splits motions (default 150)."),
  refresh_hz: z.number().optional().describe("Target refresh rate (default: the display's)."),
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
  /** `eye-capture fingers`: the user's own trackpad touches, on fingers.jsonl beside the frames. */
  fingers?: ChildProcess;
  /** Signposts and vitals of the recorded app, plus dtrace + powermetrics when sudo needs no password (under.ts). */
  under?: Under | null;
};
const captures = new Map<string, Capture>();
/**
 * `ready` resolves true once input is actually blocked (after the countdown and the settle wait), false if the
 * helper refused (its preflight runs BEFORE any countdown) or died. Callers take locks through holdLock, which
 * starts another until one engages. style "quick" = "Just a sec…": no countdown,
 * a small pill instead of the orange wash.
 */
type LockStyle = "full" | "quick";
type Lock = { id: string; child: ChildProcess; done: Promise<string>; ready: Promise<boolean>; until: number; style: LockStyle; engaged?: string;
  /** Set when it took more than one try to engage (holdLock): how many, how long, and what the first refusal said. */
  waited?: string;
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
function startFingers(c: Capture, seconds: number) {
  try {
    c.fingers = spawn(BIN, ["fingers", "--out", join(c.dir, "fingers.jsonl"), "--seconds", String(Math.ceil(seconds))], { stdio: "ignore" });
    c.fingers.on("error", () => {});
  } catch { /* the recording goes on without it */ }
}
type Touch = { t0: number; ms: number; path: number; pts: [number, number, number][]; x: number; y: number; flung: boolean };
/** The touches in a fingers.jsonl: each from fingers down to fingers up, as [seconds, x, y] from where it began. */
function loadTouches(file: string): Touch[] {
  const out: Touch[] = [];
  let cur: Touch | null = null, first = 0;
  let lines: string[] = [];
  try { lines = readFileSync(file, "utf8").split("\n"); } catch { return out; }
  for (const l of lines) {
    let e: any; try { e = JSON.parse(l); } catch { continue }
    first ||= e.t;
    if (e.ph === 1) cur = { t0: e.t - first, ms: 0, path: 0, pts: [[0, 0, 0]], x: e.x, y: e.y, flung: false };
    else if (cur && e.ph === 2) {
      const [, x, y] = cur.pts[cur.pts.length - 1];
      cur.pts.push([e.t - first - cur.t0, x + e.dx, y + e.dy]); cur.path += Math.hypot(e.dx, e.dy);
    } else if (cur && (e.ph === 4 || e.ph === 8)) { cur.ms = (e.t - first - cur.t0) * 1000; if (cur.pts.length > 2) out.push(cur); cur = null; }
    else if (!cur && e.mo === 1 && out.length) out[out.length - 1].flung = true;
  }
  return out;
}
/**
 * A touch in numbers, the same for a person's and for the hand's, so the two can be held side by side.
 * pts = [seconds, x, y] on the trackpad, y down. Speeds, turns and pauses are read off where the fingers were every
 * 50ms, not off the raw events (7ms apart, and none at all while the fingers rest).
 */
function touchLine(pts: number[][]): string {
  if (pts.length < 3) return "too short to say";
  const t0 = pts[0][0], dur = pts[pts.length - 1][0] - t0;
  let path = 0;
  for (let i = 1; i < pts.length; i++) path += Math.hypot(pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
  const xs = pts.map((p) => p[1]), ys = pts.map((p) => p[2]);
  const W = 0.05, at: number[][] = [];
  for (let k = 0, i = 0; k * W <= dur + 1e-9; k++) {
    const t = t0 + k * W;
    while (i < pts.length - 2 && pts[i + 1][0] <= t) i++;
    const a = pts[i], b = pts[i + 1] ?? a, u = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
    at.push([a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
  }
  const sp: number[] = [];
  let turns = 0, pa: number | null = null, still = 0, pause = 0, run = 0;
  for (let k = 1; k < at.length; k++) {
    const dx = at[k][0] - at[k - 1][0], dy = at[k][1] - at[k - 1][1], d = Math.hypot(dx, dy);
    sp.push(d / W);
    if (d / W < 25) { still++; run++; pause = Math.max(pause, run); } else run = 0;
    if (d >= 3) {
      const a = Math.atan2(dy, dx);
      if (pa !== null && Math.abs(Math.atan2(Math.sin(a - pa), Math.cos(a - pa))) > Math.PI / 2) turns++;
      pa = a;
    }
  }
  const sorted = [...sp].sort((a, b) => a - b), q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))] : 0);
  return `${dur.toFixed(2)}s · ${path.toFixed(0)}pt inside ${(Math.max(...xs) - Math.min(...xs)).toFixed(0)}×${(Math.max(...ys) - Math.min(...ys)).toFixed(0)}pt · median ${q(0.5).toFixed(0)}, p90 ${q(0.9).toFixed(0)}pt/s · turned back ${turns}× · still ${((100 * still) / Math.max(1, sp.length)).toFixed(0)}% (longest ${(pause * W).toFixed(2)}s)`;
}
/** The newest run in which a person's two-finger touches were recorded. */
/** The newest run in which a PERSON touched the trackpad (a session the hand drove is not one), for at least `minMs`. */
function lastTouched(minMs = 0): string | null {
  try {
    const hit = readdirSync(RUNS).filter((x) => existsSync(join(RUNS, x, "fingers.jsonl")) && !existsSync(join(RUNS, x, "hand.jsonl"))).sort().reverse()
      .find((x) => loadTouches(join(RUNS, x, "fingers.jsonl")).some((t) => t.ms >= minMs));
    return hit ? join(RUNS, hit) : null;
  } catch { return null; }
}
function touchesText(dir: string): string[] {
  const ts = loadTouches(join(dir, "fingers.jsonl"));
  if (!ts.length) return [];
  const L = [`YOUR FINGERS (two-finger touches on the trackpad while this was watched): ${ts.length}`];
  ts.forEach((t, i) => L.push(`  touch ${i + 1}: at ${t.t0.toFixed(2)}s at (${t.x.toFixed(0)},${t.y.toFixed(0)}) · ${touchLine(t.pts)}${t.flung ? " · left with a flick" : ""}`));
  L.push(`  play one back as it was made: wing 'fingers like:"${dir}" <n>' (or like:"last"; without n, the longest)`);
  return L;
}
/** The touches the hand made in a session (hand.jsonl: [recording seconds, x, y, touch]), and a person's beside them. */
function handTouchesText(dir: string): string[] {
  const by = new Map<number, number[][]>();
  try {
    for (const l of readFileSync(join(dir, "hand.jsonl"), "utf8").split("\n")) {
      let e: any; try { e = JSON.parse(l); } catch { continue; }
      if (!Array.isArray(e) || e.length < 4) continue;
      if (!by.has(e[3])) by.set(e[3], []);
      by.get(e[3])!.push([e[0], e[1], e[2]]);
    }
  } catch { return []; }
  const ts = [...by.values()].filter((p) => p.length > 2);
  if (!ts.length) return [];
  const L = [`THE HAND'S TOUCHES (two fingers, landing to lifting): ${ts.length}`];
  ts.forEach((p, i) => L.push(`  ${i + 1}: at ${p[0][0].toFixed(2)}s · ${touchLine(p)}`));
  return L;
}
/** `fingers like:"…"` → the recorded touch as a trace the hand plays. A string = why not. */
function touchFor(like: string, n?: number): { trace: number[][]; what: string } | string {
  let dir = like;
  if (like === "last") {
    const hit = lastTouched();
    if (!hit) return `no recorded touch: watch the user first (eye_drive {hands:false, seconds:N}) while they move two fingers on the trackpad`;
    dir = hit;
  }
  const ts = loadTouches(dir.endsWith(".jsonl") ? dir : join(dir, "fingers.jsonl"));
  if (!ts.length) return `no two-finger touch was recorded in ${dir}`;
  const t = n !== undefined ? ts[n - 1] : [...ts].sort((a, b) => b.ms - a.ms)[0];
  if (!t) return `${dir} holds ${ts.length} touch${ts.length === 1 ? "" : "es"}; there is no touch ${n}`;
  return { trace: t.pts, what: `${(t.ms / 1000).toFixed(2)}s, ${t.path.toFixed(0)}pt` };
}
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
  c.events?.kill("SIGTERM"); c.fingers?.kill("SIGTERM");
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
  // Esc ×6: the user wants their machine back NOW. The hand stops at once (it may be playing by itself between calls),
  // and the session that held this lock ends.
  child.stdout!.on("data", (x) => { if (/"ended":\s*"escape"/.test(String(x))) tookBack(l); });
  l.done.then((r) => { finishedLocks.unshift(`${id}: ${r}`); finishedLocks.length = Math.min(finishedLocks.length, 10); })
    .finally(() => locks.delete(id));
  return l;
}
function tookBack(l: Lock) {
  try { actor?.child.kill("SIGUSR1"); } catch { /* no hand */ }
  const d = drive;
  if (!d || d.lock !== l || d.taken) return;
  d.taken = true;
  // No call in flight: end it here. One in flight sees `taken` when the hand answers (it answers at once) and ends it.
  if (!d.busy) { clearTimeout(d.idle); endDrive("the user took their input back with Esc ×6").then((t) => { driveEnded = `(the previous session was ended by the user: Esc ×6)\n${t}`; }).catch(() => {}); }
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
  return m ? `input lock refused — ${m[0]}` : `input lock failed: ${out.slice(-400).trim()}`;
}
/**
 * A lock does not fail: one that is refused (preflight) or dies is taken again, and again, until one engages.
 * Nothing is driven meanwhile, so the caller simply waits. A refusal shows nothing on screen, so the retries are
 * silent. Only `giveUp` ends it without a lock (a run that was told to stop); then the answer is undefined.
 */
/**
 * What the lock needs from macOS, asked for when a lock is refused: the system prompt for each missing permission,
 * and its pane in System Settings. Asked on every failed try, for as long as something is missing.
 */
async function askPerms(): Promise<string> {
  let j: any;
  try { j = JSON.parse((await run(BIN, ["perms"], 5000)).stdout); } catch { return ""; }
  const missing = [!j.accessibility && "Accessibility", !j.input_monitoring && "Input Monitoring"].filter(Boolean).join(" and ");
  if (missing) await run(BIN, ["perms", "--ask"], 8000).catch(() => {});
  return missing;
}
async function holdLock(make: () => Lock, giveUp?: () => boolean, first?: Lock): Promise<Lock | undefined> {
  const t0 = Date.now();
  let why = "";
  for (let n = 1, l = first ?? make(); ; n++, l = make()) {
    if (await l.ready) {
      if (n > 1) l.waited = `the lock engaged on try ${n}, after ${((Date.now() - t0) / 1000).toFixed(1)}s (first: ${why})`;
      return l;
    }
    why ||= await lockFailure(l);
    const missing = await askPerms();
    if (missing && !/asked the user/.test(why)) why += `; asked the user for ${missing}`;
    if (giveUp?.()) return undefined;
    await sleep(Math.min(2000, 300 * n));
    if (giveUp?.()) return undefined;
  }
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
  /** The app whose update cycle is read beside the frames (under.ts), when it is not `events_pid`. */
  under_pid?: number;
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
    let stopAsked = false;
    stopReq.then(() => (stopAsked = true));
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
    if (!job.stopped) startFingers(c, capOpts.seconds + 5);
    const underPid = p.under_pid ?? p.events_pid;
    if (underPid && !job.stopped) c.under = startUnder(c.dir, underPid, capOpts.seconds + 5, { root: p.root !== false, helper: BIN });
    if (retried.length) job.startNote = (`capture retried ${retried.length}× (ScreenCaptureKit refused to start: ${retried[0]})`);
    const treeMode = p.tree ?? (ax ? "basic" : "none");
    if (treeMode !== "none" && !job.stopped) {
      job.treeFile = join(c.dir, "ax_tree_start.json");
      const t = await axTree({ rect: p.rect, display: p.display, process: p.process, mode: treeMode, out: job.treeFile });
      job.tree = t.text;
      if (t.ok) writeFileSync(join(c.dir, "ax_tree_start.txt"), t.text);
    }
    await pre;
    // Never run a driver the user can still disturb: the run waits for the lock, however many tries it takes.
    if (job.lock) {
      job.lock = await holdLock(() => (job.lock = startLock(limit + 10, "synthetic")), () => stopAsked || !!job.stopped, job.lock);
      if (!job.lock) job.stopped ??= "stopped while waiting for the input lock";
      else if (job.lock.waited) job.output.push(job.lock.waited);
    }
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

// What an agent gets on connect is the outline (skills/the-eye/SKILL.md); the chapters come when asked for (guide.ts).
const INSTRUCTIONS = overview();

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
    ...pageStatus(),
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
    page: z.boolean().optional().describe("The open website's page instead: what can be pressed or read in its window, with CSS selector, name, state, value and screen rect (needs an open eye_drive {url} session)."),
  },
}, async (p) => {
  const out: string[] = [];
  if (p.page) return pageOpen() ? text(await pageTree(p.max_nodes ?? 250)) : fail("no page is open: eye_drive {url} opens one");
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

// The outline only: what each field means is the manual's "steps" chapter (skills/the-eye/steps.md).
const stepSchema = z.object({
  op: z.enum(["move", "click", "down", "up", "scroll", "pinch", "rotate", "smart_zoom", "swipe", "press", "force_click", "wait", "wait_until", "assert", "type", "key", "goto", "reload"]),
  x: z.number().optional(), y: z.number().optional().describe("Global points."),
  ms: z.number().optional().describe("move: glide (0 = jump) · wait · pinch/rotate/press: duration"),
  force: z.union([z.array(z.number().min(0).max(2)).min(2), z.boolean()]).optional().describe("press: pressure keyframes 0…2 (crossing 1 = force click) · scroll: true skips the where-may-it-land check"),
  behavior: z.number().int().optional(),
  button: z.enum(["left", "right"]).optional(), count: z.number().int().optional(), hold_ms: z.number().optional(),
  dy: z.number().optional().describe("scroll: pixels, negative = further down the page"), dx: z.number().optional(), events: z.number().int().optional(),
  interval_ms: z.number().optional(), phased: z.boolean().optional(),
  momentum: z.boolean().optional().describe("scroll: coast after the fingers lift"),
  decay: z.number().min(0.5).max(0.99).optional(),
  scale: z.number().positive().optional().describe("pinch: 2 = spread to double"),
  degrees: z.number().optional().describe("rotate: + = clockwise"),
  direction: z.enum(["left", "right", "up", "down"]).optional().describe("swipe"),
  expr: z.string().optional().describe("wait_until/assert: JS over a, e, moving, fps1, gap1, p, h, live, pr, L()"),
  text: z.string().optional().describe("type (websites)"),
  key: z.string().optional().describe("key (websites): \"Enter\", \"Meta+a\""),
  url: z.string().optional().describe("goto (websites)"),
  js: z.string().optional().describe("wait_until/assert (websites): JS run in the page, truthy = holds"),
  timeout_ms: z.number().optional().describe("wait_until (default 2000)"),
  guard: z.string().optional().describe("Must hold before this step runs, else the sequence stops."),
  on: z.union([z.string(), z.number()]).optional().describe("click/down/move at a thing instead of x,y. Websites: CSS selector, name or text in the page. Apps: a probe layer (label or id)."),
  note: z.string().optional(),
});

// ---- bring a window forward, put it back

/** "Just a sec…" is for something over in under four seconds. Anything longer gets the 3·2·1 warning and the overlay. */
const QUICK_MAX_MS = 4000;
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
  return r.order_restored === false ? `⚠ window put back, but the z-order differs from before (${r.restored})` : /^nothing to do/.test(String(r.restored)) ? "" : `window put back (${r.restored})`;
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
    let pressNote = "", ownedScroll = false;
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
      // Esc ×6: the user has their machine back. The helper refuses too (and lets go of what it held); this is the
      // same check for the steps that send nothing, so a long wait does not run on.
      if (drive?.taken) {
        if (heldButton) { await actorSend({ op: "up", button: heldButton }); heldButton = null; }
        stopped = `${tag}: NOT SENT — the user took their input back (Esc ×6). Steps #${i}…#${p.steps.length - 1} were not run (${p.steps.length - i} of ${p.steps.length})`;
        break;
      }
      if (s.guard && !evalExpr(s.guard, scope(readNow(), ptr, hover))) { stopped = `${tag}: guard failed: ${s.guard}`; break; }
      if (s.op === "wait") { await sleep(s.ms ?? 300); await look(); }
      else if (s.op === "wait_until" || s.op === "assert") {
        if (!s.expr && !s.js) { stopped = `${tag}: needs expr (or js, in a website session)`; break; }
        if (s.js && !pageOpen()) { stopped = `${tag}: js needs a website session (eye_drive {url})`; break; }
        const needsHover = !!s.expr && /\bh\b/.test(s.expr);
        const end = Date.now() + (s.op === "assert" ? 0 : s.timeout_ms ?? 2000);
        let why = "";
        const holds = async () => {
          if (s.expr && !evalExpr(s.expr, scope(readNow(), ptr, hover))) return false;
          if (!s.js) return true;
          const r = await pageTool({ op: "js", js: s.js, timeout_ms: 1000 });
          why = r.ok ? ` (it was ${r.note})` : ` (${r.error})`;
          return r.ok && !!r.value;
        };
        let ok = await holds();
        while (!ok && Date.now() < end) {
          await sleep(s.js ? 50 : needsHover ? 60 : 25);
          if (needsHover) await look();
          ok = await holds();
        }
        const what = [s.expr, s.js && `page: ${s.js}`].filter(Boolean).join(" && ");
        if (!ok) { lines.push(`${stamp()} ${tag} ✗ ${what}${why} · ${short(readNow())}${over()}`); stopped = `${tag}: not satisfied: ${what}${why}`; break; }
      } else if (["type", "key", "goto", "reload"].includes(s.op)) {
        // Straight into the page through the browser: no pointer, no focus fight with other apps.
        if (!pageOpen()) { stopped = `${tag}: ${s.op} needs a website session (eye_drive {url})`; break; }
        const r = await pageTool(s);
        if (!r.ok) { stopped = `${tag}: ${r.error}`; break; }
        pressNote = ` · ${r.note}`;
      } else {
        if (s.op === "scroll" && s.force !== true) {
          const live = readNow(), a = live?.anchored_screen;
          const inA = a && ptr.x > a.x0 + 10 && ptr.x < a.x1 - 10 && ptr.y < (a.y0 ?? 0) + a.h - 5;
          const inZone = (p.scroll_zones ?? []).some((z: Rect) => ptr.x >= z.x && ptr.x <= z.x + z.w && ptr.y >= z.y && ptr.y <= z.y + z.h);
          // Outside both: a session on an app may still scroll where that app owns the window or the element under
          // the pointer (its closed notch pill, its ordinary window); the actor checks that right before posting.
          if (!inA && !inZone) {
            if (!target) { stopped = `${tag}: REFUSED scroll at ${ptr.x.toFixed(0)},${ptr.y.toFixed(0)} — not inside the open area or a scroll_zone, and this session has no app to check the place against`; break; }
            ownedScroll = true;
          }
        }
        const { guard, force, note, expr, timeout_ms, on, text, key, url, js, ...cmd } = s as any;
        if (ownedScroll) { cmd.require_pid = target!.pid; ownedScroll = false; }
        // Aim at a probe layer: its centre, read from the live probe data right now.
        let aimed: number[] | null = null;
        if (on !== undefined && pageOpen()) {
          // In a page the thing is found in the document as it is now: waited for until it is there, at rest and uncovered.
          const hit = await pageFind({ q: String(on), timeout_ms: s.timeout_ms });
          if (!hit.ok) { stopped = `${tag}: ${hit.error}`; break; }
          aimed = hit.rect;
          cmd.x = hit.x; cmd.y = hit.y;
          pressNote = ` · ${hit.label}`;
        } else if (on !== undefined) {
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
  /** scroll_zones, kept from the call that gave them to the end of the session. */
  zones?: Rect[];
  lock?: Lock; raised?: any; idle?: NodeJS.Timeout; idleS: number; holdMs?: number; taken?: boolean; busy?: boolean; calls: number; evAt: number; what: string;
  /** The probe recording started inside the app when the session opened. */
  probe?: string;
  /** A website: the eye's own browser (target), the page probe in its tab (web.ts). */
  web?: boolean;
  /** A session opened on a rect: the room the hand may move in, global points (else the window, read afresh each call). */
  room?: number[];
  /** Hand frames back with the replies (the settled one after each call; at the end, one per defect). */
  frames: boolean;
  /** `seconds` / `command`: the opening call waits for the recording to end and returns its report. */
  block: boolean;
  /** The hand's two-finger touches so far: [recording seconds, x, y, touch number], on the trackpad from where each landed, y down. */
  hand: number[][];
  /** The recording's clock at the last reply that left fingers down (else 0): what they kept doing since then is shown with the next one. */
  seenTo: number;
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
/** What the hand's fingers drew since its last reply: kept for the film strip, and in hand.jsonl for the session's report. */
function keepTouch(d: Drive, r: any) {
  if (!r?.ftrace?.length) return;
  const t0 = Number(readLive(d.job.capture)?.t0_mach ?? 0);
  if (!t0) return;
  // The hand reports wheel pixels; with Natural scrolling off the fingers went the other way.
  const sg = r.natural === false ? -1 : 1, r3 = (v: number) => Math.round(v * 1000) / 1000;
  const rows = (r.ftrace as number[][]).map(([t, x, y, n]) => [r3(t - t0), r3(x * sg), r3(y * sg), n]);
  d.hand.push(...rows);
  if (d.hand.length > 40_000) d.hand.splice(0, d.hand.length - 40_000);
  try { appendFileSync(join(d.job.capture.dir, "hand.jsonl"), rows.map((x) => JSON.stringify(x)).join("\n") + "\n"); } catch { /* run dir gone */ }
}
/** The plots the playing fingers made since the last reply, in order, and what they noticed: where to look in the film strip. */
function plotsText(d: Drive, r: any): string[] {
  const P = (r?.plots ?? []) as any[];
  if (!P.length) return [];
  const t0 = Number(readLive(d.job.capture)?.t0_mach ?? 0);
  const at = (x: number, y: number) => fingersAt({ fpos: [x, y], natural: r.natural });
  const strokes = P.filter((p) => p.k !== "pop"), L: string[] = [];
  if (strokes.length) {
    // Strokes of one kind in a row are one run; a stillness (held, or lifted to watch) says how long it lasted.
    const runs: { k: string; n: number; a: number; b: number; t: number; still?: number }[] = [];
    strokes.forEach((s, i) => {
      const u = runs[runs.length - 1];
      if (s.dx === undefined) { runs.push({ k: s.k, n: 1, a: 0, b: 0, t: s.t - t0, still: strokes[i + 1] ? strokes[i + 1].t - s.t : undefined }); return; }
      const len = Math.hypot(s.dx, s.dy);
      if (u && u.k === s.k && u.still === undefined) { u.n++; u.b = len; } else runs.push({ k: s.k, n: 1, a: len, b: len, t: s.t - t0 });
    });
    const shown = runs.slice(-12);
    L.push(`what they did${r.playing ? ` (playing ${r.playing})` : ""}: ${strokes.filter((x) => x.dx !== undefined).length} strokes${runs.length > shown.length ? `, the last ${shown.length} runs` : ""} — `
      + shown.map((u) => u.k === "lift" ? `${u.t.toFixed(1)}s LIFT` : u.k === "fling" ? `${u.t.toFixed(1)}s THROWN` : u.a === 0 ? `${u.t.toFixed(1)}s ${u.k === "watch" ? "up, watching" : "STILL"}${u.still !== undefined ? ` ${u.still.toFixed(1)}s` : " (still so now)"}` : `${u.t.toFixed(1)}s ${u.k}${u.n > 1 ? ` ×${u.n}` : ""} ${u.a.toFixed(0)}${u.n > 1 && Math.abs(u.b - u.a) > 4 ? `→${u.b.toFixed(0)}` : ""}pt`).join(" · ")
      + ` (pull = one slow stroke to see what the thing does · further = on while it grows · wave = there and back, swelling, and on while it gives more · shake = the same, large · slide = slowly across · far = further than it has been · flick then THROWN = a fast stroke let go at its fastest, so it coasts · cross = slowly back over a pop · STILL = a beat held where they are · LIFT then up, watching = let go to see what it does by itself)`);
    const best = strokes.reduce((a, b) => (Number(b.per ?? 0) > Number(a.per ?? 0) ? b : a));
    if (Number(best.per) > 0) L.push(`the screen gave most around ${(best.t - t0).toFixed(1)}s, with the fingers ${at(best.x, best.y)} where they landed`);
  }
  for (const p of P.filter((x) => x.k === "pop")) L.push(`POP at ${(p.t - t0).toFixed(2)}s: ${Number(p.w).toFixed(0)}×${Number(p.h).toFixed(0)}pt jumped at once while the fingers did nothing new, ${at(p.x, p.y)} where they landed${r.playing ? "; they went slowly back over that place" : ""}`);
  return L;
}
/** The fingers' samples of the touch that was down at `t` (recording seconds); [] when none was. */
function touchAt(d: Drive, t: number): number[][] {
  let n = -1, seen = -Infinity;
  for (const s of d.hand) { if (s[0] > t + 0.03) break; n = s[3]; seen = s[0]; }
  return n < 0 || t - seen > 0.3 ? [] : d.hand.filter((s) => s[3] === n);
}
/**
 * A film strip: the frames the recording kept between two moments, side by side, and in the corner of each the
 * trackpad as it was then (the whole touch grey, its last 0.2s yellow, the fingers red, where they landed cyan).
 * One picture says what the thing under the fingers did while they moved, without waiting for anything to stop.
 */
async function filmStrip(d: Drive, from: number, mid: number, to: number): Promise<{ image: any; n: number; before: number; t0: number; t1: number; crop: string } | null> {
  const cap = d.job.capture, dir = join(cap.dir, "keyframes");
  let keys: { f: string; t: number }[];
  // Not the newest 50ms: that frame may still be on its way to disk.
  try { keys = readdirSync(dir).filter((f) => f.endsWith(".png")).map((f) => ({ f, t: Number(f.replace(/^frame_|ms\.png$/g, "")) / 1000 })).filter((k) => k.t >= from - 0.02 && k.t <= to - 0.05).sort((a, b) => a.t - b.t); } catch { return null; }
  if (!keys.length) return null;
  // Evenly through each part, its last frame always among them: at most a row (3) from before this call, while the
  // fingers kept going and nobody steered, and three rows (9) from the call itself.
  const take = (ks: typeof keys, max: number) => { const n = Math.min(max, ks.length); return [...new Set(Array.from({ length: n }, (_, i) => ks[n === 1 ? ks.length - 1 : Math.round((i * (ks.length - 1)) / (n - 1))]))]; };
  const earlier = take(keys.filter((x) => x.t < mid - 0.02), 3);
  const pick = [...earlier, ...take(keys.filter((x) => x.t >= mid - 0.02), 9)];
  const cols = Math.min(3, pick.length), rowsN = Math.ceil(pick.length / cols), G = 3;
  // Every frame cut to the part of the region where something moved in this time (with a margin, and never smaller
  // than 200×120pt): the thing fills the tile however large the window around it is.
  const R = d.job.rect;
  let c = { x: 0, y: 0, w: R.w, h: R.h }, crop = "";
  try {
    const mv = loadRun(cap.csv).rows.filter((r) => r.t >= from && r.t <= to && r.mx1 > r.mx0 && r.my1 > r.my0);
    if (mv.length) {
      const x0 = Math.min(...mv.map((r) => r.mx0)), x1 = Math.max(...mv.map((r) => r.mx1)), y0 = Math.min(...mv.map((r) => r.my0)), y1 = Math.max(...mv.map((r) => r.my1));
      const w = Math.min(R.w, Math.max(200, x1 - x0 + 32)), h = Math.min(R.h, Math.max(120, y1 - y0 + 32));
      c = { x: Math.max(0, Math.min(R.w - w, (x0 + x1) / 2 - w / 2)), y: Math.max(0, Math.min(R.h - h, (y0 + y1) / 2 - h / 2)), w, h };
      if (c.w < R.w - 1 || c.h < R.h - 1) crop = `x ${(R.x + c.x).toFixed(0)}…${(R.x + c.x + c.w).toFixed(0)}, y ${(R.y + c.y).toFixed(0)}…${(R.y + c.y + c.h).toFixed(0)}`;
    }
  } catch { /* the whole region */ }
  // Each frame with the trackpad beside it, not over it: nothing of the picture is hidden.
  const IB = 86, k = Math.min(432 / c.w, 300 / c.h), TW = Math.round(c.w * k), TH = Math.round(c.h * k);
  const CW = TW + 2 + IB, CH = Math.max(TH, IB), items: any[] = [];
  pick.forEach((key, i) => {
    const x = (i % cols) * (CW + G), y = Math.floor(i / cols) * (CH + G);
    items.push({ png: join(dir, key.f), srcf: [c.x / R.w, c.y / R.h, c.w / R.w, c.h / R.h], dst: [x, y, TW, TH] }, { text: `${key.t.toFixed(2)}s`, at: [x + 4, y + 3], size: 12, ...(i < earlier.length ? { color: [185, 185, 185] } : {}) });
    const pts = touchAt(d, key.t);
    if (!pts.length) return;
    const bx = x + TW + 2, by = y;
    const xs = pts.map((p) => p[1]).concat(0), ys = pts.map((p) => p[2]).concat(0);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const sc = (IB - 12) / Math.max(60, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const at = (p: number[]) => [Math.round((bx + IB / 2 + (p[1] - cx) * sc) * 10) / 10, Math.round((by + IB / 2 + (p[2] - cy) * sc) * 10) / 10];
    const every = Math.max(1, Math.ceil(pts.length / 400));
    const upTo = pts.filter((p) => p[0] <= key.t + 0.01), nowAt = upTo[upTo.length - 1] ?? pts[0];
    const tail = upTo.filter((p) => p[0] >= key.t - 0.2);
    items.push({ rect: [bx, by, IB, IB], fill: [0, 0, 0], stroke: [90, 90, 90] },
      { line: pts.filter((_, j) => j % every === 0).map(at), width: 1, color: [150, 150, 150] },
      ...(tail.length > 1 ? [{ line: tail.map(at), width: 3, color: [255, 225, 40] }] : []),
      { dot: at([0, 0, 0]), r: 4, color: [60, 220, 255] }, { dot: at([0, 0, 0]), r: 2.2, color: [0, 0, 0] },
      { dot: at(nowAt), r: 3.5, color: [255, 60, 60] });
  });
  const stamp = Date.now(), spec = join(cap.dir, `strip_${stamp}.json`), outFile = join(cap.dir, `strip_${stamp}.jpg`);
  try {
    writeFileSync(spec, JSON.stringify({ out: outFile, w: cols * CW + (cols - 1) * G, h: rowsN * CH + (rowsN - 1) * G, bg: [18, 18, 18], items }));
    const r = await run(BIN, ["draw", "--spec", spec], 6000);
    rmSync(spec, { force: true });
    if (r.code !== 0 || !existsSync(outFile)) return null;
    return { image: { type: "image", data: readFileSync(outFile).toString("base64"), mimeType: "image/jpeg" }, n: pick.length, before: earlier.length, t0: pick[0].t, t1: pick[pick.length - 1].t, crop };
  } catch { return null; }
}
/**
 * How far the thing went between two moments of the recording, with the time of each extreme so it can be found in
 * the film strip: what hangs from the top edge when the recording measures that, else the box of what moved.
 */
function reachLine(j: Job, from: number, to: number): string {
  try {
    const rs = loadRun(j.capture.csv).rows.filter((r) => r.t >= from && r.t <= to && r.s === "c");
    const secs = (to - from).toFixed(1), at = (r: Row) => `${r.t.toFixed(2)}s`;
    const most = (v: Row[], f: (r: Row) => number) => v.reduce((m, r) => (f(r) > f(m) ? r : m));
    const an = rs.filter((r) => r.ah > 0), mv = rs.filter((r) => r.mx1 > r.mx0 && r.my1 > r.my0);
    if (an.length) {
      const z = an[an.length - 1], tall = most(an, (r) => r.ah), wide = most(an, (r) => r.aw), small = most(an, (r) => -r.ah);
      return `what hangs from the top edge is ${z.aw.toFixed(0)}×${z.ah.toFixed(0)}pt now; in these ${secs}s: tallest ${tall.ah.toFixed(0)}pt (${at(tall)}), shortest ${small.ah.toFixed(0)}pt (${at(small)}), widest ${wide.aw.toFixed(0)}pt (${at(wide)})`;
    }
    if (!mv.length) return `nothing on screen moved in these ${secs}s`;
    const z = mv[mv.length - 1], big = most(mv, (r) => (r.mx1 - r.mx0) * (r.my1 - r.my0));
    const low = most(mv, (r) => r.my1), left = most(mv, (r) => -r.mx0), right = most(mv, (r) => r.mx1);
    return `what moved on screen in these ${secs}s: ${(big.mx1 - big.mx0).toFixed(0)}×${(big.my1 - big.my0).toFixed(0)}pt at its largest (${at(big)}), down to y=${(low.my1 + j.rect.y).toFixed(0)} (${at(low)}), left to x=${(left.mx0 + j.rect.x).toFixed(0)} (${at(left)}), right to x=${(right.mx1 + j.rect.x).toFixed(0)} (${at(right)}); ${(z.mx1 - z.mx0).toFixed(0)}×${(z.my1 - z.my0).toFixed(0)}pt in the last frame that moved`;
  } catch { return ""; }
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
    keepTouch(d, r);
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
  const probe = d.probe ? await stopProbes(runDir, d.probe, { capture_csv: cap.csv, top: 5, brief: true }).catch((e) => [`probe: ${e.message}`]) : [];
  const pageProbe = d.web && pageActive() ? await stopPageProbe(runDir, { capture_csv: cap.csv, top: 5 }).catch((e) => `page probe: ${e.message}`) : "";
  if (d.web) closePage();
  let looked = "", what: Seen | undefined;
  try {
    const { rows, meta } = loadRun(cap.csv);
    what = notice(rows, meta, analyze(rows, meta, d.job.opts), { ...d.job.opts, dir: cap.dir });
    looked = formatSeen(what);
  } catch (e: any) { looked = `could not analyze: ${e.message}`; }
  if (d.frames && what) imgs.push(...await defectFrames(cap.csv, what));
  let quitLine = "";
  if (quitToo && d.web) quitLine = await quitBrowser();
  else if (quitToo && d.target) {
    const left = await quitPids([d.target.pid]);
    quitLine = left.length ? notQuit(left) : `quit ${d.target.name} (pid ${d.target.pid})`;
  }
  endFrames = imgs;
  const secs = ((Date.now() - d.job.started) / 1000).toFixed(1);
  return [
    d.hands
      ? `SESSION ENDED (${why}): ${d.calls} call${d.calls === 1 ? "" : "s"}, ${secs}s · hand at rest at (${Number(r.x ?? 0).toFixed(0)},${Number(r.y ?? 0).toFixed(0)})${back ? ` · ${back}` : ""}${freed ? " · input is the user's again" : ""}`
      : `SESSION ENDED (${why}), ${secs}s watched${back ? ` · ${back}` : ""}.`,
    d.hands ? `WHAT IT LOOKED LIKE (whole session, recording clock):\n${looked}` : `WHAT IT LOOKED LIKE — ${d.what}:\n${final}`,
    ...probe.map((x) => `FROM INSIDE THE APP (eye_report {view:"probe", file} for every layer and stack):\n${x}`),
    pageProbe ? `FROM INSIDE THE PAGE (the page probe: every animation frame, the page's own CSS / Web Animations, long frames with their scripts; eye_report {view:"probe", file} for every element):\n${pageProbe}` : "",
    ...touchesText(cap.dir),
    ...handTouchesText(cap.dir),
    d.hands ? `run: ${cap.dir} · eye_report {view:"explain"}: the worst frames with pointer, step and main thread` : "",
    quitLine,
  ].filter(Boolean).join("\n");
}

const pt = (x: number, y: number) => `(${x.toFixed(0)},${y.toFixed(0)})`;
function compassOf(vx: number, vy: number) {
  return ["E", "SE", "S", "SW", "W", "NW", "N", "NE"][((Math.round(Math.atan2(vy, vx) / (Math.PI / 4)) % 8) + 8) % 8];
}
/** Where the fingers are from where they landed, in words (the hand reports wheel pixels: the other way round without Natural scrolling). */
function fingersAt(r: any): string {
  const sg = r.natural === false ? -1 : 1, x = Number(r.fpos?.[0] ?? 0) * sg, y = Number(r.fpos?.[1] ?? 0) * sg;
  const w = [Math.abs(y) >= 2 ? `${Math.abs(y).toFixed(0)}pt ${y > 0 ? "below" : "above"}` : "", Math.abs(x) >= 2 ? `${Math.abs(x).toFixed(0)}pt ${x > 0 ? "right of" : "left of"}` : ""].filter(Boolean);
  return w.length === 2 ? `${w[0]} and ${w[1]}` : w[0] ?? "back";
}
/** What one wing did, as the hand lived it: every element it passed over, each press where it happened, where it is now. */
function wingText(words: string[], r: any, brief = false): string[] {
  const L: string[] = [];
  const secs = (Number(r.ms) / 1000).toFixed(2);
  L.push(r.stopped
    ? `WING STOPPED at move ${r.done + 1} of ${r.of}${words[r.done] ? ` (${words[r.done]})` : ""}: ${r.stopped}. ${r.done ? `The ${r.done} before it ${r.done === 1 ? "was" : "were"} flown` : "Nothing was flown"}${r.of - r.done - 1 > 0 ? `; the ${r.of - r.done - 1} after it ${r.of - r.done - 1 === 1 ? "was" : "were"} not` : ""}.`
    : `wing flown whole: ${r.of} move${r.of === 1 ? "" : "s"}, ${secs}s`);
  const rows: { t: number; s: string }[] = [];
  for (const s of brief || r.path_pt < 1 ? [] : r.trail ?? []) {
    const still = Math.hypot(s.x1 - s.x0, s.y1 - s.y0) < 1;
    rows.push({ t: s.t, s: `${still ? `at ${pt(s.x0, s.y0)}` : `${pt(s.x0, s.y0)}→${pt(s.x1, s.y1)}`}  ${s.label}${fr(s.frame ?? undefined)}${s.ms >= 1 ? `  ${Number(s.ms).toFixed(0)}ms` : ""}` });
  }
  const shownRows = rows.length > 44 ? [...rows.slice(0, 22), { t: rows[22].t, s: `… ${rows.length - 44} more elements crossed …` }, ...rows.slice(-22)] : rows;
  for (const m of r.marks ?? []) {
    if (brief && m.k === "scroll") continue;
    shownRows.push({ t: m.t, s: m.k === "note" ? `· ${m.what}` : `● ${m.k === "scroll" ? words[m.i] ?? "scroll" : m.k} at ${pt(m.x, m.y)} on ${m.what}` });
  }
  shownRows.sort((a, b) => a.t - b.t);
  if (brief && shownRows.length) L.push(`  ${shownRows.map((x) => x.s.replace(/^● (\S+) at /, "$1 ").replace(/ on /, " ").replace(/ in Application ".*"$/, "")).join(" · ")}`);
  else if (shownRows.length) {
    L.push(`${r.path_pt < 1 ? "the pointer stayed where it was" : "what the hand passed over"} (${r.path_pt < 1 ? "what was done there" : `${Number(r.path_pt).toFixed(0)}pt travelled, felt every ${(Number(r.path_pt) / Math.max(1, r.samples)).toFixed(1)}pt`}${r.trail_dropped ? `, ${r.trail_dropped} oldest stretches dropped` : ""}):`);
    for (const x of shownRows) L.push(`  ${x.t >= r.t0 ? "+" : "−"}${Math.abs(x.t - r.t0).toFixed(2)}s  ${x.s}`);
  }
  const held = (r.held?.length ? `, HOLDING the ${r.held.join(" and ")} button` : "")
    + (r.fingers && r.lifted ? `, the two fingers are OFF the trackpad for a moment, ${r.doing ?? "watching"}. They play on while you think and stop by themselves ${(Number(r.hold_ms) / 1000).toFixed(0)}s from now (hold_ms): a stroke you write lands them again and they play on from it, fingers calm or lift ends the play`
    : r.fingers ? `, TWO FINGERS DOWN on the trackpad for ${Number(r.touch_s ?? 0).toFixed(1)}s, ${fingersAt(r)} where they landed, ${r.doing ?? "holding still"}. They go on like that while you think and lift by themselves ${(Number(r.hold_ms) / 1000).toFixed(0)}s from now (hold_ms): any fingers word carries this same touch on without a seam, lift ends it` : "");
  if (r.flying) {
    L.push(`now: still flying ${compassOf(r.course[0], r.course[1])} at ${Number(r.pace).toFixed(0)}pt/s, at ${pt(r.x, r.y)} over ${r.over}${held}. It goes on while you choose the next wing and brakes by itself after ${(Number(r.coast_ms) / 1000).toFixed(1)}s.`);
    if (r.ahead?.length) L.push(`ahead on this line: ${r.ahead.map((a: any) => `${a.label} in ${Number(a.in_pt).toFixed(0)}pt (${(Number(a.in_ms) / 1000).toFixed(2)}s)`).join(" · ")}`);
  } else L.push(`now: at rest at ${pt(r.x, r.y)} on ${r.over}${fr(r.over_frame ?? undefined)}${held}${r.edge ? " — it ran into the window's edge and stopped there" : ""}`);
  if (r.capped) L.push(`the fingers kept going for ${Number(r.capped).toFixed(0)}pt and were stopped there (no trackpad is that long)${r.fingers ? "; they are still down" : ""}`);
  if (r.in_sight) L.push(`in sight instead: ${r.in_sight.join(" · ") || "nothing that can be pressed"}`);
  return L;
}

/** A wait written between two moves of a wing: fingers left on the trackpad must outlast it. */
const holdFor = (step: any): number => (step?.op === "wait_until" ? (step.timeout_ms ?? 2000) + 300 : step?.op === "assert" ? 300 : 0);
const stepsMs = (steps: any[] = []) => steps.reduce((t, s) => t + (s.ms ?? 0) + (s.timeout_ms ?? (s.op === "wait_until" ? 2000 : 0)) + (s.hold_ms ?? 0) + 400, 0);

/** Open the session: the app (started if asked), the probe inside it, the recording, the lock. "" = open; else why not. */
async function openDrive(p: any, out: string[]): Promise<string> {
  // Who drives decides the lock: the-eye's hand, or the caller's own driver (hands:"mine", a command) = locked. Only a
  // watch of the user (hands:false) leaves their input alone. There is no switch for it.
  const watchOnly = p.hands === false || p.hands === "mine" || !!p.command || !!p.seconds;
  const ownDriver = p.hands === "mine" || !!p.command;
  let ref: string | number | undefined = p.app ?? (p.app_path ? basename(p.app_path).replace(/\.app\/?$/, "") : undefined);
  let target: { pid: number; name: string } | undefined;
  let launched = false, web = false, gpuPid: number | undefined;
  if (p.url !== undefined) {
    if (ref !== undefined) return "url and app are two kinds of session: a website (url) opens in the eye's own browser, an app (app) is the app; pass one";
    const o = await openPage({ url: p.url, viewport: p.viewport, reload: p.reload, browser: p.browser });
    if (!o.ok) return o.error;
    target = { pid: o.pid, name: o.name }; web = true; gpuPid = o.gpuPid; launched = o.launched;
    out.push(`${o.launched ? "started" : "using"} the eye's own ${o.name} (pid ${o.pid}) on ${p.url}${o.note ? ` · ${o.note}` : ""}`);
  }
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
  if (web) {
    if (p.probe !== false) {
      const o = p.probe && typeof p.probe === "object" ? p.probe : {};
      const r = await startPageProbe({ label: `${p.label ?? "page"}_probe`, watch: o.watch });
      out.push(r.ok ? r.note : `no page probe: ${r.why}. The session goes on without it: freezes are still found, but the script that blocked is not named.`);
    }
  } else if (target && p.probe !== false) {
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
    if (!w.ok) { await dropProbe(probeId); if (web) closePage(); return unseen(w.error); }
    rect = w.rect; display ??= w.display;
    if (p.isolate !== false) only = target!.pid;
    what = `${target!.name} ${w.what}${only ? ", its own windows only" : w.on_top ? "" : " (not the front window: what covers it is recorded too)"}`;
  }
  const idleS = p.idle_s ?? 30;
  const common = { rect, display, only_pid: only, events_pid: target?.pid, under_pid: gpuPid, events: p.events, root: p.root,
    keyframe_ms: p.keyframe_ms ?? (watchOnly ? 200 : 100), keyframe_max: 1200, fps: p.fps, profile: p.profile === true ? (target ? { process: String(target.pid) } : undefined) : p.profile || undefined,
    motion_threshold: p.motion_threshold, split_gap_ms: p.split_gap_ms, refresh_hz: p.refresh_hz };
  const job = watchOnly
    ? startJob({ ...common, label: p.label ?? (target ? target.name : "watch"), ax: p.ax ?? false, ax_hz: p.ax_hz, tree: p.tree ?? "none",
        process: target ? String(target.pid) : undefined, cursor: p.cursor, command: p.command, cwd: p.cwd, lock_input: ownDriver,
        pre_ms: p.pre_ms, post_ms: p.post_ms, timeout_s: p.timeout_s, seconds: p.seconds, max_seconds: p.max_seconds })
    : startJob({ ...common, label: p.label ?? "drive", ax: false, tree: "none", max_seconds: p.max_seconds ?? 600 });
  const block = watchOnly && !!(p.command || p.seconds);
  for (let i = 0; i < 600 && job.state === "starting"; i++) await sleep(50);
  if (job.state === "done" && /^capture failed/.test(job.final ?? "")) { await dropProbe(probeId); if (web) closePage(); return unseen(job.final!); }
  if (!block) {
    for (let i = 0; i < 20 && job.state === "running" && blind(readLive(job.capture)); i++) await sleep(50);
    const dark = job.state === "running" ? blind(readLive(job.capture)) : `the capture did not start (${String(job.final ?? "no answer from ScreenCaptureKit in 30s").slice(0, 300)})`;
    if (dark) { job.stopped ??= "not seeing"; job.stopNow(); await dropProbe(probeId); if (web) closePage(); return unseen(`could not watch ${target?.name ?? "the region"} — ${dark}`); }
  }
  let lock: Lock | undefined;
  if (!watchOnly && !(await coveringLock((idleS + 30) * 1000))) {
    // "Just a sec…" (no countdown) only for one call that opens, acts for under four seconds and ends. Everything
    // else warns with 3·2·1, lock_style:"quick" or not: a pill is no warning for a hold the user will notice.
    const w = p.wing?.trim() ? parseWing(p.wing) : undefined;
    const actMs = stepsMs(p.steps) + (!w ? 0 : "error" in w ? Infinity : wingMs(w.moves));
    const short1 = !!p.end && actMs < QUICK_MAX_MS;
    lock = (await holdLock(() => startLock(idleS + 30, "tagged", short1 && p.lock_style !== "full" ? "quick" : "full")))!;
    if (lock.waited) out.push(lock.waited);
  }
  drive = { job, target, window: p.window, hands: !watchOnly, lock, idleS, calls: 0, evAt: 0, what, probe: probeId, web, room, frames: p.frames !== false, block, hand: [], seenTo: 0 };
  // A hand needs the window in front: it presses only what is in sight. Put back when the session ends.
  if (target && (p.front ?? !watchOnly)) {
    const up = await raiseWindow(target.pid, p.window);
    if (!up.ok) return `${await endDrive("could not bring the window forward")}\nfront: ${up.error}`;
    drive.raised = up;
    if (!up.already_front) out.push(`brought ${fmtWin(up)} forward${up.was_minimized ? " (it was minimized)" : ""}; it goes back where it was when the session ends`);
    await sleep(150);
  }
  if (!watchOnly) {
    out.push(`session open on ${what}${lock ? ` · the user's input is held (${lock.id})` : " · the user's input is held by a lock already running"} · recording ${job.id} → ${job.capture.dir}`);
    if (!p.end) p.look ??= true;
    if (web) out.push("a website: aim with on:\"selector or name\" (steps) or el:\"…\" (wing) — found in the page, waited for until visible, enabled, uncovered and at rest; type / key / goto / reload go straight into the page; wait_until {js} checks the page itself; every reply says what the page logged, threw or failed to load");
  } else if (block) {
    out.push(job.startNote ?? "", ...(await observedConflicts(job, rect)));
  } else {
    out.push(
      `watching ${what} · no hand: ${ownDriver ? "the user's input is held for your own driver" : "input stays the user's"} · recording ${job.id} → ${job.capture.dir}`,
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

/** probe as some clients send it: "true" / "false", or the object as a JSON string. Anything else is left for the schema to judge. */
function looseProbe(v: unknown) {
  if (typeof v !== "string" || v === "xcode") return v;
  const t = v.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t.startsWith("{")) { try { return JSON.parse(t); } catch { return v; } }
  return v;
}
server.registerTool("eye_drive", {
  title: "Drive an app and see what it looked like: one session, a hand or just eyes",
  // The outline: every word, step and option is spelled out in the manual (skills/the-eye/, served by `guide`).
  description: [
    "ONE SESSION on an app or a website: its window recorded, the user's input held, a hand on the mouse and (in Debug builds) a probe inside the app. The first call opens it (app, app_path or url), every call may move, end:true closes it and returns WHAT IT LOOKED LIKE for the whole of it.",
    "One call that does everything: eye_drive {app, wing or steps, end:true}.",
    "TWO WAYS TO MOVE, mixed freely.",
    `wing: a line of words flown as ONE unbroken motion, things by the name accessibility gives them: wing:'"7" tap "Add" tap "3" tap "Equals" tap settle' · wing:'"Volume" down E 80 rest 200 W 30 up' (a drag). Words: ${WING_WORDS}.`,
    "steps: exact and repeatable to the millisecond, for measuring and A/B: move, click, down/up, scroll, pinch, rotate, smart_zoom, swipe, press, force_click, wait, wait_until, assert.",
    "The hand presses only what is in sight and under it; nothing is sent to a window that cannot be seen.",
    "EVERY REPLY ends with the screen (moving / still), what a viewer noticed during this call, what the app told accessibility, and the frame it settled on.",
    "ONLY WATCH: hands:false = the USER drives and keeps their input, until end:true or for `seconds`; `command` runs your own driver, watched, with input held.",
    `THE MANUAL: guide:"wing" (or ${CHAPTERS.slice(1).join(", ")}) returns that chapter and does nothing else. Read wing, fingers, steps or web before the first use of each; a wing that cannot be read is not flown and comes back with its chapter.`,
  ].join(" "),
  inputSchema: {
    guide: z.enum(["overview", ...CHAPTERS]).optional().describe("Return this chapter of the manual and do nothing else: no session, no lock, no queue."),
    wing: z.string().optional().describe("The motion, as words: one unbroken flight (guide:\"wing\"; two fingers on the trackpad: guide:\"fingers\")."),
    steps: z.array(stepSchema).max(60).optional().describe("Exact steps (guide:\"steps\"). Run after `wing` when both are given."),
    app: z.union([z.string(), z.number()]).optional().describe("The app (name or pid). Needed on the call that opens the session; the session keeps it."),
    url: z.string().optional().describe("A WEBSITE instead of an app, in the eye's own Chromium-family browser: localhost:3000, a file path or any URL (guide:\"web\")."),
    viewport: z.object({ w: z.number().int().min(200).max(8000), h: z.number().int().min(150).max(8000) }).optional().describe("url: the page's viewport in CSS px."),
    reload: z.boolean().optional().describe("url: load it afresh."),
    browser: z.string().optional().describe("url: \"chrome\", \"chromium\", \"brave\", \"edge\" or a path to the .app."),
    app_path: z.string().optional().describe("The .app to start when no copy of it runs, e.g. the build you just made."),
    window: z.string().optional().describe("Which of the app's windows (title substring). Default its main window."),
    rect: rectSchema.optional().describe("Watch this display-local region instead of the app's window."),
    display: z.number().int().optional().describe("Display of `rect` (default main)."),
    hands: z.union([z.boolean(), z.literal("mine")]).optional().describe("Who moves things, which also decides the lock. true (default): the-eye's hand, the user's input held. \"mine\": your own driver, input held. false: the USER moves them, input stays theirs."),
    seconds: z.number().positive().max(600).optional().describe("Only watch, for this long, then return the report (implies hands:false)."),
    command: z.string().optional().describe("Only watch while this shell command (your driver) runs, with input held, then return its output and the report."),
    cwd: z.string().optional(),
    pre_ms: z.number().optional().describe("command: record this long before it (default 500)."),
    post_ms: z.number().optional().describe("command: and after it (default 1000)."),
    timeout_s: z.number().positive().max(600).optional().describe("command: kill it after this (default 300)."),
    max_seconds: z.number().positive().max(600).optional().describe("The recording stops by itself after this (default 600 with a hand, 300 watching)."),
    end: z.boolean().optional().describe("End the session after this call: let go, free the user's input, report what the whole of it looked like."),
    quit: z.boolean().optional().describe("Quit the app: with end, after the report; alone with `app`, right away. The user is asked first when the copy may be theirs."),
    ask: z.string().min(1).max(QUESTION_MAX).optional().describe(`Put a yes/no to the person at the machine before something they may mind (at most ${QUESTION_MAX} characters; unanswered after ${ASK_SECONDS}s = yes). Returns the answer; nothing else in the call is done.`),
    probe: z.preprocess(looseProbe, z.union([z.boolean(), z.literal("xcode"), z.object({
      match: z.array(z.string()).optional(), watch: z.array(z.string()).optional(),
      full_walk: z.boolean().optional(), max_layers: z.number().int().positive().optional(),
    })]).optional()).describe("The probe inside the app goes in by itself. false = don't try (cleanest fps) · true = try again · {match, watch} = choose layers · \"xcode\" = the app runs under Xcode's debugger (guide:\"measure\")."),
    look: z.boolean().optional().describe("Also show the app's element tree as it is now (shown by itself when a session with a hand opens)."),
    frames: z.boolean().optional().describe("false = no images in the replies."),
    speed: z.number().min(20).max(4000).optional().describe("wing: pace in points per second (default 700)."),
    coast_ms: z.number().min(0).max(10000).optional().describe("wing: how long a hand left flying keeps going after the reply (default 1500)."),
    hold_ms: z.number().min(0).max(60000).optional().describe("wing: how long two fingers left down stay down after the reply (default 20000)."),
    brief: z.boolean().optional().describe("The short reply (default while two fingers are down)."),
    scroll_zones: z.array(rectSchema).optional().describe("steps: extra screen rects where scrolling is allowed. Kept for the session."),
    idle_s: z.number().min(3).max(300).optional().describe("A session with a hand ends by itself after this long without a call (default 30)."),
    front: z.boolean().optional().describe("false = do not bring the window forward (default: forward with a hand, and put back at the end)."),
    lock_style: z.enum(["full", "quick"]).optional().describe("full = always the 3·2·1 warning. Default: the small pill for one call under 4s with end:true, else the warning."),
    label: z.string().optional().describe("Name of the recording (run folder, reports)."),
    isolate: z.boolean().optional().describe("Record the app's own windows alone (default true on a window)."),
    events: z.boolean().optional().describe("false = do not listen to what the app tells accessibility."),
    root: z.boolean().optional().describe("false = no dtrace / powermetrics beside the recording."),
    keyframe_ms: z.number().min(0).optional().describe("Keep a small frame every N ms while the picture changes (0 = none)."),
    fps: z.number().optional(),
    profile: z.union([z.boolean(), profileSchema]).optional().describe("true = also record Instruments (Time Profiler + Hitches) for eye_report view:'explain'."),
    ax: z.boolean().optional().describe("false = do not read the element under the pointer (it costs the app frame time; for final fps numbers)."),
    tree: treeSchema.optional().describe("Only watching: the element tree of the observed windows at start."),
    duplicates: z.enum(["ask", "quit_others", "relaunch", "allow"]).optional().describe(duplicatesSchemaDescription),
    ...analysisOpts,
  },
}, driving((p: any) => (p.guide ? null : "eye_drive"), fail, async (p): Promise<any> => {
  // The manual: read-only, so it neither waits for the turn nor touches an open session.
  if (p.guide) return text(chapter(p.guide));
  if (p.ask) {
    const r = await ask(p.ask);
    return typeof r === "string" ? fail(`not asked — ${r}`) : text(sayReply(cleanQuestion(p.ask), r));
  }
  // A wing that cannot be read is refused before anything opens: no lock is taken for a typo, and the words come
  // with the refusal (in full once per server, by name after that).
  if (p.wing?.trim()) {
    const w = parseWing(p.wing);
    if ("error" in w) return fail(`NOT RUN, nothing was sent: ${w.error}\n${chapterFor(/^"(fingers|flick|along)|^a wander/.test(w.error) ? "fingers" : "wing")}`);
  }
  // The first time a part is used, one line names its chapter.
  const tips = [
    p.wing?.trim() ? pointer(/\bfingers\b/.test(p.wing) ? "fingers" : "wing") : "", p.steps?.length ? pointer("steps") : "",
    p.url !== undefined ? pointer("web") : "", p.end || p.seconds || p.command ? pointer("reply") : "",
  ];
  const out: string[] = [], imgs: any[] = [];
  const done = (bad = false) => ({ content: [{ type: "text", text: [...out, ...tips.splice(0)].filter(Boolean).join("\n") }, ...imgs, ...endFrames.splice(0)], ...(bad ? { isError: true } : {}) });
  if (driveEnded) { out.push(driveEnded); driveEnded = ""; }
  if (drive) clearTimeout(drive.idle);
  if (drive && !running(drive.job)) out.push(await endDrive("its recording ended"));
  const acting = !!(p.wing?.trim() || p.steps?.length);
  let opened = false;
  if (!drive) {
    const watching = p.hands !== undefined || !!p.command || !!p.seconds;
    if (p.quit && !acting && !p.look && !watching && p.url !== undefined) { out.push((await quitBrowser()) || "the eye's browser is not running"); return done(); }
    if (p.quit && !acting && !p.look && !watching) {
      const fam = p.app !== undefined ? familyOf(p.app) : null;
      if (!fam) { out.push(p.app === undefined ? "quit needs app" : `no running app matches "${p.app}"`); return done(p.app === undefined); }
      const left = await quitPids([fam.target.pid]);
      out.push(left.length ? notQuit(left) : `quit pid ${fam.target.pid}\n${listFamily(p.app!)}`);
      return done(left.length > 0);
    }
    if (!acting && !p.look && !watching && p.app === undefined && !p.app_path && !p.rect && p.url === undefined) {
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
  if (!opened && p.url !== undefined) {
    if (!d.web) { if (d.hands) d.idle = setTimeout(idleOut, d.idleS * 1000); out.push(`NOT RUN: a session is open on ${d.what}. End it first (eye_drive {end:true}), then open one on ${p.url}.`); return done(true); }
    const o = await openPage({ url: p.url, viewport: p.viewport, reload: p.reload });
    out.push(o.ok ? `the tab now shows ${p.url}${o.note ? ` · ${o.note}` : ""}` : `NOT LOADED: ${o.error}`);
    if (!o.ok) { if (d.hands) d.idle = setTimeout(idleOut, d.idleS * 1000); return done(true); }
  }
  const cap = d.job.capture;
  const rearm = () => { d.busy = false; if (d.hands) d.idle = setTimeout(idleOut, d.idleS * 1000); };
  d.busy = true;
  const fresh = d.calls === 0;
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
    // The hand forgets an Esc ×6 of an earlier session (a wing says so itself; steps alone would not).
    if (fresh) await actorSend({ op: "fresh" });
    const tookIt = async () => {
      out.push("THE USER TOOK THEIR INPUT BACK (Esc ×6). The hand stopped where it was, lifted its fingers and let go of every button; nothing more was sent.", await endDrive("the user took their input back with Esc ×6"));
      return done(true);
    };
    const exact = (steps: any[], brief: true | "word") => actSteps({ steps, id: d.job.id, ax: p.ax ?? true, scroll_zones: (d.zones = p.scroll_zones ?? d.zones), label: p.label, brief }, d.target!, front);
    let halted = false, last: any = null;
    const plots: any[] = [];
    if (p.hold_ms) d.holdMs = p.hold_ms;
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
          if (d.taken) return tookIt();
          if (/^STOPPED — /m.test(t)) halted = true;
        } else {
          const room = await driveRoom(d);
          let noTouch = "";
          for (const m of part.moves) if (m.k === "fingers" && m.like) {
            const t = touchFor(m.like, m.n);
            if (typeof t === "string") { noTouch = t; break; }
            m.trace = t.trace;
          }
          if (noTouch) { rearm(); out.push(`NOT FLOWN: ${noTouch}.`); return done(true); }
          if ("error" in room) { out.push(`NOT FLOWN, nothing was sent: ${room.error}.`, await endDrive("the window is not there to be seen")); return done(true); }
          const r = await actorSend({ op: "wing", moves: part.moves, pid: d.target!.pid, require_pid: d.target!.pid, bounds: room.bounds,
            live: liveFile(cap), fresh: fresh && n === 0, speed: p.speed, coast_ms: (p.coast_ms ?? 1500) + holdFor(parts[n + 1]?.step), hold_ms: (d.holdMs ?? 20_000) + holdFor(parts[n + 1]?.step), max_ms: 30_000 }, 35_000);
          if (!r.ok) { rearm(); out.push(`the hand did not answer: ${r.error}`); return done(true); }
          if (d.taken || r.taken) return tookIt();
          for (const m of r.marks ?? []) {
            if (m.k === "note") continue;
            const op = /^tap|right-tap/.test(m.k) ? "click" : m.k;
            try { appendFileSync(join(cap.dir, "actions.jsonl"), JSON.stringify({ wall0: m.wall0, wall1: m.wall1, op, note: /"([^"]+)"/.exec(String(m.what))?.[1] ?? String(m.what), x: m.x, y: m.y, ok: true }) + "\n"); } catch { /* run dir gone */ }
          }
          last = r;
          keepTouch(d, r);
          plots.push(...(r.plots ?? []));
          out.push(...wingText(part.words, r, p.brief ?? !!r.fingers));
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
      else { out.push(String((await exact(p.steps, true)).content[0].text)); flying = false; if (d.taken) return tookIt(); }
    }
    if (front.raised && !d.raised) {
      d.raised = front.raised;
      out.push(`brought ${fmtWin(front.raised)} forward (another app covered the press); it goes back where it was when the session ends`);
    }
    // Fingers left down keep going: the screen is not waited for, and the reply is the short one unless asked otherwise.
    const down = !!last?.fingers && !p.steps?.length, brief = p.brief ?? down;
    // Whatever this set going plays out a moment before the screen is read (a hand left flying is not waited for).
    if (!flying && !down) for (let still = 0, end = Date.now() + 600; still < 3 && Date.now() < end; await sleep(50)) still = readLive(cap)?.moving ? 0 : still + 1;
    // What the fingers kept doing while nobody was steering belongs to this reply too.
    const since = d.seenTo ? Math.min(d.seenTo, seenFrom) : seenFrom;
    const liveNow = readLive(cap);
    const nowT = Math.max(Number(liveNow?.t ?? seenFrom), last && liveNow?.t0_mach ? Number(last.t0) + Number(last.ms) / 1000 - Number(liveNow.t0_mach) : 0);
    const drawn = d.hand.filter((x) => x[0] >= since - 0.02), touchNo = drawn.length ? drawn[drawn.length - 1][3] : -1;
    const stroke = drawn.filter((x) => x[3] === touchNo);
    if (stroke.length > 2) out.push(`the fingers ${d.seenTo ? "since the last reply" : "in this call"}: ${touchLine(stroke)}`);
    if (last) out.push(...plotsText(d, { ...last, plots }));
    if (brief && !(p.end && d.calls <= 1)) {
      out.push(reachLine(d.job, since, nowT));
      const ev = driveEvents(d);
      if (ev) out.push(ev);
      const said = d.web ? pageSaid() : "";
      if (said) out.push(`the page said:\n${said.split("\n").map((l) => `  ${l}`).join("\n")}`);
    } else if (!(p.end && d.calls <= 1)) {
      out.push(describeLive(readLive(cap)));
      try {
        const { rows, meta } = loadRun(cap.csv);
        snapshotStalls(cap.dir);
        const o = { ...d.job.opts, from_s: seenFrom };
        out.push(`during this call: ${formatSeen(notice(rows, meta, analyze(rows, meta, o), { ...o, dir: cap.dir, still_recording: true }), 5, probedRun(cap.dir))}`);
      } catch { /* not flushed yet */ }
      const ev = driveEvents(d);
      if (ev) out.push(ev);
      const said = d.web ? pageSaid() : "";
      if (said) out.push(`the page said:\n${said.split("\n").map((l) => `  ${l}`).join("\n")}`);
      const pl = d.probe || d.web ? activeProbeLive() : null;
      if (pl) out.push(describeProbeLive(pl, 4));
    }
    if (d.frames && p.frames !== false && drawn.length) {
      const fs = await filmStrip(d, since, seenFrom, nowT);
      if (fs) imgs.push({ type: "text", text: `film strip, ${fs.n} frame${fs.n === 1 ? "" : "s"} from ${fs.t0.toFixed(2)}s to ${fs.t1.toFixed(2)}s on the recording's clock, left to right then down${fs.before ? ` (the first ${fs.before}, times in grey: before this call, while the fingers kept going)` : ""}${fs.crop ? `; each is cut to where something moved (${fs.crop}, screen points)` : ""}. Beside each, the trackpad as it was then: the whole touch grey, its last 0.2s yellow, the fingers red, where they landed cyan.` }, fs.image);
    }
    d.seenTo = down ? nowT : 0;
    if (d.frames && p.frames !== false && !flying && !p.end && !brief) {
      const f = await settledFrame(d.job);
      if (f) imgs.push({ type: "text", text: "the frame it settled on:" }, f);
    }
  }
  if (p.frames === false) d.frames = false;
  if (p.look && d.web) {
    out.push(`in the page now (screen points):\n${capLines(await pageTree(120), 90, "eye_inspect {page:true} shows all of it")}`);
  } else if (p.look) {
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
  const own = cover ? undefined : await holdLock(() => startLock(8, "tagged", "quick"));
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
  description: "Re-read recorded runs (default: the most recent one; a run folder works as csv). view: summary (default) = what a viewer would have noticed, then one row per motion · timeline = binned time series · explain = the worst gaps joined with pointer, element, step and (with profile) the app's main thread · hover = every change of the element under the pointer · compare (default with runs) = side by side against the first run · probe (default with file) = per-layer report, or one layer's series with layer_id. What the columns mean: eye_drive {guide:\"reply\"}.",
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
setWebRoot(ROOT);

function cleanup() {
  releaseDriver();
  actor?.child.kill("SIGTERM");
  for (const j of jobs.values()) j.cmd?.kill("SIGTERM");
  for (const l of locks.values()) l.child.kill("SIGTERM");
  for (const c of captures.values()) { c.child.kill("SIGTERM"); c.events?.kill("SIGTERM"); c.fingers?.kill("SIGTERM"); endUnder(c.under); }
}
startLeaseHeartbeat(() => [...jobs.values()].some(running) || locks.size > 0 || activeProbeTarget() !== null);
process.on("exit", cleanup);
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, () => { cleanup(); process.exit(0); });
process.stdin.on("close", () => { cleanup(); process.exit(0); });

ensureBinary();
await server.connect(new StdioServerTransport());
