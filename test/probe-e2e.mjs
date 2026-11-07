// node test/probe-e2e.mjs '<process>' [seconds] ['<start args json>'] — attach (confirm), record, peek every 0.5s, stop.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [proc = "NOOTCH! AppStore", secs = "3", extra = "{}"] = process.argv.slice(2);
const client = new Client({ name: "probe-e2e", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/index.ts", import.meta.url).pathname] }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  return (r.isError ? "ERROR: " : "") + r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
};
console.log("== attach\n" + await call("eye_probe_attach", { process: proc }));
const started = await call("eye_probe_start", { process: proc, label: "e2e", max_seconds: 30, ...JSON.parse(extra) });
console.log("== start\n" + started);
if (started.startsWith("ERROR")) { await client.close(); process.exit(1); }
console.log("GO");
const end = Date.now() + Number(secs) * 1000;
while (Date.now() < end) {
  await new Promise((r) => setTimeout(r, 500));
  console.log("== peek\n" + await call("eye_probe_peek", { max: 4 }));
}
console.log("== stop\n" + await call("eye_probe_stop", { top: 8 }));
await client.close();
