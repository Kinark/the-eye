// node test/call.mjs <tool> '<json args>' — call one the-eye tool over MCP and print its text.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [tool, args = "{}"] = process.argv.slice(2);
const client = new Client({ name: "call", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/index.ts", import.meta.url).pathname] }));
const r = await client.callTool({ name: tool, arguments: JSON.parse(args) }, undefined, { timeout: 700_000 });
console.log(r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"));
await client.close();
