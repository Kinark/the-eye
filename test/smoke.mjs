// Smoke test: speaks MCP over stdio to the server and exercises the non-interactive tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/index.ts", import.meta.url).pathname] }));
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
let errors = 0;
const call = async (name, args = {}, show = 1500) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const t = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (r.isError) errors++;
  console.log(`\n=== ${name} ${JSON.stringify(args).slice(0, 120)}${r.isError ? " (ERROR)" : ""}\n${t.slice(0, show)}`);
  return t;
};
const rect = { x: 356, y: 0, w: 800, h: 300 };
await call("eye_status");
await call("eye_inspect", {}, 1200);
await call("eye_inspect", { rect, max_nodes: 30 }, 2000);
await call("eye_snapshot", { rect });
// A session that only watches while a command runs: it ends by itself with the report.
const rw = await call("eye_drive", { rect, command: "sleep 1.5; echo driven", label: "smoke", keyframe_ms: 500, tree: "none" });
const csv = rw.match(/csv: (.*)/)?.[1];
if (!csv) { errors++; console.log("FAIL: the report names no csv"); }
await call("eye_report", { csv, view: "timeline", bin_ms: 500 }, 600);
await call("eye_report", { csv, view: "hover" }, 600);
await call("eye_snapshot", { csv, t_s: 1 });
await call("eye_report", { runs: [{ csv, label: "a" }, { csv, label: "b" }] }, 800);
// A session that watches until it is ended; eye_status says what it sees meanwhile.
await call("eye_drive", { rect, hands: false, label: "bg", ax: false });
await new Promise((r) => setTimeout(r, 800));
const st = await call("eye_status", {}, 1200);
if (!/live @|still|MOVING/i.test(st)) { errors++; console.log("FAIL: eye_status does not show the open session"); }
const acted = await client.callTool({ name: "eye_drive", arguments: { steps: [{ op: "click", x: 500, y: 100 }] } });
if (!/watch/i.test(acted.content[0].text)) { errors++; console.log(`FAIL: a watch session let a press through: ${acted.content[0].text.slice(0, 200)}`); }
await call("eye_drive", { end: true }, 1200);
const names = tools.tools.map((t) => t.name).sort().join(" ");
if (names !== "eye_drive eye_inspect eye_report eye_snapshot eye_status") { errors++; console.log(`FAIL: the tools are ${names}`); }
await client.close();
console.log(`\n${errors} tool errors`);
process.exit(errors ? 1 : 0);
