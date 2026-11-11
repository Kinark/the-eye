// One-at-a-time rules.
// 1. Driver lease: several MCP clients (OpenCode sessions) each start their own the-eye server, but there is one
//    screen, one pointer and one keyboard. Tools that drive or own them (eye_act, eye_lock, eye_record, eye_probe)
//    take a lease in a shared file; another live server's call is refused until the lease is released or expires.
//    Read-only tools (status, inspect, snapshot, peek, report, stop) never need it.
// 2. Single app instance: two copies of the app under test (an Xcode run + an `open`, a stale launch) both draw on
//    screen and both answer AX, so presses, probes and measurements hit the wrong one. Targets are checked first.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const DIR = join(homedir(), "Library", "Caches", "the-eye");
const LEASE = join(DIR, "driver.json");
/** How long a lease outlives its last driving call (keeps it between an agent's calls). */
const IDLE_MS = 60_000;

type Lease = { pid: number; cwd: string; tool: string; since: number; expires: number };

const aliveP = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };
function readLease(): Lease | null {
  try { return JSON.parse(readFileSync(LEASE, "utf8")); } catch { return null; }
}
function writeLease(l: Lease) {
  mkdirSync(DIR, { recursive: true });
  const tmp = `${LEASE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(l));
  renameSync(tmp, LEASE);
}
const heldByOther = (l: Lease | null): l is Lease => !!l && l.pid !== process.pid && l.expires > Date.now() && aliveP(l.pid);
const ago = (t: number) => `${Math.round((Date.now() - t) / 1000)}s ago`;
const describe = (l: Lease) => `the-eye server pid ${l.pid} (session in ${l.cwd}), driving since ${ago(l.since)} via ${l.tool}, lease ends in ${Math.max(0, Math.round((l.expires - Date.now()) / 1000))}s unless renewed`;

/** Take or renew the lease. Returns an error message when another live server holds it. */
export function claimDriver(tool: string, retry = true): string | null {
  const cur = readLease();
  if (heldByOther(cur)) {
    return `BUSY: another agent session is driving the screen — ${describe(cur)}. Wait for it to finish (retry later), or ask the user. Read-only tools (eye_inspect, eye_snapshot, eye_status, eye_report) still work.`;
  }
  const own = cur as Lease | null;
  const mine = own && own.pid === process.pid && own.expires > Date.now() ? own : null;
  writeLease({ pid: process.pid, cwd: process.cwd(), tool, since: mine?.since ?? Date.now(), expires: Date.now() + IDLE_MS });
  const check = readLease(); // two servers writing in the same instant: the rename that landed last wins
  if (check?.pid === process.pid) return null;
  return retry ? claimDriver(tool, false) : `could not take the driver lease (${LEASE})`;
}

/** Keep the lease alive while this server still has something running (recording, lock, probe). */
export function startLeaseHeartbeat(busy: () => boolean) {
  const t = setInterval(() => {
    const cur = readLease();
    if (cur?.pid === process.pid && busy()) writeLease({ ...cur, expires: Math.max(cur.expires, Date.now() + 15_000) });
  }, 5000);
  t.unref();
}
export function releaseDriver() {
  try { if (readLease()?.pid === process.pid) unlinkSync(LEASE); } catch {}
}
export function driverStatus(): string {
  const l = readLease();
  if (!l || l.expires <= Date.now() || !aliveP(l.pid)) return "driver lease: free";
  return l.pid === process.pid ? `driver lease: this session (since ${ago(l.since)})` : `driver lease: ${describe(l)}`;
}

// ---- single app instance
//
// An app "family" is every build of the same app: the same executable name, or the same stem once build-variant
// words are dropped (NOOTCH!-Dev / NOOTCH! / "NOOTCH! Beta" → nootch), or the same bundle-id stem
// (fi.lo.dev.nootch / lo.fi.NOOTCH → nootch). Two family members on screen at once (two Xcode runs, a Dev build
// next to the installed release) both draw and both answer AX, so presses, probes and measurements can hit the
// wrong one. The server checks this itself on every driving call, watches watched families for new launches,
// and hands the agent the choices instead of guessing.

type Proc = { pid: number; exe: string; app?: string; name: string; bundleId?: string; elapsed: number; keys: string[] };
const VARIANTS = new Set(["dev", "debug", "development", "beta", "alpha", "release", "setapp", "appstore", "store", "staging",
  "test", "testing", "preview", "canary", "nightly", "local", "prod", "production", "internal"]);
/** [[dd-]hh:]mm:ss → seconds */
function etime(s: string) {
  const [d, rest] = s.includes("-") ? s.split("-") : ["0", s];
  return rest.split(":").map(Number).reduce((a, b) => a * 60 + b, 0) + Number(d) * 86400;
}
const bundleIds = new Map<string, string | undefined>();
function bundleIdOf(app: string) {
  if (!bundleIds.has(app)) {
    const r = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", join(app, "Contents", "Info.plist")], { encoding: "utf8" });
    bundleIds.set(app, r.status === 0 ? r.stdout.trim() : undefined);
  }
  return bundleIds.get(app);
}
export function familyKeys(name: string, bundleId?: string): string[] {
  const keys = new Set<string>();
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const stem = words.filter((w) => !VARIANTS.has(w)).join("");
  if (stem.length >= 3) keys.add(`n:${stem}`);
  if (bundleId) {
    const parts = bundleId.toLowerCase().split(".").filter((w) => w && !VARIANTS.has(w));
    const last = parts[parts.length - 1]?.replace(/[^a-z0-9]/g, "");
    if (last && last.length >= 3 && !["app", "mac", "macos", "osx", "helper"].includes(last)) keys.add(`n:${last}`);
  }
  return [...keys];
}
function apps(): Proc[] {
  const r = spawnSync("/bin/ps", ["-axo", "pid=,etime=,comm="], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").map((l) => l.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: Number(m![1]), elapsed: etime(m![2]), exe: m![3] }))
    .filter((p) => /\.app\/Contents\/MacOS\/[^/]+$/.test(p.exe))
    .map((p) => {
      const app = p.exe.replace(/\/Contents\/MacOS\/[^/]+$/, "");
      const name = basename(p.exe), bundleId = bundleIdOf(app);
      return { ...p, app, name, bundleId, keys: [`x:${name.toLowerCase()}`, ...familyKeys(name, bundleId)] };
    });
}
const related = (a: Proc, b: Proc) => a.keys.some((k) => b.keys.includes(k));
const newest = (l: Proc[]) => [...l].sort((a, b) => a.elapsed - b.elapsed)[0];
const isBuild = (p: Proc) => !!p.app && /\/(DerivedData|Build\/Products)\//.test(p.app) && !/^(\/System|\/Applications|\/Users\/[^/]+\/Applications)\//.test(p.app);
/**
 * An older copy is stale, and safe to quit without asking, when a newer copy of the same thing has started: the same
 * .app relaunched (Xcode Run without stopping the old run, `open -n`), or a newer build product of the family while
 * the older one is a build product too. Copies the user may be using (anything outside build folders, e.g.
 * /Applications) are never stale: those still go through `duplicates`.
 */
const stale = (old: Proc, fresh: Proc) => old.elapsed >= fresh.elapsed && old.pid !== fresh.pid && (old.app === fresh.app || (isBuild(old) && isBuild(fresh)));
/** pid quit as stale → the pid that replaced it, so calls naming the old pid follow the new launch. */
const replaced = new Map<number, number>();
function successor(pid: number): number | undefined {
  let p = pid, seen = 0;
  while (replaced.has(p) && seen++ < 20) p = replaced.get(p)!;
  return p !== pid && aliveP(p) ? p : undefined;
}
/** Quit every stale family member older than `fresh`. Returns a line for the tool output, or "". */
async function retireStale(fresh: Proc, members: Proc[]): Promise<string> {
  const old = members.filter((p) => stale(p, fresh));
  if (!old.length) return "";
  const left = await quit(old.map((p) => p.pid));
  for (const p of old) if (!left.includes(p.pid)) replaced.set(p.pid, fresh.pid);
  const gone = old.filter((p) => !left.includes(p.pid));
  return [
    gone.length ? `quit stale ${gone.map((p) => `${p.name} pid ${p.pid} (started ${fmtAge(p.elapsed)} ago)`).join(", ")}: a newer launch of the same build is running, ${fresh.name} pid ${fresh.pid}, which is the one to test now` : "",
    left.length ? `could NOT quit stale pid ${left.join(", ")}, so two copies are still running` : "",
  ].filter(Boolean).join("; ");
}

function pick(all: Proc[], proc: string | number): Proc | undefined {
  if (typeof proc === "number" || /^\d+$/.test(String(proc))) return all.find((p) => p.pid === Number(proc));
  const want = String(proc).toLowerCase();
  return newest(all.filter((p) => p.name.toLowerCase() === want))
    ?? newest(all.filter((p) => p.name.toLowerCase().includes(want)))
    ?? newest(all.filter((p) => p.app?.toLowerCase().endsWith(`/${want}.app`)))
    ?? newest(all.filter((p) => familyKeys(String(proc)).some((k) => p.keys.includes(k))));
}

export type InstancePolicy = "ask" | "quit_others" | "relaunch" | "allow";
export type InstanceCheck = { ok: boolean; pid?: number; note?: string; error?: string };
const line = (p: Proc, mark = "") => `  pid ${p.pid}  ${p.name}  started ${fmtAge(p.elapsed)} ago  ${p.app}${mark}`;

/** Every running member of `proc`'s family (the target first), or null when nothing matches. */
export function familyOf(proc: string | number): { target: Proc; others: Proc[] } | null {
  const all = apps();
  const target = pick(all, proc);
  if (!target) return null;
  return { target, others: all.filter((p) => p.pid !== target.pid && related(p, target)) };
}

async function quit(pids: number[]) {
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
  for (let i = 0; i < 30 && pids.some(aliveP); i++) await sleep(100);
  for (const pid of pids) if (aliveP(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  await sleep(200);
  return pids.filter(aliveP);
}
/** Launch an .app (never a second copy: `open` reuses a running one) and wait until its process is up. */
export async function launch(app: string, settleMs = 1500): Promise<Proc | string> {
  const exe = basename(app).replace(/\.app$/, "");
  const before = new Set(apps().map((p) => p.pid));
  const r = spawnSync("/usr/bin/open", [app], { encoding: "utf8" });
  if (r.status !== 0) return `open failed: ${(r.stderr || r.stdout).trim()}`;
  for (let i = 0; i < 200; i++) {
    const hit = apps().find((p) => !before.has(p.pid) && (p.app === app || p.name === exe));
    if (hit) { await sleep(settleMs); return hit; }
    await sleep(100);
  }
  return `${app} did not start within 20s`;
}

/**
 * The server's own check before it drives, probes or measures an app. `ask` (default) returns the situation plus
 * the choices; the others act: quit_others keeps the target (the pid you named, else the newest launch) and quits
 * every other family member; relaunch quits the whole family and starts the target's .app fresh (or `app_path`).
 */
export async function checkInstances(proc: string | number, policy: InstancePolicy = "ask", appPath?: string): Promise<InstanceCheck> {
  let redirect = "";
  if (/^\d+$/.test(String(proc)) && !aliveP(Number(proc))) {
    const next = successor(Number(proc));
    if (next) { redirect = `pid ${proc} was a stale copy, quit when pid ${next} launched: using pid ${next}`; proc = next; }
  }
  const r = await checkFamily(proc, policy, appPath);
  return redirect ? { ...r, note: [redirect, r.note].filter(Boolean).join("; ") } : r;
}

async function checkFamily(proc: string | number, policy: InstancePolicy, appPath?: string): Promise<InstanceCheck> {
  const fam = familyOf(proc);
  if (!fam) {
    if (policy === "relaunch" && appPath) {
      const l = await launch(appPath);
      return typeof l === "string" ? { ok: false, error: l } : { ok: true, pid: l.pid, note: `launched ${l.name} pid ${l.pid}` };
    }
    return { ok: true };
  }
  const { target, others } = fam;
  watch(target);
  if (policy === "allow") return { ok: true, pid: target.pid };
  if (policy === "relaunch") {
    const app = appPath ?? target.app!;
    const left = await quit([target.pid, ...others.map((p) => p.pid)]);
    if (left.length) return { ok: false, error: `could not quit pid ${left.join(", ")}` };
    const l = await launch(app);
    if (typeof l === "string") return { ok: false, error: l };
    watch(l);
    return { ok: true, pid: l.pid, note: `relaunched ${l.name}: pid ${l.pid} (quit ${[target, ...others].map((p) => p.pid).join(", ")})` };
  }
  if (!others.length) return { ok: true, pid: target.pid };
  if (policy === "ask") {
    // Stale copies (older launches of the same build) never need a decision: the newest launch wins.
    const all = [target, ...others], fresh = newest(all);
    const note = await retireStale(fresh, all);
    if (note) {
      const left = familyOf(fresh.pid);
      if (left && !left.others.length) return { ok: true, pid: fresh.pid, note: target.pid !== fresh.pid ? `${note}; using pid ${fresh.pid}, not pid ${target.pid}` : note };
      if (left) return { ok: false, error: `${note}\n${conflictText(left.target, left.others)}` };
    }
  }
  if (policy === "quit_others") {
    const left = await quit(others.map((p) => p.pid));
    if (left.length) return { ok: false, error: `could not quit pid ${left.join(", ")}` };
    return { ok: true, pid: target.pid, note: `quit ${others.map((p) => `${p.name} pid ${p.pid}`).join(", ")}; kept pid ${target.pid}` };
  }
  return { ok: false, error: conflictText(target, others) };
}

export function conflictText(target: Proc, others: Proc[]) {
  const n = others.length + 1;
  return [
    `STOPPED: ${n} copies of ${target.name}'s app are running (same app or another build of it). They all draw on screen and answer`,
    `accessibility, so presses, probes and measurements could hit the wrong one:`,
    line(target, "  ← target (the pid you named, else the newest launch)"),
    ...others.map((p) => line(p)),
    `Decide, then call again with one of:`,
    `  duplicates:"quit_others"  keep pid ${target.pid}, quit the other ${others.length}`,
    `  duplicates:"relaunch"     quit all ${n}, start ${target.app} fresh (add app_path to start a different build, e.g. the one you just built)`,
    `  duplicates:"allow"        test with all of them running`,
    `  or stop the test and ask the user (one of these may be the user's own copy). eye_app {app} lists them; eye_app {action:"quit", pid} quits one.`,
  ].join("\n");
}

// ---- watching: new launches of a family while this server is testing it

const watched = new Map<string, { name: string; keys: string[]; pids: Set<number> }>();
const events: { t: number; text: string }[] = [];
let watcher: NodeJS.Timeout | undefined;
export function watch(p: Proc) {
  const key = p.keys[0];
  const w = watched.get(key) ?? { name: p.name, keys: p.keys, pids: new Set<number>() };
  for (const q of apps()) if (q.keys.some((k) => w.keys.includes(k))) w.pids.add(q.pid);
  watched.set(key, w);
  if (!watcher) {
    let busy = false;
    watcher = setInterval(async () => {
      if (busy) return; // a quit in progress takes up to ~3.5s
      busy = true;
      try {
        const now = apps();
        for (const w of watched.values()) {
          const fam = now.filter((q) => q.keys.some((k) => w.keys.includes(k)));
          for (const q of fam) if (!w.pids.has(q.pid)) {
            w.pids.add(q.pid);
            if (fam.length < 2) continue;
            // A newer launch of the same build: the old copy is stale, quit it now instead of leaving two on screen.
            const note = await retireStale(q, fam);
            const left = familyOf(q.pid);
            if (note) events.push({ t: Date.now(), text: note });
            if (left?.others.length) events.push({ t: Date.now(), text: `another copy of ${w.name}'s app launched: ${q.name} pid ${q.pid} (${left.others.length + 1} running now: ${[left.target, ...left.others].map((f) => f.pid).join(", ")})` });
          }
          for (const pid of [...w.pids]) if (!fam.some((q) => q.pid === pid) && !aliveP(pid)) w.pids.delete(pid);
        }
      } finally { busy = false; }
    }, 750);
    watcher.unref();
  }
}
export function watchPid(pid: number) { const f = familyOf(pid); if (f) watch(f.target); }
/** Launch warnings since `since` (ms epoch), for peek/stop/act outputs. */
export function instanceEvents(since: number) { return events.filter((e) => e.t >= since).map((e) => `⚠ ${new Date(e.t).toLocaleTimeString()} ${e.text}`); }
let reported = 0;
/** Launch warnings not shown yet; every tool output appends them, so the agent hears about a new copy right away. */
export function freshEvents(): string[] {
  const out = events.slice(reported).map((e) => `⚠ ${new Date(e.t).toLocaleTimeString()} ${e.text}${e.text.startsWith("another copy of ") ? ` — eye_app {app:"${e.text.split("'s app")[0].replace("another copy of ", "")}"} for the choices` : ""}`);
  reported = events.length;
  return out;
}
export function watchedStatus(): string[] {
  const out: string[] = [];
  const all = apps();
  for (const w of watched.values()) {
    const fam = all.filter((q) => q.keys.some((k) => w.keys.includes(k)));
    out.push(`app ${w.name}: ${fam.length} running${fam.length > 1 ? " ⚠ more than one" : ""}${fam.length ? ` (${fam.map((p) => `${p.name} pid ${p.pid}`).join(", ")})` : ""}`);
  }
  return out;
}
export function listFamily(proc: string | number): string {
  const fam = familyOf(proc);
  if (!fam) return `no running app matches "${proc}"`;
  return [`${fam.others.length + 1} running:`, line(fam.target, "  ← target"), ...fam.others.map((p) => line(p))].join("\n");
}
export async function quitPids(pids: number[]) { return quit(pids); }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmtAge = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`);
export const duplicatesSchemaDescription =
  "What to do when the target app runs more than once, counting other builds of it (Dev/Release…). ask (default): stop and list them with the choices. quit_others: keep the target (pid you named, else newest launch), quit the rest. relaunch: quit them all and start the target's .app fresh (or app_path). allow: go ahead.";
