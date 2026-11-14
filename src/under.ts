// Under the pixels, as root: who was late, and what the motion cost.
//
// A recording shows a frame arriving late; it cannot show whose fault that was. Two system tools can, and both
// need root (the-eye never asks for a password: it uses them only when `sudo -n` already allows it):
//   dtrace       the recorded app's Core Animation commits (when, and how long each held the main thread) and
//                the window server's frame swaps (when a new frame actually went to the display)   → under.txt
//   powermetrics CPU and GPU time of the app and of the window server, and GPU power, ten times a second → cost.jsonl
// Both are stamped on the wall clock, so the report can lay them on the frames' clock.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DTRACE = "/usr/sbin/dtrace", POWERMETRICS = "/usr/bin/powermetrics";
const allowed = new Map<string, boolean>();
/** True when sudo runs this tool without asking (a sudoers NOPASSWD rule, or root). Asked once per tool. */
export function rootAllows(tool: string): boolean {
  if (!allowed.has(tool)) {
    const r = spawnSync("/usr/bin/sudo", ["-n", "-l", tool], { stdio: "ignore", timeout: 3000 });
    allowed.set(tool, r.status === 0);
  }
  return allowed.get(tool)!;
}
/** What to tell someone whose recordings have no root readings. */
export const ROOT_HINT = `root readings (who was late, what it cost) need dtrace and powermetrics without a password: add "${process.env.USER ?? "you"} ALL=(root) NOPASSWD: ${DTRACE}, ${POWERMETRICS}" to /etc/sudoers.d/the-eye (sudo visudo -f /etc/sudoers.d/the-eye)`;

export type Under = { children: ChildProcess[] };

export function startUnder(dir: string, pid: number, seconds: number): Under | null {
  if (process.env.THE_EYE_ROOT === "0") return null; // the whole server without root readings (A/B their cost)
  const children: ChildProcess[] = [];
  const limit = Math.ceil(seconds);
  try {
    if (rootAllows(DTRACE)) {
      const ws = spawnSync("/usr/bin/pgrep", ["-x", "WindowServer"], { encoding: "utf8", timeout: 2000 }).stdout.trim().split("\n")[0];
      const d = [
        `pid${pid}:QuartzCore:CA??Transaction??commit():entry { self->c = timestamp; }`,
        `pid${pid}:QuartzCore:CA??Transaction??commit():return /self->c/ { printf("C %d %d\\n", walltimestamp, timestamp - self->c); self->c = 0; }`,
        ws ? `pid${ws}:QuartzCore:CA??WindowServer??IOMFBDisplay??swap_set_layer*:entry { printf("S %d %x\\n", walltimestamp, arg0); }` : "",
        `tick-${limit}s { exit(0); }`,
      ].join(" ");
      const c = spawn("/usr/bin/sudo", ["-n", DTRACE, "-q", "-x", "switchrate=20hz", "-o", join(dir, "under.txt"), "-c", "/bin/cat", "-n", d], { stdio: ["pipe", "ignore", "ignore"] });
      c.stdin!.on("error", () => {});
      c.on("error", () => {});
      children.push(c);
    }
    if (rootAllows(POWERMETRICS)) {
      const out = join(dir, "cost.jsonl");
      const c = spawn("/usr/bin/sudo", ["-n", POWERMETRICS, "--samplers", "tasks,gpu_power,cpu_power", "--show-process-gpu", "-i", "100", "-n", String(limit * 10), "-b", "1"],
        { stdio: ["ignore", "pipe", "ignore"] });
      c.on("error", () => {});
      // powermetrics stamps its samples to the second; the moment a sample's header arrives is good to a few ms.
      let buf = "", cur: any = null;
      const task = /\s(\d+)\s+([\d.]+)\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+([\d.]+)\s*$/;
      const flush = () => { if (cur) try { appendFileSync(out, JSON.stringify(cur) + "\n"); } catch { /* run folder gone */ } cur = null; };
      c.stdout!.on("data", (chunk) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const l = buf.slice(0, i); buf = buf.slice(i + 1);
          const head = l.match(/^\*\*\* Sampled system activity .*\(([\d.]+)ms elapsed\)/);
          if (head) { flush(); cur = { t: (performance.timeOrigin + performance.now()) / 1000, ms: Number(head[1]) }; continue; }
          if (!cur) continue;
          const m = l.match(task);
          if (m && Number(m[1]) === pid) { cur.app_cpu = Number(m[2]); cur.app_gpu = Number(m[3]); }
          else if (m && l.startsWith("WindowServer ")) { cur.ws_cpu = Number(m[2]); cur.ws_gpu = Number(m[3]); }
          else if (l.startsWith("GPU Power:")) cur.gpu_mw = Number(l.match(/([\d.]+) mW/)?.[1]);
          else if (l.startsWith("CPU Power:")) cur.cpu_mw = Number(l.match(/([\d.]+) mW/)?.[1]);
        }
      });
      c.on("close", flush);
      children.push(c);
    }
  } catch { /* a recording without root readings is still a recording */ }
  return children.length ? { children } : null;
}

/**
 * Ends both tools and waits until dtrace has written what it buffered. They run as root, so they cannot be
 * signalled from here; each is held by a pipe instead: dtrace lives as long as the `cat` it was started with
 * (`-c`), which lives as long as its stdin, and powermetrics dies writing to a closed stdout. The same pipes end
 * them if this process dies.
 */
export function endUnder(u: Under | null | undefined) {
  for (const c of u?.children ?? []) { c.stdin?.end(); c.stdout?.destroy(); }
}
export async function stopUnder(u: Under | null | undefined): Promise<void> {
  if (!u) return;
  await Promise.all(u.children.map((c) => new Promise<void>((res) => {
    if (c.exitCode !== null || c.signalCode !== null) return res();
    const t = setTimeout(res, 2500);
    c.once("close", () => { clearTimeout(t); res(); });
    endUnder({ children: [c] });
  })));
}

type Cost = { t: number; ms: number; app_cpu?: number; app_gpu?: number; ws_cpu?: number; ws_gpu?: number; gpu_mw?: number; cpu_mw?: number };
export type Readings = {
  /** The app's Core Animation commits: when each ended (run clock, s) and how long it ran (ms). */
  commits: { t: number; ms: number }[];
  /** When the window server handed a new frame to the display (run clock, s), busiest display. */
  swaps: number[];
  cost: Cost[];
};

export function loadUnder(dir: string, t0Wall: number): Readings | null {
  if (!t0Wall) return null;
  const commits: Readings["commits"] = [], byDisplay = new Map<string, number[]>(), cost: Cost[] = [];
  const u = join(dir, "under.txt"), c = join(dir, "cost.jsonl");
  if (existsSync(u)) for (const l of readFileSync(u, "utf8").split("\n")) {
    const p = l.split(" ");
    if (p[0] === "C" && p.length === 3) commits.push({ t: Number(p[1]) / 1e9 - t0Wall, ms: Number(p[2]) / 1e6 });
    else if (p[0] === "S" && p.length === 3) {
      const t = Number(p[1]) / 1e9 - t0Wall, list = byDisplay.get(p[2]) ?? [];
      // One frame can set several layers within a millisecond or two: that is one swap.
      if (!list.length || t - list[list.length - 1] > 0.003) list.push(t);
      byDisplay.set(p[2], list);
    }
  }
  if (existsSync(c)) for (const l of readFileSync(c, "utf8").split("\n")) {
    if (!l) continue;
    try { const o = JSON.parse(l); cost.push({ ...o, t: o.t - t0Wall }); } catch { /* torn line */ }
  }
  const swaps = [...byDisplay.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  commits.sort((a, b) => a.t - b.t);
  return commits.length || swaps.length || cost.length ? { commits, swaps, cost } : null;
}

const ms = (x: number) => `${x >= 100 ? x.toFixed(0) : x.toFixed(1)}ms`;
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const r0 = (x: number) => (Number.isFinite(x) ? String(Math.round(x)) : "?");

/**
 * Who was late in a stretch where the screen stood still (run clock, seconds), from the commits and swaps.
 * Returns undefined when the root readings do not cover it.
 */
export function whoWasLate(u: Readings, from: number, to: number, periodMs: number): string | undefined {
  const first = Math.min(u.swaps[0] ?? Infinity, u.commits[0]?.t ?? Infinity), last = Math.max(u.swaps[u.swaps.length - 1] ?? -Infinity, u.commits[u.commits.length - 1]?.t ?? -Infinity);
  if (!(first <= from && last >= to)) return undefined;
  const period = periodMs / 1000, len = to - from;
  // The frame shown at `to` was committed a refresh or two before it: look that far back, and no further ahead.
  const co = u.commits.filter((c) => c.t > from - 3 * period && c.t < to + period);
  const sw = u.swaps.filter((t) => t > from - period && t < to + period);
  let quiet = 0, after: { t: number; ms: number } | undefined;
  for (let i = 1; i < co.length; i++) if (co[i].t - co[i - 1].t > quiet) { quiet = co[i].t - co[i - 1].t; after = co[i]; }
  let gap = sw.length ? 0 : len;
  for (let i = 1; i < sw.length; i++) gap = Math.max(gap, sw[i] - sw[i - 1]);
  if (!u.commits.length) return gap > 1.5 * period ? `the window server was late: no frame went to the display for ${ms(gap * 1000)} (dtrace)` : undefined;
  if (co.length < 2) return `the app was late: it committed ${co.length ? "once" : "nothing"} to Core Animation around these ${ms(len * 1000)} (dtrace)`;
  if (quiet >= 0.7 * len) return `the app was late: it committed nothing to Core Animation for ${ms(quiet * 1000)}${after && after.ms > periodMs ? `, and the commit that ended the silence took ${ms(after.ms)}` : ""} (dtrace)`;
  if (gap > 1.5 * period) return `the window server was late: the app kept committing (${co.length}×, never more than ${ms(quiet * 1000)} apart) but no frame went to the display for ${ms(gap * 1000)} (dtrace)`;
  // Swaps are the whole display's: other windows keep it busy, so they cannot clear the window server for THIS window.
  return `the app kept committing (${co.length}×, never more than ${ms(quiet * 1000)} apart) and the display kept getting frames (dtrace): its commits did not change this region, or the window server did not show them`;
}

/** The root readings told against the motions: commits and swaps while moving, and what moving cost. */
export function underLines(u: Readings, segs: { start_s: number; end_s: number }[], periodMs: number): string[] {
  const L: string[] = [];
  const name = (i: number) => (segs.length > 1 ? `motion ${i + 1}` : "the motion");
  const inSeg = (t: number) => segs.some((s) => t >= s.start_s && t <= s.end_s);
  segs.slice(0, 6).forEach((s, i) => {
    const dur = Math.max(1e-3, s.end_s - s.start_s), parts: string[] = [];
    const co = u.commits.filter((c) => c.t >= s.start_s && c.t <= s.end_s + periodMs / 1000);
    const sw = u.swaps.filter((t) => t >= s.start_s && t <= s.end_s + periodMs / 1000);
    if (u.commits.length || u.swaps.length) {
      const long = co.reduce((m, c) => Math.max(m, c.ms), 0);
      const handed = "the window server ran the motion on its own (a Core Animation animation: no per-frame work in the app)";
      parts.push(!co.length ? `the app committed nothing: ${handed}`
        : co.length / dur < 10 ? `the app committed ${co.length === 1 ? "once" : `${co.length}×`} (longest ${ms(long)} on its main thread), then ${handed}`
        : `the app committed ${co.length}× (${r0(co.length / dur)}/s, longest ${ms(long)} on its main thread): it drives the motion frame by frame`);
    }
    if (u.swaps.length) {
      let gap = 0;
      for (let k = 1; k < sw.length; k++) gap = Math.max(gap, sw[k] - sw[k - 1]);
      const rate = sw.length > 1 ? (sw.length - 1) / (sw[sw.length - 1] - sw[0]) : NaN;
      parts.push(`the display got ${sw.length} frames${sw.length > 1 ? ` (${r0(rate)}/s, longest wait ${ms(gap * 1000)})` : ""}`);
    }
    if (parts.length) L.push(`${name(i)}: ${parts.join(" · ")}`);
  });
  if (u.cost.length && segs.length) {
    const moving = u.cost.filter((c) => inSeg(c.t - c.ms / 2000)), rest = u.cost.filter((c) => !inSeg(c.t) && !inSeg(c.t - c.ms / 1000));
    const tell = (v: Cost[]) => {
      const f = (k: keyof Cost) => mean(v.map((c) => c[k] as number).filter((x) => typeof x === "number"));
      // Apple silicon reports no GPU time per process (the column is always 0), so the GPU is told as power, whole machine.
      const gpu = (k: "app_gpu" | "ws_gpu") => (f(k) > 0 ? `, ${r0(f(k))} ms/s GPU` : "");
      return `app ${r0(f("app_cpu"))} ms/s CPU${gpu("app_gpu")} · window server ${r0(f("ws_cpu"))} ms/s CPU${gpu("ws_gpu")} · whole machine: GPU ${r0(f("gpu_mw"))} mW, CPU ${r0(f("cpu_mw"))} mW`;
    };
    if (moving.length) L.push(`cost while moving: ${tell(moving)}`);
    if (moving.length && rest.length) L.push(`cost at rest:      ${tell(rest)}`);
    if (!moving.length) L.push(`cost: the motion was shorter than one 100ms power sample; at rest: ${rest.length ? tell(rest) : "not sampled"}`);
  }
  return L;
}
