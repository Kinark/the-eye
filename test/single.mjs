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

execSync("open -a Calculator; sleep 1.5; open -n -a Calculator; sleep 2");
const d1 = await call(B, "eye_act", { target_process: "Calculator", lock: false, steps: [{ op: "wait", ms: 10 }] });
expect(d1.err && /2 copies of Calculator/.test(d1.t), "two Calculators are refused", d1);
const d2 = await call(B, "eye_act", { target_process: "Calculator", lock: false, duplicates: "quit_others", steps: [{ op: "wait", ms: 10 }] });
const n = Number(execSync("pgrep -x Calculator | wc -l").toString().trim());
expect(!d2.err && n === 1, `quit_others leaves one Calculator (${n} running)`, d2);
execSync("osascript -e 'quit app \"Calculator\"'");
await B.close();
console.log(`\n${bad} failures`);
process.exit(bad ? 1 : 0);
