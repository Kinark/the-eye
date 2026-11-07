// Regression: eye_inspect {process} must find apps launched after the input actor started, and a killed actor
// must be replaced instead of hanging every later call. Needs a running app named by argv[2] (default NOOTCH).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync, spawnSync } from "node:child_process";

const want = process.argv[2] ?? "NOOTCH";
const client = new Client({ name: "process-tree", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/index.ts", import.meta.url).pathname] }));
let errors = 0;
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
  const t = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (r.isError) errors++;
  return t;
};
const nodes = (t) => Number(/\((?:basic|full), (\d+) nodes/.exec(t)?.[1] ?? -1);
const rect = { x: 406, y: 0, w: 700, h: 320 };
const first = await call("eye_inspect", { rect, process: want });
console.log(`process "${want}": ${nodes(first)} nodes`);
spawnSync("pkill", ["-f", "eye-capture input"]);
const t0 = Date.now();
const after = await call("eye_inspect", { rect, process: want });
console.log(`after killing the actor: ${nodes(after)} nodes in ${Date.now() - t0}ms`);
if (nodes(first) <= 0 || nodes(after) <= 0) errors++;
console.log(`\n${errors} errors`);
await client.close();
