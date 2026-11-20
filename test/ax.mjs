// AX path: a session that only watches (hover + tree), steps that wait on what is under the pointer (nothing is
// sent, the pointer never moves), eye_status with the tree, end.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "ax", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL("../src/index.ts", import.meta.url).pathname] }));
let errors = 0;
const call = async (name, args = {}, show = 2500) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const t = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (r.isError) errors++;
  console.log(`\n=== ${name}${r.isError ? " (ERROR)" : ""}\n${t.slice(0, show)}`);
  return t;
};
const rect = { x: 0, y: 0, w: 1512, h: 400 };
await call("eye_drive", { rect, hands: false, label: "ax-test", max_seconds: 30 }, 3000);
const w = await call("eye_drive", { steps: [{ op: "wait", ms: 300 }, { op: "assert", expr: "h !== undefined" }, { op: "wait_until", expr: "h && h.role", timeout_ms: 1000 }] });
if (/STOPPED|NOT RUN/.test(w)) { errors++; console.log("FAIL: the waiting steps did not run in a session that only watches"); }
await call("eye_status", { tree: "basic" }, 1500);
await call("eye_drive", { end: true }, 2500);
await client.close();
console.log(`\n${errors} tool errors`);
process.exit(errors ? 1 : 0);
