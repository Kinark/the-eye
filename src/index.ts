#!/usr/bin/env node
// the-eye — an MCP server that lets an agent MEASURE what is visible on a macOS screen over time.
// Native capture (ScreenCaptureKit, full display refresh) lives in bin/eye-capture (swift/EyeCapture.swift).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, compare, formatAnalysis, loadRun, timeline, type Options } from "./analyze.ts";
import { explain } from "./explain.ts";
import { activeProbeLive, activeProbeTarget, describeProbeLive, probeRunsStatus, registerProbeTools, resolvePid } from "./probe.ts";

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
}).optional().describe("Also record Instruments on the app and align it with the frames (see eye_explain). Starting xctrace takes a few seconds.");
const cursorOpts = {
  cursor: z.boolean().optional().describe("Log cursor position + the accessibility element under it (default true)."),
  ax_hz: z.number().optional().describe("Accessibility hit-tests per second to label what the cursor is over (default 0 = OFF). WARNING: any AX query makes SwiftUI apps maintain their accessibility graph on every frame — measured ~18% extra main-thread time and −25% fps on NOOTCH!. Use only for a separate labeling pass, never in a performance measurement."),
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

type Capture = {
  id: string; label: string; dir: string; csv: string; child: ChildProcess; done: Promise<string>; started: number;
  trace?: Trace; profileNote?: string; stopping?: boolean;
};
const captures = new Map<string, Capture>();
type Lock = { id: string; child: ChildProcess; done: Promise<string>; until: number; strict?: boolean };
const locks = new Map<string, Lock>();
const finishedLocks: string[] = []; // reports of locks that ended on their own (timeout / Esc)
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
  if (p.ax_hz !== undefined) args.push("--ax-hz", String(p.ax_hz));
  const child = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  const id = `cap${++seq}`;
  const c: Capture = { id, label: p.label ?? id, dir, csv, child, done: collect(child), started: Date.now() };
  if (p.profile) c.trace = startTrace(dir, p.profile, p.seconds + 15);
  captures.set(id, c);
  c.done.then((msg) => {
    // Ended on its own (not via eye_stop): keep why, so the next eye_stop/eye_act can say so.
    if (captures.has(id) && !c.stopping) diedCaptures.push(`${id} "${c.label}" ended after ${((Date.now() - c.started) / 1000).toFixed(1)}s: ${msg.slice(-600)}`);
  }).finally(() => captures.delete(id));
  return c;
}
const diedCaptures: string[] = [];

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

function startLock(seconds: number, allow: "synthetic" | "tagged", strict = false): Lock {
  ensureBinary();
  const args = ["lock", "--seconds", String(seconds), "--allow", allow];
  if (strict) args.push("--strict", "1");
  const child = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  const id = `lock${++seq}`;
  const l: Lock = { id, child, done: collect(child), until: Date.now() + seconds * 1000, strict };
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

const server = new McpServer({ name: "the-eye", version: "0.1.0" }, {
  instructions: [
    "the-eye measures what is VISIBLE on a macOS screen region over time, as numbers — per displayed frame:",
    "timestamp, gap since the previous new image, how much changed, and the extent of everything that differs",
    "from the first frame (e.g. an opening panel's width/height). Use it instead of eyeballing screenshots to",
    "judge animation smoothness (real on-screen fps, stalls, hitches, motion velocity jumps) and to A/B changes.",
    "Typical flow: eye_displays → eye_record_while (run your input-driver command with lock_input so the",
    "user's trackpad can't interfere) or eye_start/eye_stop around your own actions → eye_compare across runs.",
    "eye_timeline shows the curve over time; eye_frames returns saved keyframe PNG paths near a moment.",
    "Coordinates are display-local points, top-left origin. Needs Screen Recording (capture) and Accessibility",
    "(input lock) permission for the host app.",
    "For geometry from INSIDE an app (every layer's live animated frame/shape per display refresh, no pixels):",
    "eye_probe_attach → eye_probe_start → poll eye_probe_peek every ~0.5s while acting → eye_probe_stop.",
  ].join(" "),
});

server.registerTool("eye_displays", {
  title: "List displays",
  description: "List displays with id, size in points, backing scale and refresh rate (the fps target).",
  inputSchema: {},
}, async () => {
  ensureBinary();
  const r = await run(BIN, ["displays"], 8000);
  return r.code === 0 ? text(r.stdout.trim()) : fail(r.stdout + r.stderr);
});

server.registerTool("eye_snapshot", {
  title: "Snapshot a region",
  description: "Save a single PNG of a screen region. Returns the path; set return_image to also get the image inline.",
  inputSchema: { rect: rectSchema, display: z.number().int().optional(), return_image: z.boolean().optional(), path: z.string().optional() },
}, async ({ rect, display, return_image, path }) => {
  ensureBinary();
  const out = path ?? join(runDir("snapshot"), "snapshot.png");
  const args = ["snapshot", "--rect", rectArg(rect), "--out", out];
  if (display !== undefined) args.push("--display", String(display));
  let r = await run(BIN, args, 6000);
  let note = r.stdout.trim();
  if (r.code !== 0 && display === undefined) {
    // ScreenCaptureKit wedged: fall back to the system screenshot tool (main display, points).
    const fb = await run("/usr/sbin/screencapture", ["-x", "-R", `${rect.x},${rect.y},${rect.w},${rect.h}`, out], 8000);
    if (fb.code === 0 && existsSync(out)) {
      note = JSON.stringify({ path: out, via: "screencapture fallback", reason: (r.stderr || r.stdout).trim().slice(0, 200) });
      r = fb;
    }
  }
  if (r.code !== 0) return fail(r.stdout + r.stderr);
  const content: any[] = [{ type: "text", text: note }];
  if (return_image) content.push({ type: "image", data: readFileSync(out).toString("base64"), mimeType: "image/png" });
  return { content };
});

server.registerTool("eye_record", {
  title: "Record & measure",
  description: "Record a region for N seconds (blocking) at the display's refresh rate and return the measured animation report. Do your interactions from another process meanwhile, or prefer eye_record_while.",
  inputSchema: {
    rect: rectSchema, seconds: z.number().positive().max(300), label: z.string().optional(),
    display: z.number().int().optional(), fps: z.number().optional(),
    keyframe_ms: z.number().optional().describe("Also save a PNG every N ms (for eye_frames). Omit to save none."),
    profile: profileSchema, ...cursorOpts,
    ...analysisOpts,
  },
}, async (p) => {
  const c = startCapture(p);
  if (c.trace) await c.trace.ready;
  const meta = await c.done;
  await stopCapture(c);
  if (!existsSync(c.csv + ".meta.json")) return fail(meta);
  return text(`${report(c.csv, c.label, p)}${c.profileNote ? `\n${c.profileNote}` : ""}\n\nrun: ${c.dir}\ncsv: ${c.csv}`);
});

server.registerTool("eye_start", {
  title: "Start background recording",
  description: "Start recording a region in the background and return a capture id immediately. Act, then call eye_stop.",
  inputSchema: {
    rect: rectSchema, label: z.string().optional(), display: z.number().int().optional(), fps: z.number().optional(),
    max_seconds: z.number().positive().max(600).optional().describe("Safety stop (default 300)."),
    keyframe_ms: z.number().optional(),
    profile: profileSchema, ...cursorOpts,
  },
}, async (p) => {
  const c = startCapture({ ...p, seconds: p.max_seconds ?? 300 });
  const traceState = c.trace ? await c.trace.ready : "";
  await sleep(400);
  if (c.child.exitCode !== null) return fail(await c.done);
  return text(`capture ${c.id} recording → ${c.csv}${c.trace ? `\nInstruments: ${traceState}` : ""}`);
});

server.registerTool("eye_stop", {
  title: "Stop recording & measure",
  description: "Stop a background capture (or all) and return the measured report.",
  inputSchema: { capture_id: z.string().optional().describe("Omit to stop every active capture."), ...analysisOpts },
}, async (p) => {
  const list = p.capture_id ? [captures.get(p.capture_id)].filter(Boolean) as Capture[] : [...captures.values()];
  if (!list.length) return fail(diedCaptures.length ? `no active capture — ${diedCaptures.join("\n")}` : "no active capture");
  const out: string[] = [];
  for (const c of list) {
    await stopCapture(c);
    let body: string;
    try { body = report(c.csv, c.label, p); } catch (e: any) { body = `${c.label}: could not analyze (${e.message})`; }
    out.push(`${body}${c.profileNote ? `\n${c.profileNote}` : ""}\n\nrun: ${c.dir}\ncsv: ${c.csv}`);
  }
  return text(out.join("\n\n"));
});

// A command run under observation (eye_record_while). Lives in `jobs` so eye_peek/eye_abort can
// reach it while it runs, and keeps its final report after it ends.
type Job = {
  id: string; label: string; capture: Capture; lock?: Lock; cmd?: ChildProcess; output: string[];
  started: number; state: "starting" | "running" | "finishing" | "done" | "aborted"; exitCode?: number | null;
  lockResult?: string; abortReason?: string; final?: string; finished: Promise<string>; opts: Options;
};
const jobs = new Map<string, Job>();
const liveFile = (c: Capture) => c.csv + ".live.json";
function readLive(c: Capture): any | null {
  try { return JSON.parse(readFileSync(liveFile(c), "utf8")); } catch { return null; }
}

function runJob(p: {
  rect: Rect; command: string; cwd?: string; label?: string; display?: number; lock_input?: boolean;
  pre_ms?: number; post_ms?: number; timeout_s?: number; keyframe_ms?: number;
  profile?: ProfileOpts; cursor?: boolean; ax_hz?: number;
} & Options): Job {
  const timeout = p.timeout_s ?? 300;
  const c = startCapture({ rect: p.rect, display: p.display, label: p.label, keyframe_ms: p.keyframe_ms, seconds: timeout + 30,
    profile: p.profile, cursor: p.cursor, ax_hz: p.ax_hz });
  const id = `run${++seq}`;
  const job: Job = { id, label: p.label ?? id, capture: c, output: [], started: Date.now(), state: "starting", finished: null as any, opts: p };
  jobs.set(id, job);
  job.finished = (async () => {
    if (c.trace) job.output.push(`Instruments: ${await c.trace.ready}`);
    job.lock = p.lock_input ? startLock(timeout + 10, "synthetic") : undefined;
    await sleep(p.pre_ms ?? 500);
    if (c.child.exitCode !== null) {
      if (job.lock) job.lockResult = await stopLock(job.lock);
      job.state = "done"; job.final = `capture failed: ${await c.done}`;
      return job.final;
    }
    if (job.state !== "aborted") {
      job.state = "running";
      job.cmd = spawn("/bin/zsh", ["-lc", p.command], {
        cwd: p.cwd, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, THE_EYE_LIVE: liveFile(c), THE_EYE_RECT: rectArg(p.rect), THE_EYE_RUN_DIR: c.dir },
      });
      const push = (d: Buffer) => {
        for (const line of String(d).split("\n")) if (line.trim()) job.output.push(`${((Date.now() - job.started) / 1000).toFixed(1)}s ${line}`);
        if (job.output.length > 400) job.output.splice(0, job.output.length - 400);
      };
      job.cmd.stdout!.on("data", push);
      job.cmd.stderr!.on("data", push);
      const killer = setTimeout(() => { job.abortReason ??= "timeout"; job.cmd?.kill("SIGTERM"); }, timeout * 1000);
      job.exitCode = await new Promise((r) => job.cmd!.on("close", r));
      clearTimeout(killer);
    }
    if (job.lock) job.lockResult = await stopLock(job.lock);
    if (job.state !== "aborted") job.state = "finishing";
    await sleep(job.state === "aborted" ? 0 : p.post_ms ?? 1000);
    await stopCapture(c);
    const tail = job.output.slice(-15).join("\n");
    job.final = [
      `${job.state === "aborted" ? `ABORTED (${job.abortReason}) · ` : ""}command exit ${job.exitCode ?? "-"}${job.lockResult ? ` · input lock: ${job.lockResult}` : ""}`,
      tail ? `command output (tail):\n${tail}` : "",
      report(c.csv, c.label, p),
      c.profileNote ?? "",
      `run: ${c.dir}\ncsv: ${c.csv}`,
    ].filter(Boolean).join("\n\n");
    if (job.state !== "aborted") job.state = "done";
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
  return `live @${live.t.toFixed(1)}s: ${live.moving ? "MOVING" : "still"} · last 1s: ${l.new_frames} new frames, ${l.idle} idle, max gap ${Number(l.max_gap_ms).toFixed(1)}ms, ${l.hitches} hitches\n  ${anch} · ${ext}`;
}

server.registerTool("eye_record_while", {
  title: "Record while running a command",
  description: "Start recording, optionally lock the user's PHYSICAL trackpad/mouse (synthetic input still passes; Esc releases), run a shell command (e.g. your input-driver script), keep recording a little after it ends, then return the command result + the measured report. With background:true it returns a run id immediately — poll eye_peek every few seconds to verify the test is doing what you expect, and eye_abort the moment it isn't. The command gets env THE_EYE_LIVE (path of a JSON file refreshed 10×/s with what is visible right now: changed_extent_screen, moving, last_1s stats) so drivers can check state before acting, plus THE_EYE_RECT and THE_EYE_RUN_DIR.",
  inputSchema: {
    rect: rectSchema, command: z.string().describe("Run with /bin/zsh -lc"), cwd: z.string().optional(),
    label: z.string().optional(), display: z.number().int().optional(),
    background: z.boolean().optional().describe("Return immediately with a run id (default false). Recommended for anything longer than a few seconds."),
    lock_input: z.boolean().optional().describe("Block physical pointer input while the command runs (default false)."),
    pre_ms: z.number().optional().describe("Record this long before starting the command (default 500)."),
    post_ms: z.number().optional().describe("Keep recording after the command exits (default 1000)."),
    timeout_s: z.number().positive().max(600).optional().describe("Kill the command after this (default 300)."),
    keyframe_ms: z.number().optional(),
    profile: profileSchema, ...cursorOpts,
    ...analysisOpts,
  },
}, async (p) => {
  const job = runJob(p);
  if (!p.background) return text(await job.finished);
  await sleep((p.pre_ms ?? 500) + 300);
  return text(`${job.id} started (${job.state}) — poll eye_peek {run_id:"${job.id}"}; eye_abort to stop.\nlive file: ${liveFile(job.capture)}`);
});

server.registerTool("eye_peek", {
  title: "Peek at a running test",
  description: "Live status of a background eye_record_while run (or an eye_start capture): state, elapsed, the command's latest output lines, what is visible RIGHT NOW (moving or not, extent of the visible change in screen points), and the measured smoothness over the last few seconds. When the run is finished it returns the final report.",
  inputSchema: {
    run_id: z.string().optional().describe("eye_record_while run id or eye_start capture id. Omit for the most recent."),
    window_s: z.number().positive().optional().describe("Seconds of recent history to measure (default 3)."),
    output_lines: z.number().int().optional().describe("Command output lines to include (default 8)."),
  },
}, async (p) => {
  const job = p.run_id ? jobs.get(p.run_id) : [...jobs.values()].pop();
  const cap = job?.capture ?? (p.run_id ? captures.get(p.run_id) : [...captures.values()].pop());
  if (!cap) return fail(`unknown run ${p.run_id ?? "(none active)"}`);
  if (job?.final && (job.state === "done" || job.state === "aborted")) return text(`${job.id} ${job.state}\n\n${job.final}`);
  const live = readLive(cap);
  const lines: string[] = [];
  const elapsed = ((Date.now() - (job?.started ?? cap.started)) / 1000).toFixed(1);
  lines.push(`${job?.id ?? cap.id} "${job?.label ?? cap.label}" ${job?.state ?? "recording"} · ${elapsed}s elapsed${job?.lock ? " · input locked" : ""}`);
  lines.push(describeLive(live));
  try {
    const { rows, meta } = loadRun(cap.csv);
    const t = live?.t ?? (rows.length ? rows[rows.length - 1].t : 0);
    const w = p.window_s ?? 3;
    const a = analyze(rows, meta, { ...(job?.opts ?? {}), from_s: Math.max(0, t - w) });
    lines.push(a.overall
      ? `last ${w}s while animating: ${a.overall.fps} fps of ${a.overall.target_fps} · hitches ${a.overall.hitches} (long ${a.overall.long_hitches}) · p95 gap ${a.overall.gap_p95_ms}ms · max ${a.overall.gap_max_ms}ms`
      : `last ${w}s: no animation`);
  } catch { /* csv not flushed yet */ }
  if (job) {
    const n = p.output_lines ?? 8;
    lines.push(job.output.length ? `command output (last ${Math.min(n, job.output.length)}):\n${job.output.slice(-n).join("\n")}` : "command output: (none yet)");
  }
  const pl = activeProbeLive();
  if (pl) lines.push(describeProbeLive(pl, 5));
  return text(lines.join("\n"));
});

server.registerTool("eye_abort", {
  title: "Abort a running test",
  description: "Kill a background eye_record_while run immediately: stops the command, releases the input lock, stops the capture, and returns the (partial) report.",
  inputSchema: { run_id: z.string().optional().describe("Omit to abort every running job."), reason: z.string().optional() },
}, async (p) => {
  const list = p.run_id ? [jobs.get(p.run_id)].filter(Boolean) as Job[] : [...jobs.values()].filter((j) => j.state !== "done" && j.state !== "aborted");
  if (!list.length) return text("nothing running");
  const out: string[] = [];
  for (const j of list) {
    if (j.state === "done" || j.state === "aborted") { out.push(`${j.id} already ${j.state}`); continue; }
    j.state = "aborted";
    j.abortReason = p.reason ?? "aborted by agent";
    j.cmd?.kill("SIGTERM");
    if (j.lock) j.lockResult = await stopLock(j.lock);
    out.push(`${j.id}:\n${await j.finished}`);
  }
  return text(out.join("\n\n"));
});

// ---- Interactive driving: a persistent native input process + steps checked against live state.

let actor: { child: ChildProcess; pending: ((s: string) => void)[]; buf: string } | null = null;
function inputActor() {
  if (actor && actor.child.exitCode === null) return actor;
  ensureBinary();
  const child = spawn(BIN, ["input"], { stdio: ["pipe", "pipe", "pipe"] });
  const a = { child, pending: [] as ((s: string) => void)[], buf: "" };
  child.stdout!.on("data", (d) => {
    a.buf += d;
    let i;
    while ((i = a.buf.indexOf("\n")) >= 0) { const line = a.buf.slice(0, i); a.buf = a.buf.slice(i + 1); a.pending.shift()?.(line); }
  });
  child.on("close", () => { for (const p of a.pending.splice(0)) p(JSON.stringify({ ok: false, error: "input actor exited" })); });
  actor = a;
  return a;
}
function actorSend(cmd: object): Promise<any> {
  const a = inputActor();
  const budget = 10_000 + Number((cmd as any).ms ?? 0) + 50 * Number((cmd as any).events ?? 0);
  return new Promise((res) => {
    // If the actor wedges, kill it: its close handler fails every pending command and the next call respawns it.
    const t = setTimeout(() => a.child.kill("SIGKILL"), budget);
    a.pending.push((line) => { clearTimeout(t); try { res(JSON.parse(line)); } catch { res({ ok: false, error: line }); } });
    a.child.stdin!.write(JSON.stringify(cmd) + "\n");
  });
}

function activeCapture(id?: string): Capture | undefined {
  if (id) return jobs.get(id)?.capture ?? captures.get(id);
  const running = [...jobs.values()].filter((j) => j.state !== "done" && j.state !== "aborted").map((j) => j.capture);
  return running.pop() ?? [...captures.values()].pop();
}

/** Variables available to guard/until/assert expressions. */
function scope(live: any, ptr: { x: number; y: number }) {
  return {
    live,
    a: live?.anchored_screen ?? null,          // top-anchored extent {x0,x1,w,h,cx,y0,y1} in screen points, or null
    e: live?.changed_extent_screen ?? null,    // bbox of every change vs the first frame
    moving: !!live?.moving,
    fps1: live?.last_1s?.new_frames ?? 0,      // new frames in the last second
    gap1: live?.last_1s?.max_gap_ms ?? 0,
    p: ptr,                                    // pointer position
    pr: activeProbeLive(),                     // layer-probe live JSON (eye_probe_start), or null
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
  expr: z.string().optional().describe("wait_until/assert: JS expression over a, e, moving, fps1, gap1, p, live"),
  timeout_ms: z.number().optional().describe("wait_until timeout (default 2000)"),
  guard: z.string().optional().describe("Expression that must hold BEFORE this step runs, else the sequence stops."),
  force: z.boolean().optional().describe("scroll: skip the inside-the-open-area safety check. Presses (click/down) can NOT be forced."),
  on: z.union([z.string(), z.number()]).optional().describe("click/down/move: aim at a probe layer (label substring or layer id) instead of x,y — its centre (shape bounds if any), resolved from the probe's live data at that moment. The layer must be in the live moving/watched lists (add it to eye_probe_start watch)."),
  note: z.string().optional(),
});

server.registerTool("eye_act", {
  title: "Act and observe",
  description: [
    "Drive the screen step by step and get the measured visible state after EVERY step, so you can think and react between calls.",
    "Steps: move {x,y,ms}, click {x?,y?,button,count}, down/up {button} (drag), scroll {dy,dx,events,phased}, wait {ms},",
    "wait_until {expr,timeout_ms}, assert {expr}. Any step may carry `guard` (expression that must hold first).",
    "Expressions see: a = top-anchored open extent {x0,x1,w,h,cx} in screen points or null, e = bbox of all change,",
    "moving, fps1 (new frames last 1s), gap1 (max frame gap last 1s, ms), p = pointer {x,y}, live = raw live JSON,",
    "pr = layer-probe live JSON (eye_probe_start; null if none), L('label substring') = that probe layer {rect,shape,updates,coverage,max_gap_ms} or null.",
    "SAFETY: scroll is refused unless the pointer is inside `a` (the measured open area) or inside one of `scroll_zones`, unless force:true.",
    "Needs an active recording (eye_start or a background eye_record_while) for live state; events pass eye_lock_input.",
    "The sequence stops at the first failed guard/assert/wait_until and reports why.",
  ].join(" "),
  inputSchema: {
    steps: z.array(stepSchema).min(1).max(60),
    capture_id: z.string().optional().describe("Capture/run whose live state to use (default: most recent active)."),
    scroll_zones: z.array(rectSchema).optional().describe("Extra screen rects (points) where scrolling is allowed, e.g. the closed notch."),
    label: z.string().optional().describe("Phase name recorded with these steps in the run's action log (eye_explain groups by it)."),
    target_process: z.union([z.string(), z.number()]).optional().describe("App that presses must land on (name or pid). Default: the app of the running probe recording. Presses are refused without a target."),
    lock: z.boolean().optional().describe("Hold a STRICT input lock (physical pointer + keyboard, Esc ignored) for exactly the duration of these steps (default true)."),
  },
}, async (p) => {
  let target: { pid: number; name: string } | null = null;
  try { target = p.target_process !== undefined ? await resolvePid(p.target_process) : activeProbeTarget(); }
  catch (e: any) { return fail(e.message); }
  let strictLock: Lock | undefined;
  // A strict session lock (eye_lock_input strict) already covers us, including between calls mid-drag.
  const covered = [...locks.values()].some((l) => l.strict && l.until > Date.now() + 5000);
  if (p.lock !== false && !covered) {
    const budget = p.steps.reduce((t, s) => t + (s.ms ?? 0) + (s.timeout_ms ?? (s.op === "wait_until" ? 2000 : 0)) + (s.hold_ms ?? 0) + 300, 0);
    strictLock = startLock(Math.min(300, Math.ceil(budget / 1000) + 15), "tagged", true);
    await sleep(150);
    if (strictLock.child.exitCode !== null) return fail(`could not take the input lock: ${await strictLock.done}`);
  }
  try { return await actSteps(p, target); }
  finally { if (strictLock) await stopLock(strictLock); }
});

async function actSteps(p: any, target: { pid: number; name: string } | null) {
  const cap = activeCapture(p.capture_id);
  const readNow = () => (cap ? readLive(cap) : null);
  const t0 = Date.now();
  const lines: string[] = [];
  let ptr = { x: 0, y: 0 };
  { const r = await actorSend({ op: "pos" }); if (r.ok) ptr = { x: r.x, y: r.y }; }
  const stamp = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
  let stopped = "";
  const wallNow = () => (performance.timeOrigin + performance.now()) / 1000;
  const logAction = (s: any, wall0: number, ok: boolean) => {
    if (!cap) return;
    try {
      appendFileSync(join(cap.dir, "actions.jsonl"), JSON.stringify({ wall0, wall1: wallNow(), op: s.op, note: s.note ?? p.label, x: ptr.x, y: ptr.y, ok }) + "\n");
    } catch { /* run dir gone */ }
  };
  for (const [i, s] of p.steps.entries()) {
    const tag = `#${i} ${s.op}${s.note ? ` (${s.note})` : ""}`;
    const wall0 = wallNow();
    const before = lines.length, stoppedBefore = stopped;
    try {
      if (s.guard && !evalExpr(s.guard, scope(readNow(), ptr))) { stopped = `${tag}: guard failed: ${s.guard}`; break; }
      if (s.op === "wait") { await sleep(s.ms ?? 300); }
      else if (s.op === "wait_until" || s.op === "assert") {
        if (!s.expr) { stopped = `${tag}: needs expr`; break; }
        const end = Date.now() + (s.op === "assert" ? 0 : s.timeout_ms ?? 2000);
        let ok = evalExpr(s.expr, scope(readNow(), ptr));
        while (!ok && Date.now() < end) { await sleep(25); ok = evalExpr(s.expr, scope(readNow(), ptr)); }
        if (!ok) { lines.push(`${stamp()} ${tag} ✗ ${s.expr} · ${short(readNow())}`); stopped = `${tag}: not satisfied: ${s.expr}`; break; }
      } else {
        if (s.op === "scroll" && !s.force) {
          const live = readNow(), a = live?.anchored_screen;
          const inA = a && ptr.x > a.x0 + 10 && ptr.x < a.x1 - 10 && ptr.y < (a.y0 ?? 0) + a.h - 5;
          const inZone = (p.scroll_zones ?? []).some((z) => ptr.x >= z.x && ptr.x <= z.x + z.w && ptr.y >= z.y && ptr.y <= z.y + z.h);
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
          if (!hit) { stopped = `${tag}: no live probe layer matches ${JSON.stringify(on)} (watch it in eye_probe_start)`; break; }
          aimed = hit.shape ?? hit.rect;
          cmd.x = aimed![0] + aimed![2] / 2; cmd.y = aimed![1] + aimed![3] / 2;
        }
        if (s.op === "click" || s.op === "down") {
          // Presses can never land outside the target app: no force, both checks always run.
          if (!target) { stopped = `${tag}: REFUSED press — no target app (pass target_process, or run eye_probe_start)`; break; }
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
      }
      lines.push(`${stamp()} ${tag} → p(${ptr.x.toFixed(0)},${ptr.y.toFixed(0)}) · ${short(readNow())}`);
    } catch (err: any) { stopped = `${tag}: ${err.message}`; break; }
    finally { if (s.op !== "assert") logAction(s, wall0, stopped === stoppedBefore); void before; }
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
  return text([
    ...lines,
    stopped ? `STOPPED — ${stopped}` : `all ${p.steps.length} steps done`,
    cap ? describeLive(live) : diedCaptures.length ? `(capture ended early — ${diedCaptures[diedCaptures.length - 1]})` : "(no active capture — start one with eye_start for live state)",
    recent,
    activeProbeLive() ? describeProbeLive(activeProbeLive(), 5) : "",
  ].filter(Boolean).join("\n"));
}

server.registerTool("eye_explain", {
  title: "Explain a recording",
  description: [
    "Join everything recorded for a run on ONE clock and explain the bad frames: for each worst on-screen gap during",
    "animation → when, how long, where the cursor was and which accessibility element it was over, which eye_act step",
    "was running, and (if recorded with profile) how busy the app's main thread was, which of the app's own functions",
    "were on it, and any Instruments hitch. Also: smoothness grouped by what the cursor was over and by agent action, and",
    "the app functions over-represented during dropped frames vs. smooth ones.",
  ].join(" "),
  inputSchema: {
    csv: z.string().describe("frames.csv of the run"),
    top: z.number().int().optional().describe("How many worst gaps to list (default 12)."),
    gap_frames: z.number().optional().describe("Minimum gap, in refreshes, to list (default 3)."),
    app_binary: z.string().optional().describe("The app's binary name in stacks (default: guessed)."),
    from_s: z.number().optional(), to_s: z.number().optional(),
  },
}, async (p) => {
  try { return text(explain(p.csv, p)); } catch (e: any) { return fail(e.stack ?? e.message); }
});

server.registerTool("eye_analyze", {
  title: "Analyze a recording",
  description: "Re-analyze a recorded frames.csv, optionally within a time window or with different thresholds.",
  inputSchema: {
    csv: z.string(), label: z.string().optional(), from_s: z.number().optional(), to_s: z.number().optional(),
    max_segments: z.number().int().optional(), ...analysisOpts,
  },
}, async (p) => {
  try { return text(report(p.csv, p.label ?? p.csv, p, p.max_segments)); } catch (e: any) { return fail(e.message); }
});

server.registerTool("eye_compare", {
  title: "Compare recordings",
  description: "Side-by-side table of several recordings (first one is the baseline for deltas).",
  inputSchema: { runs: z.array(z.object({ csv: z.string(), label: z.string() })).min(1), ...analysisOpts },
}, async (p) => {
  try {
    return text(compare(p.runs.map(({ csv, label }) => { const { rows, meta } = loadRun(csv); return { label, a: analyze(rows, meta, p) }; })));
  } catch (e: any) { return fail(e.message); }
});

server.registerTool("eye_timeline", {
  title: "Time series",
  description: "Binned time series of a recording: new frames, idle refreshes, worst gap, % pixels moved, luminance and the changed-region extent per bin. Use it to see the shape of an animation over time.",
  inputSchema: { csv: z.string(), bin_ms: z.number().positive().optional(), from_s: z.number().optional(), to_s: z.number().optional() },
}, async (p) => {
  try { return text(timeline(loadRun(p.csv).rows, p.bin_ms ?? 50, p.from_s, p.to_s)); } catch (e: any) { return fail(e.message); }
});

server.registerTool("eye_frames", {
  title: "Keyframes near a time",
  description: "Paths of saved keyframes (recordings made with keyframe_ms) closest to a time, optionally returned inline.",
  inputSchema: { csv: z.string(), t_s: z.number(), count: z.number().int().min(1).max(8).optional(), return_images: z.boolean().optional() },
}, async (p) => {
  const dir = join(dirname(p.csv), "keyframes");
  if (!existsSync(dir)) return fail("this recording has no keyframes (record with keyframe_ms)");
  const files = readdirSync(dir).filter((f) => f.endsWith(".png"))
    .map((f) => ({ f, t: Number(f.replace(/^frame_|ms\.png$/g, "")) / 1000 }))
    .sort((a, b) => Math.abs(a.t - p.t_s) - Math.abs(b.t - p.t_s)).slice(0, p.count ?? 3).sort((a, b) => a.t - b.t);
  const content: any[] = [{ type: "text", text: files.map((x) => `${x.t.toFixed(3)}s ${join(dir, x.f)}`).join("\n") }];
  if (p.return_images) for (const x of files) content.push({ type: "image", data: readFileSync(join(dir, x.f)).toString("base64"), mimeType: "image/png" });
  return { content };
});

server.registerTool("eye_lock_input", {
  title: "Lock physical pointer",
  description: "Block the user's PHYSICAL trackpad/mouse (moves, clicks, scroll, gestures) so automated input runs undisturbed. Synthetic events from other processes still pass. Keyboard stays live; Esc releases it. Auto-releases after `seconds` (max 600).",
  inputSchema: {
    seconds: z.number().positive().max(600),
    allow: z.enum(["synthetic", "tagged"]).optional().describe("synthetic (default): any process-posted event passes. tagged: only events with eventSourceUserData 0x45594521."),
    strict: z.boolean().optional().describe("Also block the physical KEYBOARD, ignore Esc, and pass only the-eye's own events. Ends only on timeout or eye_unlock. eye_act takes one automatically while it drives."),
  },
}, async (p) => {
  const l = startLock(p.seconds, p.allow ?? "synthetic", !!p.strict);
  await sleep(300);
  if (l.child.exitCode !== null) return fail(await l.done);
  return text(p.strict
    ? `${l.id}: physical pointer AND keyboard locked for ${p.seconds}s (strict: Esc does not release). Call eye_unlock when done.`
    : `${l.id}: physical pointer locked for ${p.seconds}s (Esc releases). Call eye_unlock when done.`);
});

server.registerTool("eye_unlock", {
  title: "Unlock physical pointer",
  description: "Release input locks (all, or one id). Reports how many physical events were blocked.",
  inputSchema: { lock_id: z.string().optional() },
}, async (p) => {
  const list = p.lock_id ? [locks.get(p.lock_id)].filter(Boolean) as Lock[] : [...locks.values()];
  const out: string[] = [];
  for (const l of list) out.push(`${l.id}: ${await stopLock(l)}`);
  if (!out.length) {
    const prior = p.lock_id ? finishedLocks.filter((r) => r.startsWith(p.lock_id + ":")) : finishedLocks.slice(0, 3);
    return text(prior.length ? `no active lock; already ended:\n${prior.join("\n")}` : "no active lock");
  }
  return text(out.join("\n"));
});

server.registerTool("eye_status", {
  title: "Active captures and locks",
  description: "List active background captures and input locks, and where runs are stored.",
  inputSchema: {},
}, async () => {
  const now = Date.now();
  return text([
    `runs dir: ${RUNS}`,
    ...[...jobs.values()].map((j) => `${j.id} "${j.label}" ${j.state} (${((now - j.started) / 1000).toFixed(0)}s)`),
    ...[...captures.values()].map((c) => `${c.id} "${c.label}" recording for ${((now - c.started) / 1000).toFixed(1)}s → ${c.csv}`),
    ...[...locks.values()].map((l) => `${l.id} locked, ${Math.max(0, (l.until - now) / 1000).toFixed(0)}s left`),
    ...finishedLocks.slice(0, 3).map((r) => `ended ${r}`),
    ...probeRunsStatus(),
  ].join("\n"));
});

registerProbeTools(server, { root: ROOT, runDir, text, fail });

function cleanup() {
  actor?.child.kill("SIGTERM");
  for (const j of jobs.values()) j.cmd?.kill("SIGTERM");
  for (const l of locks.values()) l.child.kill("SIGTERM");
  for (const c of captures.values()) c.child.kill("SIGTERM");
}
process.on("exit", cleanup);
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, () => { cleanup(); process.exit(0); });
process.stdin.on("close", () => { cleanup(); process.exit(0); });

ensureBinary();
await server.connect(new StdioServerTransport());
