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
  const mine = cur && cur.pid === process.pid && cur.expires > Date.now() ? cur : null;
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

type Proc = { pid: number; exe: string; elapsed: number };
/** [[dd-]hh:]mm:ss → seconds */
function etime(s: string) {
  const [d, rest] = s.includes("-") ? s.split("-") : ["0", s];
  return rest.split(":").map(Number).reduce((a, b) => a * 60 + b, 0) + Number(d) * 86400;
}
function processes(): Proc[] {
  const r = spawnSync("/bin/ps", ["-axo", "pid=,etime=,comm="], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").map((l) => l.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: Number(m![1]), elapsed: etime(m![2]), exe: m![3] }))
    .filter((p) => p.exe.includes(".app/Contents/MacOS/"));
}

export type DuplicatePolicy = "refuse" | "quit_others" | "allow";

/**
 * Check that the target app (name or pid) runs only once. Copies = same executable name. Returns an error message
 * (refuse), or null after quitting the extras (quit_others: keeps the pid you named, else the newest launch).
 */
export function ensureSingleInstance(proc: string | number, policy: DuplicatePolicy = "refuse"): string | null {
  if (policy === "allow") return null;
  const all = processes();
  let keep: Proc | undefined;
  if (typeof proc === "number" || /^\d+$/.test(String(proc))) keep = all.find((p) => p.pid === Number(proc));
  else {
    const want = String(proc).toLowerCase();
    keep = all.filter((p) => basename(p.exe).toLowerCase() === want).sort((a, b) => a.elapsed - b.elapsed)[0]
      ?? all.filter((p) => basename(p.exe).toLowerCase().includes(want)).sort((a, b) => a.elapsed - b.elapsed)[0];
  }
  if (!keep) return null; // not an app bundle process, or not running: the caller reports that itself
  const name = basename(keep.exe);
  const copies = all.filter((p) => basename(p.exe) === name);
  if (copies.length < 2) return null;
  const others = copies.filter((p) => p.pid !== keep!.pid);
  const list = copies.sort((a, b) => a.elapsed - b.elapsed)
    .map((p) => `  pid ${p.pid}, started ${fmtAge(p.elapsed)} ago, ${p.exe.replace(/\/Contents\/MacOS\/.*$/, "")}${p.pid === keep!.pid ? "  ← newest / named" : ""}`).join("\n");
  if (policy === "refuse") {
    return `${copies.length} copies of ${name} are running — presses, probes and measurements could hit the wrong one:\n${list}\n` +
      `Quit the extras first: pass duplicates:"quit_others" (keeps pid ${keep.pid}), or quit them yourself, or name a pid with duplicates:"allow" if you really want several.`;
  }
  for (const p of others) { try { process.kill(p.pid, "SIGTERM"); } catch {} }
  const until = Date.now() + 3000;
  while (Date.now() < until && others.some((p) => aliveP(p.pid))) spawnSync("/bin/sleep", ["0.1"]);
  for (const p of others) if (aliveP(p.pid)) { try { process.kill(p.pid, "SIGKILL"); } catch {} }
  const left = others.filter((p) => aliveP(p.pid));
  return left.length ? `could not quit ${name} pid ${left.map((p) => p.pid).join(", ")}` : null;
}
const fmtAge = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`);
export const duplicatesSchemaDescription =
  "If the target app runs more than once: refuse (default, lists the copies), quit_others (keep the pid you named, else the newest launch; quit the rest), or allow.";
