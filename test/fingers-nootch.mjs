// node test/fingers-nootch.mjs ['<process>'] — two fingers on NOOTCH!'s notch: one touch held across two calls that pulls the
// notch open on a curve, stirs it in circles, wanders and lifts, then a diagonal flick, then the hand playing by itself
// (fingers play), sent somewhere by a stroke, calmed and lifted. Prints what the-eye says;
// asserts nothing. TAKES THE REAL INPUT LOCK (Esc ×6 releases).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [proc = "NOOTCH!-Dev"] = process.argv.slice(2);
const client = new Client({ name: "fingers-nootch", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/index.ts", import.meta.url).pathname], env: process.env }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  return (r.isError ? "ERROR: " : "") + r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
};
const log = (h, s) => console.log(`\n== ${h}\n${s}`);
const d = JSON.parse((await call("eye_status")).split("\n")[0]).displays.find((x) => x.main).points;
const cx = d.w / 2, rect = { x: Math.round(cx - 400), y: 0, w: 800, h: 320 };
try {
  log("pull open on a curve, stir, fingers left down", await call("eye_drive", { app: proc, rect, label: "fingers", coast_ms: 4000,
    wing: `${cx},14 rest 500 walk fingers 6,22 -10,24 14,18 rest 150 fingers orbit 22 2 fingers -30,6 18,-20 34,10` }));
  log("same touch: wander, come back, lift", await call("eye_drive", { wing: "fingers wander 34 2200 fingers orbit 16 -1 rest 200 lift settle" }));
  log("a diagonal flick", await call("eye_drive", { wing: "brisk fingers 20,40 -8,80 flick settle" }));
  log("play, left to itself", await call("eye_drive", { hold_ms: 8000, wing: "fingers play lively rest 6000" }));
  log("play: sent somewhere, wilder", await call("eye_drive", { wing: "fingers -60,30 fingers play wild 90 rest 3000" }));
  log("play: calm, then lift", await call("eye_drive", { wing: "fingers calm rest 400 lift settle" }));
} finally {
  log("end", await call("eye_drive", { end: true }));
  await client.close();
}
