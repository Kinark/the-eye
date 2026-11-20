// Regression: session → snapshot → end must always return (stopCapture() once hung forever after a snapshot).
// usage: bun test/stop-hang.mjs [rounds]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpdir } from "node:os";

const rounds = Number(process.argv[2] ?? 5);
const client = new Client({ name: "stop-hang", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL("../src/index.ts", import.meta.url).pathname] }));
const call = async (name, a = {}) => (await client.callTool({ name, arguments: a }, undefined, { timeout: 60_000 })).content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const rect = { x: 356, y: 0, w: 800, h: 300 };
for (let i = 1; i <= rounds; i++) {
  await call("eye_drive", { rect, hands: false, label: `stop-hang-${i}`, max_seconds: 30 });
  await new Promise((r) => setTimeout(r, 800 + 300 * i));
  await call("eye_snapshot", { rect: { x: 506, y: 0, w: 500, h: 130 }, path: `${tmpdir()}/stop-hang.png` });
  const t = Date.now();
  const r = await call("eye_drive", { end: true });
  console.log(`round ${i}: the end took ${Date.now() - t}ms · ${/WARNING[^\n]*/.exec(r)?.[0] ?? (/could not analyze[^\n]*/.exec(r)?.[0] ?? "clean exit")}`);
}
await client.close();
