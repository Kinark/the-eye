// Interactive-loop test: start capture + lock, then eye_act sequences reading live state.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "act", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/index.ts", import.meta.url).pathname] }));
const call = async (name, a = {}) => {
  const t = (await client.callTool({ name, arguments: a }, undefined, { timeout: 120_000 })).content.map((c) => c.text).join("\n");
  console.log(`\n=== ${name}\n${t}`);
  return t;
};
const cx = 756;
await call("eye_record", { rect: { x: 356, y: 0, w: 800, h: 300 }, label: "act-test" });
await call("eye_lock", { seconds: 40 });
await call("eye_act", { steps: [
  { op: "move", x: cx, y: 12, ms: 300, note: "to notch" },
  { op: "click" },
  { op: "wait_until", expr: "a && a.w > 150 && a.h > 60", timeout_ms: 1500, note: "opened?" },
  { op: "wait", ms: 400 },
  { op: "move", x: cx + 150, y: 50, ms: 400, guard: "a && a.w > 150" },
  { op: "scroll", dy: 6, events: 15, note: "inside → allowed" },
] });
await call("eye_act", { steps: [
  { op: "move", x: cx, y: 600, ms: 300, note: "leave" },
  { op: "scroll", dy: 6, events: 5, note: "outside → must be refused" },
] });
await call("eye_act", { steps: [
  { op: "wait_until", expr: "!a || a.h < 45", timeout_ms: 2000, note: "closed?" },
] });
await call("eye_lock", { release: true });
await call("eye_stop");
await client.close();
