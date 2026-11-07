// node test/watch.mjs '<eye_record json args>' [peek_every_ms=2000]
// Starts a background run on a fresh server, prints eye_peek every interval, aborts on "ABORT"/"REFUSING".
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = JSON.parse(process.argv[2]);
const every = Number(process.argv[3] ?? 2000);
const client = new Client({ name: "watch", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/index.ts", import.meta.url).pathname] }));
const call = async (name, a) => (await client.callTool({ name, arguments: a }, undefined, { timeout: 700_000 }))
  .content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const start = await call("eye_record", { ...args, background: true });
console.log(start);
const id = start.match(/^(run\d+)/)?.[1];
for (;;) {
  await new Promise((r) => setTimeout(r, every));
  const peek = await call("eye_peek", { id: id, output_lines: 3, window_s: 2 });
  if (/^run\d+ (done|aborted)/.test(peek)) { console.log("\n=== FINAL\n" + peek); break; }
  console.log("\n--- " + peek);
  if (/ABORT|REFUSING/.test(peek)) { console.log("\n=== watcher: driver reported a problem → final:\n" + await call("eye_peek", { id: id })); break; }
}
await client.close();
