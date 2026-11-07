// Smoke test: speaks MCP over stdio to the server and exercises the non-interactive tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/index.ts", import.meta.url).pathname] }));
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n=== ${name}${r.isError ? " (ERROR)" : ""}\n${t.slice(0, 1500)}`);
  return t;
};
await call("eye_displays");
await call("eye_snapshot", { rect: { x: 356, y: 0, w: 800, h: 300 } });
const rw = await call("eye_record_while", { rect: { x: 356, y: 0, w: 800, h: 300 }, command: "sleep 1.5; echo driven", label: "smoke", keyframe_ms: 500 });
const csv = rw.match(/csv: (.*)/)?.[1];
await call("eye_timeline", { csv, bin_ms: 500 });
await call("eye_frames", { csv, t_s: 1 });
await call("eye_compare", { runs: [{ csv, label: "a" }, { csv, label: "b" }] });
await call("eye_start", { rect: { x: 356, y: 0, w: 800, h: 300 }, label: "bg" });
await call("eye_status");
await new Promise((r) => setTimeout(r, 1000));
await call("eye_stop");
await client.close();
