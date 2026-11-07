// One-at-a-time rules: (1) a second the-eye server is refused while the first holds the driver lease;
// (2) a target app running twice is refused, then duplicates:"quit_others" leaves one. Uses Calculator; no input lock.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";

const server = async (name) => {
  const c = new Client({ name, version: "1" });
  await c.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/index.ts", import.meta.url).pathname] }));
  return c;
};
const call = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  return { err: !!r.isError, t: r.content.filter((x) => x.type === "text").map((x) => x.text).join("\n") };
};
let bad = 0;
const expect = (ok, what, r) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `\n${r?.t}`}`); if (!ok) bad++; };
const rect = { x: 0, y: 0, w: 200, h: 100 };

const A = await server("A"), B = await server("B");
const a1 = await call(A, "eye_record", { rect, seconds: 0.5, ax: false });
expect(!a1.err, "A records", a1);
const b1 = await call(B, "eye_record", { rect, seconds: 0.5, ax: false });
expect(b1.err && /BUSY/.test(b1.t), "B is refused while A holds the lease", b1);
const s = await call(B, "eye_status", {});
expect(/driver lease: the-eye server pid/.test(s.t), "B's eye_status names the holder", s);
await A.close();
await new Promise((r) => setTimeout(r, 500));
const b2 = await call(B, "eye_record", { rect, seconds: 0.5, ax: false });
expect(!b2.err, "B records once A is gone", b2);

// Builds of one app count as copies of each other; unrelated apps don't.
const { familyKeys } = await import(new URL("../src/single.ts", import.meta.url).pathname);
const rel = (a, b) => familyKeys(...a).some((k) => familyKeys(...b).includes(k));
expect(rel(["NOOTCH!-Dev", "fi.lo.dev.nootch"], ["NOOTCH!", "lo.fi.NOOTCH"]), "NOOTCH!-Dev and NOOTCH! are one app");
expect(!rel(["NOOTCH! Glass Helper", "lo.fi.NOOTCH.GlassHelper"], ["NOOTCH!", "lo.fi.NOOTCH"]), "the Glass Helper is a different app");
expect(!rel(["Calculator", "com.apple.calculator"], ["Chess", "com.apple.Chess"]), "Calculator and Chess are unrelated");

execSync("osascript -e 'quit app \"Calculator\"' || true; sleep 1");
const l1 = await call(B, "eye_app", { action: "launch", app_path: "/System/Applications/Calculator.app" });
expect(!l1.err && /started Calculator/.test(l1.t), "eye_app launches Calculator", l1);
const l2 = await call(B, "eye_app", { action: "launch", app_path: "/System/Applications/Calculator.app" });
expect(l2.err && /already running/.test(l2.t), "a second launch is refused", l2);
execSync("open -n -a Calculator; sleep 3.5"); // behind the server's back
const st = await call(B, "eye_status", {});
expect(/another copy of Calculator/.test(st.t) && /more than one/.test(st.t), "the server noticed the extra copy by itself", st);
const rec = await call(B, "eye_record", { rect: { x: 0, y: 0, w: 1512, h: 982 }, seconds: 0.5 });
expect(/⚠ Calculator \(on screen in this rect\) runs 2×/.test(rec.t), "a recording flags the duplicated app in its rect", rec);
const d1 = await call(B, "eye_act", { target_process: "Calculator", lock: false, steps: [{ op: "wait", ms: 10 }] });
expect(d1.err && /STOPPED: 2 copies/.test(d1.t) && /relaunch/.test(d1.t), "eye_act stops and offers the choices", d1);
const before = execSync("pgrep -x Calculator").toString().trim().split("\n");
const d2 = await call(B, "eye_act", { target_process: "Calculator", lock: false, duplicates: "relaunch", steps: [{ op: "wait", ms: 10 }] });
const after = execSync("pgrep -x Calculator").toString().trim().split("\n");
expect(!d2.err && after.length === 1 && !before.includes(after[0]) && /relaunched/.test(d2.t), `relaunch leaves one fresh Calculator (${before} → ${after})`, d2);
const q = await call(B, "eye_app", { app: "Calculator", action: "quit" });
const n = Number(execSync("pgrep -x Calculator | wc -l").toString().trim());
expect(!q.err && n === 0, "eye_app quit quits it", q);
await B.close();
console.log(`\n${bad} failures`);
process.exit(bad ? 1 : 0);
