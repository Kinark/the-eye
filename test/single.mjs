// One-at-a-time rules: (1) a second the-eye server is not run while the first one's session holds the turn;
// (2) a target app running twice is refused, then duplicates:"quit_others" leaves one. Uses Calculator; no input lock.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const server = async (name, env = {}) => {
  const c = new Client({ name, version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [new URL("../src/index.ts", import.meta.url).pathname], env: { ...process.env, THE_EYE_ASK: "yep", ...env } }));
  return c;
};
const call = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  return { err: !!r.isError, t: r.content.filter((x) => x.type === "text").map((x) => x.text).join("\n") };
};
let bad = 0;
const expect = (ok, what, r) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `\n${r?.t}`}`); if (!ok) bad++; };
const rect = { x: 0, y: 0, w: 200, h: 100 };

const A = await server("A"), B = await server("B", { EYE_QUEUE_WAIT_MS: "1500" });
const a1 = await call(A, "eye_drive", { rect, hands: false, ax: false });
expect(!a1.err, "A opens a session", a1);
const b1 = await call(B, "eye_drive", { rect, seconds: 0.5, ax: false });
expect(b1.err && /QUEUED, not run/.test(b1.t), "B is not run while A's session holds the turn", b1);
const s = await call(B, "eye_status", {});
expect(/driver lease: the-eye server pid/.test(s.t), "B's eye_status names the holder", s);
await A.close();
await new Promise((r) => setTimeout(r, 500));
const b2 = await call(B, "eye_drive", { rect, seconds: 0.5, ax: false });
expect(!b2.err, "B records once A is gone", b2);

// Builds of one app count as copies of each other; unrelated apps don't.
const { familyKeys } = await import(new URL("../src/single.ts", import.meta.url).pathname);
const rel = (a, b) => familyKeys(...a).some((k) => familyKeys(...b).includes(k));
expect(rel(["NOOTCH!-Dev", "fi.lo.dev.nootch"], ["NOOTCH!", "lo.fi.NOOTCH"]), "NOOTCH!-Dev and NOOTCH! are one app");
expect(!rel(["NOOTCH! Glass Helper", "lo.fi.NOOTCH.GlassHelper"], ["NOOTCH!", "lo.fi.NOOTCH"]), "the Glass Helper is a different app");
expect(!rel(["Calculator", "com.apple.calculator"], ["Chess", "com.apple.Chess"]), "Calculator and Chess are unrelated");

execSync("osascript -e 'quit app \"Calculator\"' || true; sleep 1");
const watch = { hands: false, seconds: 0.3, probe: false }; // a session that only watches: no hand, no lock
const l1 = await call(B, "eye_drive", { app_path: "/System/Applications/Calculator.app", ...watch });
expect(!l1.err && /started Calculator/.test(l1.t), "eye_drive {app_path} starts Calculator", l1);
const l2 = await call(B, "eye_drive", { app_path: "/System/Applications/Calculator.app", ...watch });
expect(!l2.err && !/started Calculator/.test(l2.t) && execSync("pgrep -x Calculator | wc -l").toString().trim() === "1", "a second one never makes a second copy", l2);
execSync("open -n -a Calculator; sleep 3.5"); // behind the server's back: the same .app started again
const st0 = await call(B, "eye_status", {});
expect(/quit stale Calculator/.test(st0.t) && execSync("pgrep -x Calculator | wc -l").toString().trim() === "1", "a relaunch of the same .app retires the older launch", st0);
// Another build of it (a copy somewhere else) is not stale: it may be the user's.
const copy = `${mkdtempSync(join(tmpdir(), "eye-single-"))}/Calculator.app`;
execSync(`cp -R /System/Applications/Calculator.app "${copy}" && open -n "${copy}"; sleep 3.5`);
const st = await call(B, "eye_status", {});
expect(/another copy of Calculator/.test(st.t) && /more than one/.test(st.t), "the server noticed the extra copy by itself", st);
execSync(`osascript -e 'tell application "System Events" to set frontmost of every process whose name is "Calculator" to true'; sleep 1`); // whatever the user has in front would cover it
const win = execSync(`osascript -e 'tell application "System Events" to get {position, size} of window 1 of (first process whose name is "Calculator")'`).toString().trim().split(", ").map(Number);
const top = await call(B, "eye_inspect", { x: win[0] + win[2] / 2, y: win[1] + win[3] / 2 });
if (!/Calculator/.test(top.t.split("\n").slice(0, 3).join(" "))) {
  console.log("skip a recording flags the duplicated app in its rect (Calculator is covered by the app in front; macOS refused to raise it)");
} else {
  const rec = await call(B, "eye_drive", { rect: { x: win[0], y: win[1], w: win[2], h: win[3] }, seconds: 0.5 });
  expect(/⚠ Calculator \(on screen in this rect\) runs 2×/.test(rec.t), "a recording flags the duplicated app in its rect", rec);
}
const d1 = await call(B, "eye_drive", { app: "Calculator", ...watch });
expect(d1.err && /STOPPED: 2 copies/.test(d1.t) && /relaunch/.test(d1.t), "eye_drive stops and offers the choices", d1);
const before = execSync("pgrep -x Calculator").toString().trim().split("\n");
const d2 = await call(B, "eye_drive", { app: "Calculator", duplicates: "relaunch", ...watch });
const after = execSync("pgrep -x Calculator").toString().trim().split("\n");
expect(!d2.err && after.length === 1 && !before.includes(after[0]) && /relaunched/.test(d2.t), `relaunch leaves one fresh Calculator (${before} → ${after})`, d2);
const q = await call(B, "eye_drive", { app: "Calculator", quit: true });
const n = Number(execSync("pgrep -x Calculator | wc -l").toString().trim());
expect(!q.err && n === 0, "eye_drive {app, quit:true} quits it", q);
await B.close();
console.log(`\n${bad} failures`);
process.exit(bad ? 1 : 0);
